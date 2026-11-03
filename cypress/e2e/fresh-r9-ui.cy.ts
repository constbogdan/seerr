const freshSettings = {
  enabled: true,
  baseUrl: 'http://autobrr.invalid:7474',
  filterId: 7,
  cachedFilterName: 'Fresh Movies & TV',
  mediaEligibilityDays: 90,
  freshVisibilityDays: 7,
  includeGenreIds: [],
  excludeGenreIds: [],
  includeOriginalLanguages: [],
  excludeOriginalLanguages: [],
  includeContentRatings: [],
  excludeContentRatings: [],
  minimumTmdbScore: 0,
  minimumTmdbVotes: 0,
  apiTokenConfigured: true,
};

const candidate = {
  candidateId: 41,
  revision: 2,
  displayTitle: 'A Very Long Candidate Title Used for Narrow Layout Testing',
  parsedTitle: 'A Very Long Candidate Title Used for Narrow Layout Testing',
  parsedMediaType: 'movie',
  mediaType: 'movie',
  matchYear: 2026,
  resolutionStatus: 1,
  displayStatus: 'no_match',
  firstObservedAt: '2026-10-11T10:00:00.000Z',
  lastObservedAt: '2026-10-12T10:00:00.000Z',
  attemptCount: 1,
  automaticReasons: ['resolution_no_match'],
  sourceTitleSamples: ['Long release title that must wrap without overflow'],
  observationCount: 1,
  active: false,
  show: true,
  actionable: true,
  actions: {
    resolve: false,
    resetResolution: false,
    admit: false,
    removeOverride: false,
    dismiss: true,
    show: false,
  },
};

const candidates = {
  pageInfo: { pages: 1, page: 1, results: 1, pageSize: 25 },
  results: [candidate],
  summary: {
    totalCandidates: 1,
    activeFresh: 0,
    noMatch: 1,
    ambiguous: 0,
    temporaryFailure: 0,
    outsideEligibilityWindow: 0,
    eligibilityUnknown: 0,
    excludedContentFilter: 0,
    visibilityExpired: 0,
    needsAttention: 1,
    reviewable: 1,
    historical: 0,
  },
};

const diagnostics = (lastRefresh = '2026-10-12T10:00:00.000Z') => ({
  latestAttempt: null,
  currentProjection: {
    status: 'current',
    refreshing: false,
    lastRefresh,
    checkpoint: '101',
    continuityStatus: 2,
    itemCount: 1,
  },
});

const installFreshMocks = () => {
  cy.intercept('GET', '/api/v1/settings/fresh/candidates*', candidates).as(
    'candidates'
  );
  cy.intercept('GET', '/api/v1/settings/fresh/diagnostics', diagnostics()).as(
    'diagnostics'
  );
  cy.intercept('GET', '/api/v1/genres/movie', []);
  cy.intercept('GET', '/api/v1/genres/tv', []);
  cy.intercept('GET', '/api/v1/languages', []);
  cy.intercept('GET', '/api/v1/certifications/movie', {
    certifications: {},
  });
  cy.intercept('GET', '/api/v1/certifications/tv', {
    certifications: {},
  });
  cy.intercept('POST', '/api/v1/settings/fresh/filters', []);
};

describe('R9 Fresh frontend stabilization', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    installFreshMocks();
  });

  it('preserves a dirty Configuration draft across collapse and revalidation', () => {
    let serverSettings = structuredClone(freshSettings);
    cy.intercept('GET', '/api/v1/settings/fresh', (request) => {
      request.reply(serverSettings);
    }).as('settings');

    cy.visit('/settings/discovery-sources/fresh');
    cy.wait('@settings');
    cy.contains('button', 'Configuration').click();
    cy.get('#freshVisibilityDays').clear().type('12');
    cy.contains('button', 'Configuration').click().click();
    cy.get('#freshVisibilityDays').should('have.value', '12');

    cy.then(() => {
      serverSettings = { ...serverSettings, freshVisibilityDays: 14 };
    });
    cy.intercept(
      { method: 'GET', url: '/api/v1/settings/fresh', times: 1 },
      (request) => request.reply(serverSettings)
    ).as('remoteSettings');
    cy.wait(5001);
    cy.window().then((window) => window.dispatchEvent(new Event('focus')));
    cy.wait('@remoteSettings')
      .its('response.body.freshVisibilityDays')
      .should('equal', 14);
    cy.get('#freshVisibilityDays').should('have.value', '12');
    cy.contains('Fresh settings changed on the server').should('be.visible');
    cy.contains('button', 'Keep my edits').click();
    cy.get('#freshVisibilityDays').should('have.value', '12');
  });

  it('shows an explicit settings failure and retries safely', () => {
    let attempts = 0;
    cy.intercept('GET', '/api/v1/settings/fresh', (request) => {
      attempts += 1;
      request.reply(
        attempts === 1
          ? { statusCode: 503, body: { message: 'Mock failure' } }
          : freshSettings
      );
    }).as('settings');

    cy.visit('/settings/discovery-sources/fresh');
    cy.contains('Fresh settings could not be loaded.').should('be.visible');
    cy.contains('button', 'Retry').click();
    cy.wait('@settings');
    cy.contains('Candidate Diagnostics').should('be.visible');
  });

  it('preserves diagnostics controls and expansion across parent refreshes', () => {
    cy.intercept('GET', '/api/v1/settings/fresh', freshSettings);
    cy.visit('/settings/discovery-sources/fresh');
    cy.get('input[aria-label="Search title"]').type('candidate');
    cy.get('button[aria-label^="Show eligibility details"]').click();
    cy.contains('Parsed title').should('be.visible');

    cy.intercept(
      'GET',
      '/api/v1/settings/fresh/diagnostics',
      diagnostics('2026-10-12T11:00:00.000Z')
    );
    cy.window().then((window) => window.dispatchEvent(new Event('focus')));
    cy.get('input[aria-label="Search title"]').should(
      'have.value',
      'candidate'
    );
    cy.contains('Parsed title').should('be.visible');
  });

  it('names every Fresh select and avoids 390px horizontal overflow', () => {
    cy.viewport(390, 844);
    cy.intercept('GET', '/api/v1/settings/fresh', freshSettings);
    cy.visit('/settings/discovery-sources/fresh');

    for (const label of [
      'Candidate media type',
      'Candidate status',
      'Candidate sort order',
      'Candidate visibility',
      'Reason family',
      'Season evidence',
      'Manual resolution',
      'Admission override',
    ]) {
      cy.get(`[aria-label="${label}"]`).should('exist');
    }
    cy.contains('button', 'Configuration').click();
    for (const label of [
      'autobrr Filter',
      'Include Genres',
      'Exclude Genres',
      'Include Original Languages',
      'Exclude Original Languages',
      'Include Content Ratings',
      'Exclude Content Ratings',
    ]) {
      cy.get(`[aria-label="${label}"]`).should('exist');
    }
    cy.document().then((document) => {
      expect(document.documentElement.scrollWidth).to.be.at.most(
        document.documentElement.clientWidth
      );
    });
  });
});
