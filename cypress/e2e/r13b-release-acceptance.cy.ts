const pageInfo = { pages: 1, page: 1, results: 1, pageSize: 25 };

const removalSettings = {
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
};

const quota = {
  movie: { limit: 0, remaining: 0, days: 0, restricted: false },
  tv: { limit: 0, remaining: 0, days: 0, restricted: false },
};

const collectionPart = (id: number, title: string, requested = false) => ({
  id,
  mediaType: 'movie',
  title,
  originalTitle: title,
  releaseDate: '2026-01-01',
  adult: false,
  video: false,
  popularity: 1,
  voteCount: 1,
  voteAverage: 7,
  genreIds: [],
  overview: '',
  originalLanguage: 'en',
  posterPath: null,
  backdropPath: null,
  ...(requested
    ? {
        mediaInfo: {
          status: 1,
          status4k: 1,
          requests: [{ id, is4k: false, status: 1 }],
        },
      }
    : {}),
});

const collection = (requestedIds: number[] = []) => ({
  id: 77,
  name: 'Mock Saga Collection',
  overview: '',
  posterPath: null,
  backdropPath: null,
  parts: [
    collectionPart(701, 'Mock Saga One', requestedIds.includes(701)),
    collectionPart(702, 'Mock Saga Two', requestedIds.includes(702)),
    collectionPart(703, 'Mock Saga Three', requestedIds.includes(703)),
  ],
});

const libraryResponse = {
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
      canonicalMediaId: 101,
      tmdbId: 101,
      mediaType: 'movie',
      title: 'Mock Collection Movie',
      libraryState: 'current',
      year: 2026,
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
      collection: {
        id: 77,
        name: 'Mock Saga Collection',
        posterPath: null,
        backdropPath: null,
      },
      removalSchedules: [],
      seasonSummaries: [],
    },
  ],
};

const containmentStatus = {
  mode: 'contained',
  startupCatchUpsAllowed: false,
  scheduledExecutionAllowed: false,
  manualSynchronizationAllowed: false,
  manualExecutionPolicy: 'blocked',
  restartRequired: true,
  commissioning: null,
};

