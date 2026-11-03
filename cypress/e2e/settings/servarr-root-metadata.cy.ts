const radarrSettings = {
  id: 1,
  name: 'Radarr Test',
  hostname: 'radarr.test',
  port: 7878,
  apiKey: 'radarr-key',
  useSsl: false,
  baseUrl: '',
  activeProfileId: 1,
  activeProfileName: 'HD',
  activeDirectory: '/volume1/media-movies',
  is4k: false,
  minimumAvailability: 'released',
  isDefault: true,
  syncEnabled: false,
  downloadQueueSize: 10,
  preventSearch: false,
  tagRequests: false,
  tags: [],
};

const sonarrSettings = {
  id: 2,
  name: 'Sonarr Test',
  hostname: 'sonarr.test',
  port: 8989,
  apiKey: 'sonarr-key',
  useSsl: false,
  baseUrl: '',
  activeProfileId: 1,
  activeProfileName: 'HD',
  activeDirectory: '/volume3/media-shows',
  seriesType: 'standard',
  animeSeriesType: 'anime',
  is4k: false,
  enableSeasonFolders: true,
  monitorNewItems: 'all',
  isDefault: true,
  syncEnabled: false,
  downloadQueueSize: 10,
  preventSearch: false,
  tagRequests: false,
  tags: [],
  animeTags: [],
};

const radarrTestResponse = {
  profiles: [{ id: 1, name: 'HD' }],
  rootFolders: [
    {
      id: 10,
      path: '/volume1/media-movies',
      displayName: null,
      isAnimation: false,
      color: null,
    },
    {
      id: 11,
      path: '/volume4/media-animation-movies',
      displayName: 'Animation Movies',
      isAnimation: true,
      color: '#60a5fa',
    },
  ],
  tags: [],
};

const sonarrTestResponse = {
  profiles: [{ id: 1, name: 'HD' }],
  rootFolders: [
    {
      id: 20,
      path: '/volume3/media-shows',
      displayName: 'Shows',
      isAnimation: false,
      color: null,
    },
    {
      id: 21,
      path: '/volume4/media-animation-shows',
      displayName: 'Animation Shows',
      isAnimation: true,
      color: '#22d3ee',
    },
  ],
  tags: [],
  languageProfiles: null,
};

const login = () =>
  cy.session('servarr-root-metadata-admin', () => {
    cy.request('POST', '/api/v1/auth/local', {
      email: Cypress.env('ADMIN_EMAIL'),
      password: Cypress.env('ADMIN_PASSWORD'),
    })
      .its('status')
      .should('equal', 200);
  });

const interceptServices = () => {
  cy.intercept('GET', '/api/v1/settings/radarr', [radarrSettings]);
  cy.intercept('GET', '/api/v1/settings/sonarr', [sonarrSettings]);
  cy.intercept('GET', '/api/v1/overrideRule*', {
    pageInfo: { pages: 0, pageSize: 20, results: 0, page: 1 },
    results: [],
  });
  cy.intercept('POST', '/api/v1/settings/radarr/test', radarrTestResponse).as(
    'testRadarr'
  );
  cy.intercept('POST', '/api/v1/settings/sonarr/test', sonarrTestResponse).as(
    'testSonarr'
  );
};

const editService = (name: string) => {
  cy.contains('h3', name)
    .parents('li')
    .within(() => cy.contains('button', 'Edit').click());
};

