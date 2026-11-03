const settings = {
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

const preview = (actionableScheduleCount = 2) => ({
  actionableScheduleCount,
  movie: {
    eligibleUnscheduled: 0,
    itemsPerRun: 10,
    oldestCurrentAddedAt: null,
    maximumSelectableMonths: 24,
    candidates: [],
  },
  series: {
    eligibleUnscheduled: 0,
    itemsPerRun: 10,
    oldestCurrentAddedAt: null,
    maximumSelectableMonths: 24,
    candidates: [],
  },
});

const leavingSoonItem = {
  canonicalMediaId: 101,
  tmdbId: 101,
  mediaType: 'movie',
  title: 'Last Page Movie',
  year: 2025,
  posterPath: null,
  schedules: [
    {
      id: 501,
      canonicalMediaId: 101,
      targetType: 'movie',
      seasonNumber: null,
      origin: 'manual',
      status: 'active',
      scheduledAt: '2026-10-01T00:00:00.000Z',
      removeAt: '2026-12-01T00:00:00.000Z',
      revision: 1,
    },
  ],
};

describe('R7 Removal Settings and Leaving Soon state safety', () => {
  beforeEach(() => cy.loginAsAdmin());

  it('preserves a dirty draft and requires remote-change resolution', () => {
    let remote = structuredClone(settings);
    cy.intercept('GET', '/api/v1/settings/removal', (request) => {
      request.reply(remote);
    }).as('settings');
    cy.intercept('POST', '/api/v1/settings/removal/preview', preview());

    cy.visit('/settings/removal');
    cy.wait('@settings');
    cy.get('#removalDelayDays').select('30');
    cy.then(() => {
      remote = { ...remote, removalDelayDays: 90 };
    });
    cy.intercept(
      { method: 'GET', url: '/api/v1/settings/removal', times: 1 },
      (request) => request.reply(remote)
    ).as('remoteSettings');
    cy.wait(5001);
    cy.window().then((window) => window.dispatchEvent(new Event('focus')));
    cy.wait('@remoteSettings')
      .its('response.body.removalDelayDays')
      .should('equal', 90);

    cy.get('#removalDelayDays').should('have.value', '30');
    cy.contains('Removal settings changed on the server').should('be.visible');
    cy.contains('button', 'Save changes').should('be.disabled');
    cy.contains('button', 'Keep my edits').click();
    cy.get('#removalDelayDays').should('have.value', '30');
    cy.contains('button', 'Save changes').should('be.enabled');
  });

  it('prevents duplicate Save and preserves edits made during the request', () => {
    let saveRequests = 0;
    cy.intercept('GET', '/api/v1/settings/removal', settings);
    cy.intercept('POST', '/api/v1/settings/removal/preview', preview());
    cy.intercept('POST', '/api/v1/settings/removal', (request) => {
      saveRequests += 1;
      request.reply({ delay: 500, body: request.body });
    }).as('save');

    cy.visit('/settings/removal');
    cy.get('#removalDelayDays').select('30');
    cy.contains('button', 'Save changes')
      .click()
      .should('be.disabled')
      .then(($button) => ($button[0] as HTMLButtonElement).click());
    cy.get('#removalDelayDays').select('20');
    cy.wait('@save');
    cy.wrap(null).should(() => expect(saveRequests).to.equal(1));
    cy.get('#removalDelayDays').should('have.value', '20');
  });

  it('retains the draft and permits retry after Save fails', () => {
    let saveRequests = 0;
    cy.intercept('GET', '/api/v1/settings/removal', settings);
    cy.intercept('POST', '/api/v1/settings/removal/preview', preview());
    cy.intercept('POST', '/api/v1/settings/removal', (request) => {
      saveRequests += 1;
      if (saveRequests === 1) {
        request.reply({ statusCode: 503, body: { message: 'Mock failure' } });
      } else {
        request.reply(request.body);
      }
    }).as('save');

    cy.visit('/settings/removal');
    cy.get('#removalDelayDays').select('30');
    cy.contains('button', 'Save changes').click();
    cy.wait('@save');
    cy.contains('Unable to save Removal settings.').should('be.visible');
    cy.get('#removalDelayDays').should('have.value', '30');
    cy.contains('button', 'Save changes').should('be.enabled').click();
    cy.wait('@save');
    cy.wrap(null).should(() => expect(saveRequests).to.equal(2));
  });

  it('invalidates a stale preview and offers safe retry after failure', () => {
    let previewRequests = 0;
    cy.intercept('GET', '/api/v1/settings/removal', settings);
    cy.intercept('POST', '/api/v1/settings/removal/preview', (request) => {
      previewRequests += 1;
      if (previewRequests === 2) {
        request.reply({ statusCode: 503, body: { message: 'Mock failure' } });
      } else {
        request.reply(preview(previewRequests === 1 ? 2 : 4));
      }
    }).as('preview');

    cy.visit('/settings/removal');
    cy.wait('@preview');
    cy.contains('button', 'Clear 2 items').should('be.enabled');
    cy.get('#removalDelayDays').select('30');
    cy.contains('button', 'Clear 2 items').should('not.exist');
    cy.wait('@preview');
    cy.contains('Unable to calculate the eligibility preview.').should(
      'be.visible'
    );
    cy.contains('button', /^Clear /).should('be.disabled');
    cy.contains('button', 'Retry preview').click();
    cy.wait('@preview');
    cy.contains('button', 'Clear 4 items').should('be.enabled');
  });

  it('ignores an older preview response that arrives after the current one', () => {
    cy.intercept('GET', '/api/v1/settings/removal', settings);
    cy.intercept('POST', '/api/v1/settings/removal/preview', (request) => {
      const delay = request.body.removalDelayDays;
      request.reply({
        delay: delay === 30 ? 700 : 50,
        body: preview(delay === 30 ? 3 : delay === 20 ? 4 : 2),
      });
    }).as('preview');

    cy.visit('/settings/removal');
    cy.wait('@preview');
    cy.get('#removalDelayDays').select('30');
    cy.wait(450);
    cy.get('#removalDelayDays').select('20');
    cy.wait('@preview');
    cy.contains('button', 'Clear 4 items').should('be.enabled');
    cy.wait('@preview');
    cy.contains('button', 'Clear 4 items').should('be.enabled');
    cy.contains('button', 'Clear 3 items').should('not.exist');
  });

  it('moves from an invalid last page only after successful cancellation', () => {
    let cancelled = false;
    cy.intercept('GET', '/api/v1/leaving-soon?page=2', (request) => {
      request.reply(
        cancelled
          ? {
              pageInfo: { pages: 1, page: 2, results: 20, pageSize: 20 },
              results: [],
            }
          : {
              pageInfo: { pages: 2, page: 2, results: 21, pageSize: 20 },
              results: [leavingSoonItem],
            }
      );
    }).as('pageTwo');
    cy.intercept('GET', '/api/v1/leaving-soon?page=1', {
      pageInfo: { pages: 1, page: 1, results: 20, pageSize: 20 },
      results: [],
    }).as('pageOne');
    cy.intercept(
      'DELETE',
      '/api/v1/library/removal-schedules/501',
      (request) => {
        cancelled = true;
        request.reply({ statusCode: 204 });
      }
    ).as('cancel');

    cy.visit('/leaving-soon?page=2');
    cy.wait('@pageTwo');
    cy.get('button[aria-label="Cancel scheduled removal"]')
      .focus()
      .should('be.visible')
      .click();
    cy.contains('button', 'Cancel schedule').click();
    cy.wait('@cancel');
    cy.wait('@pageTwo');
    cy.wait('@pageOne');
    cy.location('search').should('equal', '?page=1');
  });

  it('keeps the current page and error state when cancellation fails', () => {
    cy.viewport(390, 844);
    cy.intercept('GET', '/api/v1/leaving-soon?page=2', {
      pageInfo: { pages: 2, page: 2, results: 21, pageSize: 20 },
      results: [leavingSoonItem],
    });
    cy.intercept('DELETE', '/api/v1/library/removal-schedules/501', {
      statusCode: 409,
      body: { message: 'Mock cancellation conflict.' },
    });

    cy.visit('/leaving-soon?page=2');
    cy.get('button[aria-label="Cancel scheduled removal"]')
      .focus()
      .should('be.visible')
      .click();
    cy.contains('button', 'Cancel schedule').click();
    cy.contains('Mock cancellation conflict.').should('be.visible');
    cy.location('search').should('equal', '?page=2');
    cy.get('[role="dialog"]').should('be.visible');
  });
});