describe('R13-B release-browser acceptance', () => {
  it('reports mixed Collection outcomes and retries only the failed title', () => {
    cy.loginAsAdmin();
    cy.viewport(1600, 1000);
    cy.intercept('GET', '/api/v1/settings/removal', removalSettings);
    cy.intercept('GET', '/api/v1/library?*', libraryResponse);
    cy.intercept('GET', '/api/v1/user/*/quota', quota);
    cy.intercept('GET', '/api/v1/settings/radarr', []);
    cy.intercept('GET', '/api/v1/user?*', { pageInfo, results: [] });

    let collectionReads = 0;
    cy.intercept('GET', '/api/v1/collection/77', (request) => {
      collectionReads += 1;
      request.reply(
        collectionReads === 1
          ? collection()
          : collectionReads === 2
            ? collection([701, 702])
            : collection([701, 702, 703])
      );
    }).as('collection');

    const requestCounts = new Map<number, number>();
    cy.intercept('POST', '/api/v1/request', (request) => {
      const mediaId = request.body.mediaId as number;
      const count = (requestCounts.get(mediaId) ?? 0) + 1;
      requestCounts.set(mediaId, count);

      if (mediaId === 702) {
        request.reply({
          statusCode: 409,
          body: { message: 'Already requested' },
        });
      } else if (mediaId === 703 && count === 1) {
        request.reply({
          statusCode: 503,
          body: { message: 'Provider unavailable' },
        });
      } else {
        request.reply({ statusCode: 201, body: { id: mediaId, status: 1 } });
      }
    }).as('collectionRequest');

    cy.visit('/library');
    cy.get('button[aria-label="Request collection"]').click();
    cy.wait('@collection');
    cy.get('[role="dialog"]').within(() => {
      cy.get('button[role="checkbox"][aria-label="Select Movie(s)"]').click();
      cy.contains('button', 'Request 3 Movies').click();
      cy.contains('[role="status"]', 'Request results').within(() => {
        cy.contains('li', 'Mock Saga One').should('contain.text', 'Requested');
        cy.contains('li', 'Mock Saga Two').should(
          'contain.text',
          'Already requested'
        );
        cy.contains('li', 'Mock Saga Three')
          .should('contain.text', 'Failed')
          .and('contain.text', 'Retry available');
      });
      cy.contains('button', 'Request 1 Movie').click();
    });

    cy.wrap(null).should(() => {
      expect(requestCounts.get(701)).to.equal(1);
      expect(requestCounts.get(702)).to.equal(1);
      expect(requestCounts.get(703)).to.equal(2);
    });
  });

  it('presents accepted history status and validates without importing', () => {
    cy.loginAsAdmin();
    cy.intercept(
      'GET',
      '/api/v1/settings/synchronization-containment',
      containmentStatus
    );
    cy.intercept('GET', '/api/v1/settings/history-import', {
      status: {
        state: 'accepted',
        observedRange: {
          startedAt: '2025-01-01T08:00:00.000Z',
          endedAt: '2026-10-04T20:00:00.000Z',
          completeness: 'not-asserted',
        },
        contentHash: 'accepted-history-hash',
      },
    });
    cy.intercept('POST', '/api/v1/settings/history-import/validate', {
      valid: true,
      importable: true,
      disposition: 'first-import',
      schema: 'wholphin-history-v1',
      datasetId: 'october-4-history',
      contentHash: 'validated-history-hash',
      counts: {
        viewers: 2,
        media: 3,
        seasons: 4,
        episodes: 20,
        libraryFacts: 6,
        viewingFacts: 7,
        completionFacts: 8,
        activityFacts: 9,
        untimedEvidenceFacts: 1,
      },
      observedRange: {
        startedAt: '2025-01-01T08:00:00.000Z',
        endedAt: '2026-10-04T20:00:00.000Z',
        completeness: 'not-asserted',
      },
      acceptedObservedRange: null,
      comparison: {
        exactFacts: 0,
        missingFacts: 35,
        correctedFacts: 0,
        omittedFacts: 0,
      },
    }).as('validateHistory');
    cy.intercept('POST', '/api/v1/settings/history-import', (request) => {
      request.reply({
        statusCode: 500,
        body: { message: 'Import must not run' },
      });
    }).as('unexpectedImport');

    cy.visit('/settings/history-import');
    cy.contains('Synchronization mode: Contained').should('be.visible');
    cy.contains('Accepted observed range:').should('be.visible');
    cy.contains('(completeness not asserted)').should('be.visible');
    cy.get('#historyFile').selectFile({
      contents: Cypress.Buffer.from('{}'),
      fileName: 'wholphin-history-v1.json',
      mimeType: 'application/json',
    });
    cy.contains('button', 'Validate').click();
    cy.wait('@validateHistory');
    cy.contains('wholphin-history-v1').should('be.visible');
    cy.contains('Disposition: first import').should('be.visible');
    cy.contains('Observed historical range:').should('be.visible');
    cy.contains('Historical completeness: not asserted').should('be.visible');
    cy.contains('viewers: 2').should('be.visible');
    cy.contains('button', 'Import').should('be.enabled');
    cy.get('@unexpectedImport.all').should('have.length', 0);
  });

  it('shows the exact administrator mobile navigation and full authorized drawer', () => {
    cy.loginAsAdmin();
    cy.viewport(390, 844);
    cy.intercept('GET', '/api/v1/settings/removal', removalSettings);
    cy.intercept('GET', '/api/v1/library?*', {
      ...libraryResponse,
      pageInfo: { ...pageInfo, results: 0 },
      results: [],
    });

    cy.visit('/library');
    cy.get('.padding-bottom-safe')
      .find('a[aria-label], button[aria-label]')
      .then(($items) => {
        expect(
          [...$items].map((item) => item.getAttribute('aria-label'))
        ).to.deep.equal([
          'Library',
          'Watchlist',
          'Discover',
          'Requests',
          'Leaving Soon',
          'More',
        ]);
      });
    cy.get('.padding-bottom-safe a[aria-label="Library"]').should(
      'have.class',
      'text-indigo-500'
    );
    cy.get('.padding-bottom-safe button[aria-label="More"]').click();
    cy.get('#mobile-navigation-drawer')
      .should('be.visible')
      .within(() => {
        cy.get('[data-testid="mobile-menu-library"]').should('exist');
        cy.get('[data-testid="mobile-menu-settings"]').should('exist');
      });
  });

  it('preserves the regular-user mobile navigation and excludes admin routes', () => {
    cy.loginAsUser();
    cy.viewport(390, 844);
    cy.intercept('GET', '/api/v1/request?*', {
      pageInfo: { pages: 1, page: 1, results: 0 },
      results: [],
    });

    cy.visit('/requests');
    cy.get('.padding-bottom-safe')
      .find('a[aria-label], button[aria-label]')
      .then(($items) => {
        expect(
          [...$items].map((item) => item.getAttribute('aria-label'))
        ).to.deep.equal(['Discover', 'Movies', 'Series', 'Requests', 'More']);
      });
    cy.get('.padding-bottom-safe a[aria-label="Requests"]').should(
      'have.class',
      'text-indigo-500'
    );
    cy.get('.padding-bottom-safe button[aria-label="More"]').click();
    cy.get('#mobile-navigation-drawer')
      .should('be.visible')
      .within(() => {
        cy.get('[data-testid="mobile-menu-library"]').should('not.exist');
        cy.get('[data-testid="mobile-menu-settings"]').should('not.exist');
        cy.get('[data-testid="mobile-menu-requests"]').should('exist');
      });
  });
});