describe('Servarr root-folder metadata', () => {
  beforeEach(() => {
    login();
    interceptServices();
  });

  it('saves optional Radarr colors while preserving per-root metadata', () => {
    let saved = false;
    cy.intercept('PUT', '/api/v1/settings/radarr/1', (request) => {
      expect(request.body.rootFolderNames).to.deep.equal([
        {
          sourceRootId: 10,
          path: '/volume1/media-movies',
          displayName: 'Movies Internal',
          isAnimation: true,
          color: '#facc15',
        },
        {
          sourceRootId: 11,
          path: '/volume4/media-animation-movies',
          displayName: 'Animation Movies',
          isAnimation: true,
          color: null,
        },
      ]);
      saved = true;
      request.reply(request.body);
    }).as('saveRadarr');

    cy.visit('/settings/services');
    editService('Radarr Test');
    cy.wait('@testRadarr');

    cy.get('#root-folder-name-10').clear().type('Movies Internal');
    cy.get('button[aria-label="Animation"]').eq(0).click();
    cy.get('button[aria-label="Storage color"]').eq(0).click();
    cy.get('button[aria-label="Storage color #facc15"]').click();
    cy.get('button[aria-label="Storage color"]').eq(1).click();
    cy.get('button[aria-label="Use default color"]').click();
    cy.contains('button', 'Save').click();
    cy.wait('@saveRadarr').then(() => expect(saved).to.equal(true));
  });

  it('saves Sonarr roots with no selected color', () => {
    cy.intercept('PUT', '/api/v1/settings/sonarr/2', (request) => {
      expect(request.body.seriesType).to.equal('standard');
      expect(request.body.animeSeriesType).to.equal('anime');
      expect(request.body.rootFolderNames[0]).to.deep.equal({
        sourceRootId: 20,
        path: '/volume3/media-shows',
        displayName: 'Shows',
        isAnimation: false,
        color: null,
      });
      request.reply(request.body);
    }).as('saveSonarr');

    cy.visit('/settings/services');
    editService('Sonarr Test');
    cy.wait('@testSonarr');
    cy.contains('button', 'Save').click();
    cy.wait('@saveSonarr');
  });

  it('saves a new Sonarr service with untouched Series Type defaults', () => {
    cy.intercept('POST', '/api/v1/settings/sonarr', (request) => {
      expect(request.body.seriesType).to.equal('standard');
      expect(request.body.animeSeriesType).to.equal('anime');
      expect(request.body.rootFolderNames).to.deep.equal(
        sonarrTestResponse.rootFolders.map((folder) => ({
          sourceRootId: folder.id,
          path: folder.path,
          displayName: folder.displayName,
          isAnimation: folder.isAnimation,
          color: folder.color,
        }))
      );
      request.reply({ ...request.body, id: 3 });
    }).as('createSonarr');

    cy.visit('/settings/services');
    cy.contains('button', 'Add Sonarr Server').click();
    cy.get('#name').type('New Sonarr');
    cy.get('#hostname').type('new-sonarr.test');
    cy.get('#apiKey').type('new-sonarr-key');
    cy.get('#seriesType').should('have.value', 'standard');
    cy.get('#animeSeriesType').should('have.value', 'anime');
    cy.contains('[role="dialog"] button', 'Test').click();
    cy.wait('@testSonarr');
    cy.get('#activeProfileId').select('1');
    cy.get('#rootFolder').select('/volume3/media-shows');
    cy.contains('[role="dialog"] button', 'Add Server').click();
    cy.wait('@createSonarr');
  });

  it('serializes explicit values and restores them when the form reopens', () => {
    let persisted = {
      ...sonarrSettings,
      seriesType: 'daily',
      animeSeriesType: 'standard',
    };
    cy.intercept('GET', '/api/v1/settings/sonarr', (request) => {
      request.reply([persisted]);
    }).as('sonarrSettings');
    cy.intercept('PUT', '/api/v1/settings/sonarr/2', (request) => {
      expect(request.body.seriesType).to.equal('standard');
      expect(request.body.animeSeriesType).to.equal('anime');
      expect(request.body.rootFolderNames).to.deep.equal(
        sonarrTestResponse.rootFolders.map((folder) => ({
          sourceRootId: folder.id,
          path: folder.path,
          displayName: folder.displayName,
          isAnimation: folder.isAnimation,
          color: folder.color,
        }))
      );
      persisted = { ...persisted, ...request.body };
      request.reply(persisted);
    }).as('saveSonarrTypes');

    cy.visit('/settings/services');
    cy.wait('@sonarrSettings');
    editService('Sonarr Test');
    cy.wait('@testSonarr');
    cy.get('#seriesType').should('have.value', 'daily').select('standard');
    cy.get('#animeSeriesType').should('have.value', 'standard').select('anime');
    cy.contains('button', 'Save').click();
    cy.wait('@saveSonarrTypes');
    cy.wait('@sonarrSettings');
    editService('Sonarr Test');
    cy.wait('@testSonarr');
    cy.get('#seriesType').should('have.value', 'standard');
    cy.get('#animeSeriesType').should('have.value', 'anime');
  });

  it('keeps paths readable and the editor within a narrow viewport', () => {
    cy.viewport(390, 844);
    cy.visit('/settings/services');
    editService('Radarr Test');
    cy.wait('@testRadarr');

    cy.contains('/volume4/media-animation-movies').should('be.visible');
    cy.get('[role="dialog"]').should(($dialog) => {
      expect($dialog[0].scrollWidth).to.be.at.most($dialog[0].clientWidth);
    });
    cy.get('#root-folder-name-10').should(($input) => {
      expect($input[0].getBoundingClientRect().width).to.be.greaterThan(200);
    });
    cy.get('button[aria-label="Animation"]').should('have.length', 2);
    cy.get('button[aria-label="Storage color"]').should('have.length', 2);
  });
});
