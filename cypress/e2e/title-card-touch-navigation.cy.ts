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
  cy.then(() => {
    const rect = element[0].getBoundingClientRect();
    // The AUT window's frameElement can be null across Cypress's frame realms.
    // Use the runner's actual AUT frame and map CSS pixels through its scaling.
    const frame = (
      Cypress as typeof Cypress & {
        state(key: '$autIframe'): JQuery<HTMLIFrameElement>;
      }
    ).state('$autIframe')[0];
    expect(frame, 'Cypress AUT iframe').not.to.equal(undefined);
    const frameRect = frame.getBoundingClientRect();
    const point = {
      x:
        frameRect.left +
        (rect.left + rect.width / 2) * (frameRect.width / frame.clientWidth),
      y:
        frameRect.top +
        (rect.top + rect.height / 2) * (frameRect.height / frame.clientHeight),
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
        if (!(event.target instanceof window.Element)) return;
        const anchor = event.target.closest('a');
        if (!(anchor instanceof window.HTMLAnchorElement)) return;
        if (!anchor.closest('[data-testid="title-card"]')) return;

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
  afterEach(() =>
    Cypress.automation('remote:debugger:protocol', {
      command: 'Emulation.setTouchEmulationEnabled',
      params: { enabled: false },
    })
  );
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
