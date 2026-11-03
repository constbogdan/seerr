const pageInfo = { pages: 1, page: 1, results: 2, pageSize: 25 };

const baseItem = {
  libraryState: 'current',
  year: 2024,
  posterPath: null,
  backdropPath: null,
  addedAt: '2026-01-01T00:00:00.000Z',
  removedAt: null,
  removalSource: null,
  logicalSizeBytes: '1000',
  resolution: 1080,
  watchlistUsers: [],
  watchedUsers: [],
  watchedUserCount: 0,
  hasWatchedDetail: false,
  lastActiveAt: null,
  lastActiveUsers: [],
  requesters: [],
  storageRoots: [],
  fresh: false,
  externalLinks: [],
  tmdbRating: null,
  collection: null,
  removalSchedules: [],
};

const libraryResponse = (movieScheduled = false) => ({
  pageInfo,
  storageLocations: [],
  sourceStatus: {
    library: 'current',
    currentViewing: 'current',
    historicalViewing: 'current',
    historicalImport: {
      state: 'not-imported',
      observedRange: null,
      contentHash: null,
    },
  },
  results: [
    {
      ...baseItem,
      canonicalMediaId: 101,
      tmdbId: 101,
      mediaType: 'movie',
      title: 'Mock Movie',
      seasonSummaries: [],
      removalSchedules: movieScheduled
        ? [
            {
              id: 501,
              canonicalMediaId: 101,
              targetType: 'movie',
              seasonNumber: null,
              origin: 'manual',
              status: 'active',
              scheduledAt: '2026-10-12T00:00:00.000Z',
              removeAt: '2026-12-12T00:00:00.000Z',
              revision: 1,
            },
          ]
        : [],
    },
    {
      ...baseItem,
      canonicalMediaId: 202,
      tmdbId: 202,
      mediaType: 'series',
      title: 'Mock Series',
      seasonSummaries: [
        {
          key: 'season-2',
          seasonNumber: 2,
          isSpecial: false,
          state: 'known_missing',
          availableEpisodeCount: 0,
          knownEpisodeCount: 8,
          resolution: null,
          requestable: true,
        },
      ],
    },
  ],
});

const quota = {
  movie: { limit: 0, remaining: 0, days: 0, restricted: false },
  tv: { limit: 0, remaining: 0, days: 0, restricted: false },
};

const tvDetails = {
  id: 202,
  name: 'Mock Series',
  backdropPath: null,
  externalIds: { tvdbId: 2202 },
  keywords: [],
  mediaInfo: null,
  seasons: [
    {
      id: 2002,
      name: 'Season 2',
      seasonNumber: 2,
      episodeCount: 8,
    },
  ],
};

const interceptLibrary = () => {
  cy.intercept('GET', '/api/v1/settings/removal', {
    removalDelayDays: 60,
    removalScanEnabled: false,
    removalProcessingEnabled: false,
    movie: {
      enabled: false,
      minimumAgeMonths: 3,
      inactivityMonths: 1,
      itemsPerRun: 10,
    },
    series: {
      enabled: false,
      minimumAgeMonths: 3,
      inactivityMonths: 1,
      itemsPerRun: 10,
    },
  });
};

const visitLibraryAfterAuthenticationHydrates = () => {
  cy.request('/api/v1/auth/me').then(({ body: adminUser }) => {
    expect(adminUser.email).to.equal(Cypress.env('ADMIN_EMAIL'));
    cy.intercept('GET', '/api/v1/auth/me', adminUser).as('authenticatedUser');
  });
  cy.visit('/');
  cy.wait('@authenticatedUser');
  cy.get('a[href="/library"]').first().click({ force: true });
  cy.wait('@library');
  cy.location('pathname').should('equal', '/library');
};

