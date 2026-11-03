type RecordedCardEvent = {
  defaultPrevented: boolean;
  pointerType?: string;
  type: string;
};

const movie = {
  adult: false,
  backdropPath: null,
  genreIds: [],
  id: 12345,
  mediaType: 'movie',
  originalLanguage: 'en',
  originalTitle: 'Touch Navigation Test',
  overview: 'A deterministic TitleCard browser fixture.',
  popularity: 1,
  posterPath: null,
  releaseDate: '2026-10-20',
  title: 'Touch Navigation Test',
  video: false,
  voteAverage: 8,
  voteCount: 1,
};

const enableChromiumTouchEmulation = (): Cypress.Chainable<unknown> =>
  cy.then(() =>
    Cypress.automation('remote:debugger:protocol', {
      command: 'Emulation.setTouchEmulationEnabled',
      params: { enabled: true, maxTouchPoints: 1 },
    })
  );

const touchElement = (
  element: JQuery<HTMLElement>
): Cypress.Chainable<unknown> =>
  cy.window().then((window) => {
    const rect = element[0].getBoundingClientRect();
    const frameRect = window.frameElement?.getBoundingClientRect();
    const point = {
      x: (frameRect?.left ?? 0) + rect.left + rect.width / 2,
      y: (frameRect?.top ?? 0) + rect.top + rect.height / 2,
    };

    return Cypress.automation('remote:debugger:protocol', {
      command: 'Input.dispatchTouchEvent',
      params: {
        type: 'touchStart',
        touchPoints: [{ ...point, id: 0, radiusX: 1, radiusY: 1 }],
      },
    }).then(() =>
      Cypress.automation('remote:debugger:protocol', {
        command: 'Input.dispatchTouchEvent',
        params: { type: 'touchEnd', touchPoints: [] },
      })
    );
  });

const installEventRecorder = (): void => {
  cy.window().then((window) => {
    const events: RecordedCardEvent[] = [];
    Object.assign(window, { __titleCardEvents: events });

    for (const type of [
      'pointerdown',
      'touchstart',
      'focusin',
      'pointerup',
      'touchend',
      'click',
    ]) {
      window.addEventListener(type, (event) => {
        if (!(event.target instanceof HTMLAnchorElement)) return;
        if (!event.target.closest('[data-testid="title-card"]')) return;

        events.push({
          type,
          defaultPrevented: event.defaultPrevented,
          pointerType:
            event instanceof window.PointerEvent
              ? event.pointerType
              : undefined,
        });
      });
    }
  });
};

const visitFixture = (): void => {
  cy.intercept('GET', '/api/v1/discover/trending*', {
    page: 1,
    totalPages: 1,
    totalResults: 1,
    results: [movie],
  }).as('trending');
  cy.visit('/discover/trending');
  cy.wait('@trending');
  cy.get('[data-testid="title-card"]').should('have.length', 1);
};

describe('TitleCard touch navigation', () => {
  beforeEach(() => {
    cy.viewport(390, 844);
    enableChromiumTouchEmulation();
    cy.loginAsAdmin();
    visitFixture();
  });

  it('consumes the first Android Chrome compatibility click and navigates on the second tap', () => {
    installEventRecorder();
    cy.location('pathname').should('eq', '/discover/trending');

    cy.get('[data-testid="title-card"] a[aria-label]')
      .first()
      .then(touchElement);

    cy.location('pathname').should('eq', '/discover/trending');
    cy.get('[data-testid="title-card-title"]').should(
      'contain.text',
      movie.title
    );
    cy.window()
      .its('__titleCardEvents')
      .should((events: unknown) => {
        const recorded = events as RecordedCardEvent[];
        expect(recorded.map((event) => event.type)).to.include.members([
          'pointerdown',
          'touchstart',
          'click',
        ]);
        expect(
          recorded.some(
            (event) => event.type === 'click' && event.defaultPrevented
          )
        ).to.equal(true);
      });

    cy.get('[data-testid="title-card"] a[aria-label]')
      .first()
      .then(touchElement);
    cy.location('pathname').should('eq', `/movie/${movie.id}`);
  });

  it('keeps overlay actions independent of the card navigation link', () => {
    cy.get('[data-testid="title-card"] a[aria-label]')
      .first()
      .then(touchElement);
    cy.location('pathname').should('eq', '/discover/trending');

    cy.get('[data-testid="title-card-request-region"] button').click();
    cy.location('pathname').should('eq', '/discover/trending');
    cy.get('[role="dialog"]').should('exist');
  });
});
