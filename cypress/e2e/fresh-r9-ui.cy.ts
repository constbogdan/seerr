const freshSettings = {
  enabled: true,
  baseUrl: 'http://autobrr.invalid:7474',
  filterId: 7,
  cachedFilterName: 'Fresh Movies & TV',
  freshVisibilityDays: 7,
  excludeGenreIds: [],
  excludeOriginalLanguages: [],
  minimumTmdbScore: 0,
  minimumTmdbVotes: 0,
  apiTokenConfigured: true,
};

describe('Fresh V2 settings', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.intercept('GET', '/api/v1/settings/fresh/status', { status: 'ready' });
    cy.intercept('GET', '/api/v1/genres/movie', [{ id: 28, name: 'Action' }]);
    cy.intercept('GET', '/api/v1/genres/tv', []);
    cy.intercept('GET', '/api/v1/languages', [
      { iso_639_1: 'fr', english_name: 'French', name: 'Français' },
    ]);
  });

  it('preserves a dirty draft across settings revalidation', () => {
    let serverSettings = { ...freshSettings };
    cy.intercept('GET', '/api/v1/settings/fresh', (request) => {
      request.reply(serverSettings);
    }).as('settings');
    cy.visit('/settings/discovery-sources/fresh');
    cy.wait('@settings');
    cy.get('#fresh-visibility').clear().type('12');
    cy.get('#minimumTmdbScore').clear().type('7');
    cy.then(() => {
      serverSettings = { ...serverSettings, freshVisibilityDays: 14 };
    });
    // SWR deduplicates focus revalidation for five seconds.
    cy.wait(5001);
    cy.window().then((window) =>
      window.dispatchEvent(new window.Event('focus'))
    );
    cy.wait('@settings')
      .its('response.body.freshVisibilityDays')
      .should('eq', 14);
    cy.get('#fresh-visibility').should('have.value', '12');
    cy.get('#minimumTmdbScore').should('have.value', '7');
  });

  it('shows a load failure and recovers on a page retry without saving', () => {
    let attempts = 0;
    let saves = 0;
    cy.intercept('GET', '/api/v1/settings/fresh', (request) => {
      request.reply(
        ++attempts === 1
          ? { statusCode: 503, body: { message: 'Fixture unavailable' } }
          : freshSettings
      );
    }).as('settings');
    cy.intercept('PUT', '/api/v1/settings/fresh', (request) => {
      saves++;
      request.reply({ statusCode: 500, body: { message: 'Unexpected save' } });
    });
    cy.visit('/settings/discovery-sources/fresh');
    cy.get('[role="alert"]').should(
      'contain.text',
      'Unable to load Fresh settings.'
    );
    cy.reload();
    cy.get('#fresh-visibility').should('have.value', '7');
    cy.then(() => expect(saves).to.eq(0));
  });

  it('keeps content-filter edits through connection refresh and a failed save retry', () => {
    cy.intercept('GET', '/api/v1/settings/fresh', freshSettings);
    cy.intercept('POST', '/api/v1/settings/fresh/test', { statusCode: 200 });
    cy.intercept('POST', '/api/v1/settings/fresh/filters', [
      { id: 7, name: 'Fresh Movies & TV', enabled: true },
    ]).as('filters');
    let saves = 0;
    cy.intercept('PUT', '/api/v1/settings/fresh', (request) => {
      expect(request.body.excludeGenreIds).to.deep.eq([28]);
      expect(request.body.excludeOriginalLanguages).to.deep.eq(['fr']);
      expect(request.body.minimumTmdbVotes).to.eq(25);
      request.reply(
        ++saves === 1
          ? { statusCode: 503, body: { message: 'Fixture unavailable' } }
          : freshSettings
      );
    }).as('save');
    cy.visit('/settings/discovery-sources/fresh');
    cy.get('#excludeGenreIds').type('Action{enter}');
    cy.get('#excludeOriginalLanguages').type('French{enter}');
    cy.get('#minimumTmdbVotes').clear().type('25');
    cy.contains('button', 'Test Connection & Load Filters').click();
    cy.wait('@filters');
    cy.get('#minimumTmdbVotes').should('have.value', '25');
    cy.contains('button', 'Save Changes').click();
    cy.wait('@save').its('response.statusCode').should('eq', 503);
    cy.get('[role="alert"]').should(
      'contain.text',
      'Unable to complete the action.'
    );
    cy.contains('button', 'Save Changes').click();
    cy.wait('@save').its('response.statusCode').should('eq', 200);
    cy.then(() => expect(saves).to.eq(2));
  });

  it('names current controls and avoids 390px horizontal overflow', () => {
    cy.viewport(390, 844);
    cy.intercept('GET', '/api/v1/settings/fresh', freshSettings);
    cy.visit('/settings/discovery-sources/fresh');
    for (const id of [
      'fresh-hostname',
      'fresh-port',
      'fresh-api-token',
      'fresh-filter',
      'fresh-visibility',
      'minimumTmdbScore',
      'minimumTmdbVotes',
    ]) {
      cy.get(`label[for="${id}"]`).invoke('text').should('not.be.empty');
      cy.get(`#${id}`).should('be.visible');
    }
    for (const label of ['Exclude Genres', 'Exclude Original Languages'])
      cy.get(`input[aria-label="${label}"]`).should('be.visible');
    for (const label of ['Enable Fresh', 'Use SSL'])
      cy.get(`[role="checkbox"][aria-label="${label}"]`).should('be.visible');
    cy.contains('button', 'Test Connection & Load Filters').should(
      'be.visible'
    );
    cy.contains('button', 'Save Changes').should('be.visible');
    cy.document().should((document) => {
      expect(document.documentElement.scrollWidth).to.be.at.most(
        document.documentElement.clientWidth
      );
    });
  });
});