describe('R6 Library and shared modal behavior', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    interceptLibrary();
  });

  it('submits an individual target once while leaving unrelated actions available', () => {
    let movieScheduled = false;
    let scheduleRequests = 0;
    cy.intercept('GET', '/api/v1/library?*', (request) => {
      request.reply(libraryResponse(movieScheduled));
    }).as('library');
    cy.intercept('POST', '/api/v1/library/101/removal-schedules', (request) => {
      scheduleRequests += 1;
      movieScheduled = true;
      request.reply({ delay: 400, statusCode: 201, body: { id: 501 } });
    }).as('scheduleMovie');

    visitLibraryAfterAuthenticationHydrates();
    cy.get('button[aria-label="Schedule removal"]').first().click();
    cy.get('button[aria-label="Schedule removal"]')
      .first()
      .should('be.disabled')
      .then(($button) => ($button[0] as HTMLButtonElement).click());
    cy.get('[data-testid="library-library-row-202"]')
      .find('button[aria-label="Schedule removal"]')
      .should('not.be.disabled');
    cy.wait('@scheduleMovie');
    cy.wrap(null).should(() => expect(scheduleRequests).to.equal(1));
  });

  it('surfaces an individual-action conflict and re-enables the target', () => {
    let scheduleRequests = 0;
    cy.intercept('GET', '/api/v1/library?*', libraryResponse()).as('library');
    cy.intercept('POST', '/api/v1/library/101/removal-schedules', (request) => {
      scheduleRequests += 1;
      request.reply({
        statusCode: 409,
        body: {
          message: 'Removal ownership is uncertain. Reconcile before retrying.',
        },
      });
    }).as('scheduleConflict');

    visitLibraryAfterAuthenticationHydrates();
    cy.get('button[aria-label="Schedule removal"]').first().click();
    cy.wait('@scheduleConflict');
    cy.contains(
      'Removal ownership is uncertain. Reconcile before retrying.'
    ).should('be.visible');
    cy.get('button[aria-label="Schedule removal"]')
      .first()
      .should('not.be.disabled');
    cy.wrap(null).should(() => expect(scheduleRequests).to.equal(1));
  });

  it('shows a retryable TV load error and restores focus on Escape', () => {
    cy.viewport(390, 844);
    cy.intercept('GET', '/api/v1/library?*', libraryResponse()).as('library');
    cy.intercept('GET', '/api/v1/tv/202', {
      statusCode: 503,
      body: { message: 'Mock provider unavailable.' },
    });
    cy.intercept('GET', '/api/v1/user/*/quota', quota);

    visitLibraryAfterAuthenticationHydrates();
    cy.get('button[aria-label="Request Season 2"]').click();
    cy.get('[role="dialog"]').within(() => {
      cy.contains(
        'Unable to load authoritative availability and request information.'
      ).should('be.visible');
      cy.contains('button', 'Retry').should('be.enabled');
      cy.contains('Already Requested').should('not.exist');
    });
    cy.get('[role="dialog"]').then(($dialog) => {
      const labelledBy = $dialog.attr('aria-labelledby');
      const describedBy = $dialog.attr('aria-describedby');
      expect(labelledBy).to.be.a('string').and.not.equal(describedBy);
      if (!labelledBy) {
        throw new Error('Dialog accessible label relationship is missing.');
      }
      cy.get(`#${labelledBy}`).should('exist');
      if (describedBy) cy.get(`#${describedBy}`).should('exist');
    });
    cy.get('body').type('{esc}');
    cy.get('[role="dialog"]').should('not.exist');
    cy.focused().should('have.attr', 'aria-label', 'Request Season 2');
  });

  it('uses native Space and Enter semantics for a filtered Season toggle', () => {
    cy.viewport(1280, 800);
    cy.intercept('GET', '/api/v1/library?*', libraryResponse()).as('library');
    cy.intercept('GET', '/api/v1/tv/202', tvDetails);
    cy.intercept('GET', '/api/v1/user/*/quota', quota);
    cy.intercept('GET', '/api/v1/settings/sonarr', []);
    cy.intercept('GET', '/api/v1/user?*', { pageInfo, results: [] });

    visitLibraryAfterAuthenticationHydrates();
    cy.get('button[aria-label="Request Season 2"]').click();
    cy.get('[role="dialog"]').within(() => {
      cy.get('button[role="checkbox"][aria-label="Season 2"]')
        .should('have.attr', 'aria-checked', 'true')
        .focus()
        .type(' ')
        .should('have.attr', 'aria-checked', 'false')
        .type('{enter}')
        .should('have.attr', 'aria-checked', 'true');
      cy.contains('Season 1').should('not.exist');
    });
  });
});
