const storageResponse = {
  settings: {
    enabled: false,
    freeSpaceThreshold: 10,
    automaticSeriesPlacement: false,
    defaultSeriesVolumeId: null,
    expansionSeriesVolumeId: null,
    seriesSeasonThreshold: 3,
    torrentRelocationDelayHours: 48,
    routes: [],
  },
  refreshedAt: '2026-10-16T10:00:00.000Z',
  instances: [
    {
      provider: 'radarr',
      serviceId: 1,
      serviceName: 'Movies',
      available: true,
      capacityAvailable: true,
    },
    {
      provider: 'sonarr',
      serviceId: 2,
      serviceName: 'Shows',
      available: true,
      capacityAvailable: true,
    },
  ],
  locations: [
    {
      id: 'radarr:1:root:10',
      provider: 'radarr',
      serviceId: 1,
      serviceName: 'Movies',
      rootFolderId: 10,
      name: 'Movies Internal',
      path: '/volume1/media-movies',
      color: '#60a5fa',
      isAnimation: false,
      diskSpacePath: '/volume1',
      totalSpace: 1000,
      usedSpace: 600,
      freeSpace: 400,
      usedPercentage: 60,
      accessible: true,
      routable: true,
    },
    {
      id: 'radarr:1:root:11',
      provider: 'radarr',
      serviceId: 1,
      serviceName: 'Movies',
      rootFolderId: 11,
      name: 'Movies External',
      path: '/volume4/media-movies',
      color: '#4ade80',
      isAnimation: false,
      diskSpacePath: '/volume4',
      totalSpace: 2000,
      usedSpace: 500,
      freeSpace: 1500,
      usedPercentage: 25,
      accessible: true,
      routable: true,
    },
    {
      id: 'sonarr:2:root:20',
      provider: 'sonarr',
      serviceId: 2,
      serviceName: 'Shows',
      rootFolderId: 20,
      name: 'Shows Internal',
      path: '/volume3/media-shows',
      color: '#22d3ee',
      isAnimation: false,
      diskSpacePath: null,
      totalSpace: null,
      usedSpace: null,
      freeSpace: null,
      usedPercentage: null,
      accessible: false,
      routable: true,
    },
    {
      id: 'sonarr:2:root:21',
      provider: 'sonarr',
      serviceId: 2,
      serviceName: 'Shows',
      rootFolderId: 21,
      name: 'Shows External',
      path: '/volume4/media-shows',
      color: '#2dd4bf',
      isAnimation: false,
      diskSpacePath: '/volume4',
      totalSpace: 2000,
      usedSpace: 500,
      freeSpace: 1500,
      usedPercentage: 25,
      accessible: true,
      routable: true,
    },
    {
      id: 'radarr:1:root:12',
      provider: 'radarr',
      serviceId: 1,
      serviceName: 'Movies',
      rootFolderId: 12,
      name: 'Animation',
      path: '/volume4/media-animation',
      color: '#facc15',
      isAnimation: true,
      diskSpacePath: '/volume4',
      totalSpace: 2000,
      usedSpace: 500,
      freeSpace: 1500,
      usedPercentage: 25,
      accessible: true,
      routable: true,
    },
    {
      id: 'sonarr:2:root:22',
      provider: 'sonarr',
      serviceId: 2,
      serviceName: 'Shows',
      rootFolderId: 22,
      name: 'Animation',
      path: '/volume4/media-animation',
      color: '#fb923c',
      isAnimation: true,
      diskSpacePath: '/volume4',
      totalSpace: 2000,
      usedSpace: 500,
      freeSpace: 1500,
      usedPercentage: 25,
      accessible: true,
      routable: true,
    },
  ],
  volumes: [
    {
      id: 'physical:volume1',
      name: 'Volume 1',
      volumeKey: 'volume1',
      locationIds: ['radarr:1:root:10'],
      segments: [
        {
          id: 'radarr:1:root:10',
          locationId: 'radarr:1:root:10',
          provider: 'radarr',
          serviceId: 1,
          serviceName: 'Movies',
          rootFolderId: 10,
          label: 'Movies Internal',
          path: '/volume1/media-movies',
          color: '#60a5fa',
          indexedUsageBytes: '100',
          percentage: 10,
          pendingRemovalBytes: '0',
          pendingRemovalPercentage: 0,
        },
      ],
      totalSpace: 1000,
      usedSpace: 600,
      freeSpace: 400,
      usedPercentage: 60,
      knownLibraryUsageBytes: '100',
      pendingRemovalBytes: '0',
      pendingRemovalPercentage: 0,
      pendingRemovalAvailable: true,
      pendingRemovalComplete: true,
      omittedRemovalScheduleCount: 0,
      unaccountedUsageBytes: '500',
      provisionedSpaceBytes: null,
      usageExceedsPhysical: false,
      capacityReadingsDiffer: false,
      accessible: true,
    },
    {
      id: 'physical:volume3',
      name: 'Volume 3',
      volumeKey: 'volume3',
      locationIds: ['sonarr:2:root:20'],
      segments: [
        {
          id: 'sonarr:2:root:20',
          locationId: 'sonarr:2:root:20',
          provider: 'sonarr',
          serviceId: 2,
          serviceName: 'Shows',
          rootFolderId: 20,
          label: 'Shows Internal',
          path: '/volume3/media-shows',
          color: '#22d3ee',
          indexedUsageBytes: '50',
          percentage: null,
          pendingRemovalBytes: null,
          pendingRemovalPercentage: null,
        },
      ],
      totalSpace: null,
      usedSpace: null,
      freeSpace: null,
      usedPercentage: null,
      knownLibraryUsageBytes: '50',
      pendingRemovalBytes: null,
      pendingRemovalPercentage: null,
      pendingRemovalAvailable: false,
      pendingRemovalComplete: false,
      omittedRemovalScheduleCount: 0,
      unaccountedUsageBytes: null,
      provisionedSpaceBytes: null,
      usageExceedsPhysical: false,
      capacityReadingsDiffer: false,
      accessible: false,
    },
    {
      id: 'physical:volume4',
      name: 'Volume 4',
      volumeKey: 'volume4',
      locationIds: [
        'radarr:1:root:11',
        'radarr:1:root:12',
        'sonarr:2:root:21',
        'sonarr:2:root:22',
      ],
      segments: [
        {
          id: 'radarr:1:root:11',
          locationId: 'radarr:1:root:11',
          provider: 'radarr',
          serviceId: 1,
          serviceName: 'Movies',
          rootFolderId: 11,
          label: 'Movies External',
          path: '/volume4/media-movies',
          color: '#4ade80',
          indexedUsageBytes: '100',
          percentage: 5,
          pendingRemovalBytes: '20',
          pendingRemovalPercentage: 20,
        },
        {
          id: 'radarr:1:root:12',
          locationId: 'radarr:1:root:12',
          provider: 'radarr',
          serviceId: 1,
          serviceName: 'Movies',
          rootFolderId: 12,
          label: 'Animation',
          path: '/volume4/media-animation',
          color: '#facc15',
          indexedUsageBytes: '50',
          percentage: 2.5,
          pendingRemovalBytes: '0',
          pendingRemovalPercentage: 0,
        },
        {
          id: 'sonarr:2:root:21',
          locationId: 'sonarr:2:root:21',
          provider: 'sonarr',
          serviceId: 2,
          serviceName: 'Shows',
          rootFolderId: 21,
          label: 'Shows External',
          path: '/volume4/media-shows',
          color: '#2dd4bf',
          indexedUsageBytes: '100',
          percentage: 5,
          pendingRemovalBytes: '25',
          pendingRemovalPercentage: 25,
        },
        {
          id: 'sonarr:2:root:22',
          locationId: 'sonarr:2:root:22',
          provider: 'sonarr',
          serviceId: 2,
          serviceName: 'Shows',
          rootFolderId: 22,
          label: 'Animation',
          path: '/volume4/media-animation',
          color: '#fb923c',
          indexedUsageBytes: '50',
          percentage: 2.5,
          pendingRemovalBytes: '0',
          pendingRemovalPercentage: 0,
        },
      ],
      totalSpace: 2000,
      usedSpace: 500,
      freeSpace: 1500,
      usedPercentage: 25,
      knownLibraryUsageBytes: '300',
      pendingRemovalBytes: '45',
      pendingRemovalPercentage: 15,
      pendingRemovalAvailable: true,
      pendingRemovalComplete: true,
      omittedRemovalScheduleCount: 0,
      unaccountedUsageBytes: '200',
      provisionedSpaceBytes: null,
      usageExceedsPhysical: false,
      capacityReadingsDiffer: false,
      accessible: true,
    },
  ],
};

const enabledStorageRoute = {
  sourceVolumeId: 'physical:volume1',
  destinationVolumeId: 'physical:volume4',
  thresholdGb: 50,
  enabled: true,
};

const login = (email: string, password: string) =>
  cy.session([email, password], () => {
    cy.request('POST', '/api/v1/auth/local', { email, password })
      .its('status')
      .should('equal', 200);
  });

describe('Storage settings configuration skeleton', () => {
  let seriesRelocationEnabled = false;

  beforeEach(() => {
    seriesRelocationEnabled = false;
    cy.intercept('GET', '/api/v1/settings/jobs', (request) => {
      request.reply([
        {
          id: 'series-relocation',
          name: 'Series Relocation',
          type: 'process',
          interval: 'days',
          cronSchedule: '0 0 2 * * *',
          nextExecutionTime: seriesRelocationEnabled
            ? '2026-10-19T02:00:00.000Z'
            : null,
          running: false,
          enabled: seriesRelocationEnabled,
          configurableEnabled: true,
          lastResult: null,
          scheduledExecutionAllowed: seriesRelocationEnabled,
          manualExecutionAllowed: seriesRelocationEnabled,
        },
      ]);
    }).as('storageJobs');
    cy.intercept(
      'POST',
      '/api/v1/settings/jobs/series-relocation/enabled',
      (request) => {
        expect(request.body).to.deep.equal({
          enabled: !seriesRelocationEnabled,
        });
        seriesRelocationEnabled = request.body.enabled;
        request.reply({
          id: 'series-relocation',
          enabled: seriesRelocationEnabled,
          configurableEnabled: true,
          scheduledExecutionAllowed: seriesRelocationEnabled,
          manualExecutionAllowed: seriesRelocationEnabled,
        });
      }
    ).as('setSeriesRelocationEnabled');
    login(Cypress.env('ADMIN_EMAIL'), Cypress.env('ADMIN_PASSWORD'));
  });

  it('renders fresh capacity facts and persists only compatible routes', () => {
    cy.intercept('GET', '/api/v1/settings/storage', storageResponse).as(
      'storage'
    );
    cy.intercept('POST', '/api/v1/settings/storage', (request) => {
      expect(request.body).to.deep.equal({
        enabled: true,
        freeSpaceThreshold: 10,
        automaticSeriesPlacement: false,
        defaultSeriesVolumeId: null,
        expansionSeriesVolumeId: null,
        seriesSeasonThreshold: 3,
        torrentRelocationDelayHours: 48,
        routes: [
          {
            sourceVolumeId: 'physical:volume1',
            destinationVolumeId: 'physical:volume4',
            thresholdGb: 50,
            enabled: true,
          },
        ],
      });
      request.reply(request.body);
    }).as('saveStorage');

    cy.visit('/settings/storage');
    cy.wait('@storage');
    cy.wait('@storageJobs');

    cy.contains('h1', 'Storage').should('not.exist');
    cy.contains('Storage capacity and Overflow configuration.').should(
      'not.exist'
    );
    cy.get('[data-testid="storage-physical-volumes-section"]').within(() => {
      cy.contains('h2', 'Physical volumes').should('be.visible');
      cy.get('#overflow-free-space-threshold')
        .should('have.value', '10')
        .find('option')
        .then(($options) => {
          expect([...$options].map((option) => option.value)).to.deep.equal([
            '5',
            '10',
            '15',
            '20',
          ]);
        });
      cy.findByRole('button', { name: 'Refresh capacity' })
        .should('be.visible')
        .and('not.contain.text', 'Refresh capacity')
        .focus();
    });
    cy.findByRole('tooltip')
      .should('be.visible')
      .and('contain', 'Refresh capacity');
    cy.get('[data-testid="storage-overflow-routing-section"]').within(() => {
      cy.contains('h2', 'Storage Routing').should('be.visible');
      cy.findByRole('checkbox', { name: 'Overflow Routing' }).should(
        'not.exist'
      );
      cy.contains(
        'Choose where media should be stored based on remaining volume capacity.'
      ).should('be.visible');
      cy.contains('h3', 'Routes').should('not.exist');
      cy.findByLabelText('Target volume').should('be.disabled');
      cy.contains('No Overflow routes are configured.').should('not.exist');
      cy.get('#overflow-source').then(($source) => {
        const sourceLabel = Cypress.$('label[for="overflow-source"]')[0];
        const destinationLabel = Cypress.$(
          'label[for="overflow-destination"]'
        )[0];
        const destination = Cypress.$('#overflow-destination')[0];
        const thresholdLabel = Cypress.$(
          'label[for="overflow-route-threshold"]'
        )[0];
        const threshold = Cypress.$('#overflow-route-threshold')[0];
        const sourceGap =
          $source[0].getBoundingClientRect().top -
          sourceLabel.getBoundingClientRect().bottom;
        const destinationGap =
          destination.getBoundingClientRect().top -
          destinationLabel.getBoundingClientRect().bottom;
        const thresholdGap =
          threshold.getBoundingClientRect().top -
          thresholdLabel.getBoundingClientRect().bottom;
        expect(destinationGap).to.be.closeTo(sourceGap, 1);
        expect(thresholdGap).to.be.closeTo(sourceGap, 1);
      });
    });
    cy.get('[data-testid="storage-series-routing-section"]').within(() => {
      cy.contains('h2', 'Series Routing').should('be.visible');
      cy.contains(
        'Choose where new Series are stored and when existing Series should be relocated.'
      ).should('be.visible');
      cy.findByRole('checkbox').should('not.exist');
      cy.findByLabelText('Default volume').should('be.visible');
      cy.findByLabelText('Expansion volume').should('be.visible');
      cy.findByLabelText('Season threshold')
        .should('be.visible')
        .and('have.value', '3');
      cy.findByLabelText('Relocation delay (h)')
        .should('be.visible')
        .and('have.value', '48');
    });
    cy.get('[data-testid="storage-automation-section"]').within(() => {
      cy.contains('h2', 'Automation').should('be.visible');
      cy.contains(
        'Applies configured volume routes when source capacity reaches its threshold.'
      ).should('be.visible');
      cy.contains(
        'Places new Series using the configured Series Routing preferences.'
      ).should('be.visible');
      cy.contains(
        'Allows the scheduled job to relocate eligible existing Series.'
      ).should('be.visible');
      cy.findAllByRole('checkbox').should('have.length', 3);
      cy.findByRole('checkbox', { name: 'Automatic Series Placement' })
        .should('have.attr', 'aria-checked', 'false')
        .click()
        .should('have.attr', 'aria-checked', 'true')
        .click()
        .should('have.attr', 'aria-checked', 'false');
      cy.findByRole('checkbox', { name: 'Series Relocation' })
        .should('have.attr', 'aria-checked', 'false')
        .and('have.attr', 'aria-disabled', 'false');
    });
    cy.findByRole('checkbox', { name: 'Overflow Routing' }).should(
      'have.attr',
      'aria-checked',
      'false'
    );
    cy.contains('Movies Internal').should('be.visible');
    cy.contains('Movies External').should('be.visible');
    cy.contains('Shows Internal').should('be.visible');
    cy.contains('Shows External').should('be.visible');
    cy.contains('Capacity unavailable').should('be.visible');
    cy.get('[data-testid="storage-volume-volume4"]').within(() => {
      cy.contains('Volume 4').should('be.visible');
      cy.get('[data-testid="storage-capacity-total-volume4"]')
        .should('be.visible')
        .and('not.contain', 'Unknown');
      cy.get('[data-testid="storage-capacity-occupied-volume4"]')
        .should('be.visible')
        .and('contain', '25.0%')
        .and('not.contain', 'Unknown');
      cy.contains('dt', 'Used').should('be.visible');
      cy.contains('dt', 'Occupied').should('not.exist');
      cy.get('[data-testid="storage-capacity-free-volume4"]')
        .should('be.visible')
        .and('contain', '75.0%')
        .and('have.css', 'color', 'rgb(119, 173, 140)');
      cy.get('[data-testid="storage-free-space-segment-volume4"]').should(
        'have.css',
        'background-color',
        'rgb(119, 173, 140)'
      );
      cy.get('[data-testid^="storage-segment-legend-"]').should(
        'have.length',
        4
      );
      cy.get('[data-testid^="storage-segment-legend-"]')
        .filter(':contains("Animation")')
        .should('have.length', 2);
      cy.get('[data-testid^="storage-segment-legend-"]')
        .should('not.contain', '(Radarr)')
        .and('not.contain', '(Sonarr)');
      cy.get('[data-testid^="storage-leaving-soon-segment-"]').should(
        'have.length',
        2
      );
      cy.get(
        '[data-testid="storage-leaving-soon-segment-radarr:1:root:11"]'
      ).then(($leavingSoon) => {
        const leavingSoonWidth = $leavingSoon[0].getBoundingClientRect().width;
        const barWidth =
          $leavingSoon[0].parentElement?.getBoundingClientRect().width;
        const retained = $leavingSoon.prev(
          '[data-testid="storage-segment-radarr:1:root:11"]'
        );
        expect(barWidth).to.be.greaterThan(0);
        expect(leavingSoonWidth).to.be.closeTo((barWidth ?? 0) * 0.01, 1);
        expect(retained[0].getBoundingClientRect().width).to.be.closeTo(
          (barWidth ?? 0) * 0.04,
          1
        );
        expect($leavingSoon).to.have.css('background-color', 'rgb(17, 24, 39)');
        expect($leavingSoon.css('background-image')).to.contain(
          'rgb(234, 179, 8)'
        );
      });
      cy.get('[data-testid="storage-leaving-soon-legend-physical:volume4"]')
        .should('be.visible')
        .and('contain', 'Leaving Soon')
        .and('contain', '45 Bytes')
        .and('contain', '15.0%')
        .and('not.contain', 'of occupied');
      cy.contains('Root folder details').should('not.exist');
      cy.contains('Movies').should('be.visible');
      cy.contains('Shows').should('be.visible');
      cy.contains('Provisioned').should('not.exist');
      cy.contains('Other').should('be.visible');
      cy.contains('Pending Removal').should('not.exist');
      cy.contains('Other / unaccounted').should('not.exist');
      cy.get('[data-testid^="storage-free-space-level-"]').should('not.exist');
    });
    cy.get('[data-testid^="storage-volume-bar-"] [title]').should('not.exist');
    cy.findByRole('button', { name: /Other/ }).should('not.exist');

    cy.get('[data-testid="storage-volume-volume3"]').within(() => {
      cy.get('[data-testid="storage-capacity-total-volume3"]').should(
        'contain',
        'Unknown'
      );
      cy.get('[data-testid="storage-capacity-occupied-volume3"]').should(
        'contain',
        'Unknown'
      );
      cy.get('[data-testid="storage-capacity-free-volume3"]').should(
        'contain',
        'Unknown'
      );
      cy.get('[data-testid="storage-capacity-free-volume3"]').should(
        'have.css',
        'color',
        'rgb(107, 114, 128)'
      );
    });

    cy.findByRole('checkbox', { name: 'Overflow Routing' })
      .focus()
      .type('{enter}')
      .should('have.attr', 'aria-checked', 'true');
    cy.findByRole('checkbox', {
      name: 'Automatic Series Placement',
    }).should('have.attr', 'aria-checked', 'false');
    cy.get('#overflow-source').select('physical:volume1');
    cy.get('#overflow-source option:selected').should('contain', 'Volume 1');
    cy.get('#overflow-destination')
      .find('option')
      .should('have.length', 3)
      .and('contain', 'Volume 4');
    cy.get('#overflow-destination').select('physical:volume4');
    cy.get('#overflow-destination option:selected').should(
      'contain',
      'Volume 4'
    );
    cy.contains('button', 'Add route').click();
    cy.contains('button', 'Save changes').click();
    cy.wait('@saveStorage');
  });

  it('requires an enabled route only when Overflow Routing is enabled', () => {
    let persistedSettings = { ...storageResponse.settings };
    cy.intercept('GET', '/api/v1/settings/storage', (request) => {
      request.reply({ ...storageResponse, settings: persistedSettings });
    }).as('storage');
    cy.intercept('POST', '/api/v1/settings/storage', (request) => {
      expect(request.body.enabled).to.equal(false);
      expect(request.body.routes).to.deep.equal([]);
      persistedSettings = request.body;
      request.reply(persistedSettings);
    }).as('saveDisabledOverflow');

    cy.visit('/settings/storage');
    cy.wait('@storage');
    cy.wait('@storageJobs');

    cy.findByRole('checkbox', { name: 'Overflow Routing' }).click();
    cy.contains(
      'Configure at least one enabled storage route before enabling Overflow Routing.'
    ).should('be.visible');
    cy.contains('button', 'Save changes').should('be.disabled');

    cy.findByRole('checkbox', { name: 'Overflow Routing' }).click();
    cy.contains(
      'Configure at least one enabled storage route before enabling Overflow Routing.'
    ).should('not.exist');
    cy.get('#overflow-free-space-threshold').select('15');
    cy.contains('button', 'Save changes').should('be.enabled').click();
    cy.wait('@saveDisabledOverflow');

    cy.reload();
    cy.wait('@storage');
    cy.wait('@storageJobs');
    cy.get('#overflow-free-space-threshold').should('have.value', '15');
    cy.findByRole('checkbox', { name: 'Overflow Routing' }).should(
      'have.attr',
      'aria-checked',
      'false'
    );
  });

  it('rejects Overflow Routing when every configured route is disabled', () => {
    cy.intercept('GET', '/api/v1/settings/storage', {
      ...storageResponse,
      settings: {
        ...storageResponse.settings,
        routes: [{ ...enabledStorageRoute, enabled: false }],
      },
    }).as('storage');

    cy.visit('/settings/storage');
    cy.wait('@storage');
    cy.wait('@storageJobs');

    cy.findByRole('checkbox', { name: 'Overflow Routing' }).click();
    cy.contains(
      'Configure at least one enabled storage route before enabling Overflow Routing.'
    ).should('be.visible');
    cy.contains('button', 'Save changes').should('be.disabled');
  });

  it('previews the next Series Relocation candidate without requiring relocation to be enabled', () => {
    let preview:
      | {
          status: 'eligible';
          candidate: {
            canonicalMediaId: number;
            title: string;
            year: number;
            retainedSeasonCount: number;
            totalBytes: string;
            sonarrUrl: string | null;
          };
          reason: null;
        }
      | { status: 'none'; candidate: null; reason: null }
      | {
          status: 'unavailable';
          candidate: null;
          reason: 'provider-unavailable';
        } = {
      status: 'eligible',
      candidate: {
        canonicalMediaId: 42,
        title: 'The Expanse',
        year: 2015,
        retainedSeasonCount: 4,
        totalBytes: String(100 * 1024 ** 3),
        sonarrUrl: 'https://sonarr.example.test/series/the-expanse',
      },
      reason: null,
    };
    cy.intercept('GET', '/api/v1/settings/storage', {
      ...storageResponse,
      settings: {
        ...storageResponse.settings,
        defaultSeriesVolumeId: 'physical:volume3',
        expansionSeriesVolumeId: 'physical:volume4',
      },
    }).as('storage');
    cy.intercept(
      'GET',
      '/api/v1/settings/storage/series-relocation/next-candidate',
      (request) => request.reply({ delay: 150, body: preview })
    ).as('seriesRelocationPreview');

    cy.visit('/settings/storage');
    cy.wait('@storage');
    cy.wait('@storageJobs');
    cy.findByRole('checkbox', { name: 'Series Relocation' }).should(
      'have.attr',
      'aria-checked',
      'false'
    );
    cy.contains('Refresh to evaluate the next eligible Series.').should(
      'be.visible'
    );

    cy.get('[data-testid="series-relocation-next-candidate"]').within(() => {
      cy.contains('button', 'Refresh').click().should('be.disabled');
      cy.contains('Evaluating the next eligible Series…').should('be.visible');
    });
    cy.wait('@seriesRelocationPreview');
    cy.contains('a', 'The Expanse (2015)')
      .should('be.visible')
      .and(
        'have.attr',
        'href',
        'https://sonarr.example.test/series/the-expanse'
      )
      .and('have.attr', 'target', '_blank')
      .and('have.attr', 'rel', 'noopener noreferrer');
    cy.contains('4 Seasons · 100 GB').should('be.visible');

    preview = {
      status: 'eligible',
      candidate: {
        canonicalMediaId: 42,
        title: 'The Expanse',
        year: 2015,
        retainedSeasonCount: 4,
        totalBytes: String(100 * 1024 ** 3),
        sonarrUrl: null,
      },
      reason: null,
    };
    cy.get('[data-testid="series-relocation-next-candidate"]')
      .contains('button', 'Refresh')
      .click();
    cy.wait('@seriesRelocationPreview');
    cy.get('[data-testid="series-relocation-next-candidate"]')
      .contains('The Expanse (2015)')
      .should('not.match', 'a');

    preview = { status: 'none', candidate: null, reason: null };
    cy.get('[data-testid="series-relocation-next-candidate"]')
      .contains('button', 'Refresh')
      .click();
    cy.wait('@seriesRelocationPreview');
    cy.contains('No Series is currently eligible for relocation.').should(
      'be.visible'
    );

    preview = {
      status: 'unavailable',
      candidate: null,
      reason: 'provider-unavailable',
    };
    cy.get('[data-testid="series-relocation-next-candidate"]')
      .contains('button', 'Refresh')
      .click();
    cy.wait('@seriesRelocationPreview');
    cy.contains('The next candidate is currently unavailable.').should(
      'be.visible'
    );

    cy.findByLabelText('Season threshold').clear().type('4');
    cy.contains(
      'Save the Series Routing changes before refreshing the next candidate.'
    ).should('be.visible');
    cy.get('[data-testid="series-relocation-next-candidate"]')
      .contains('button', 'Refresh')
      .should('be.disabled');
  });

  it('persists the relocation job gate and reflects it on Jobs & Cache without a second toggle', () => {
    cy.intercept('GET', '/api/v1/settings/storage', {
      ...storageResponse,
      settings: {
        ...storageResponse.settings,
        defaultSeriesVolumeId: 'physical:volume3',
        expansionSeriesVolumeId: 'physical:volume4',
      },
    }).as('storage');

    cy.visit('/settings/jobs');
    cy.wait('@storageJobs');
    cy.contains('tr', 'Series Relocation').within(() => {
      cy.contains('Disabled').should('be.visible');
      cy.findByRole('checkbox', { name: /Series Relocation/ }).should(
        'not.exist'
      );
      cy.contains('button', 'Edit').should('be.enabled');
      cy.contains('button', 'Run Now').should('be.disabled');
    });

    cy.visit('/settings/storage');
    cy.wait('@storage');
    cy.findByRole('checkbox', { name: 'Series Relocation' })
      .click()
      .should('have.attr', 'aria-checked', 'true');
    cy.wait('@setSeriesRelocationEnabled');
    cy.reload();
    cy.wait('@storage');
    cy.wait('@storageJobs');
    cy.findByRole('checkbox', { name: 'Series Relocation' }).should(
      'have.attr',
      'aria-checked',
      'true'
    );

    cy.visit('/settings/jobs');
    cy.contains('tr', 'Series Relocation').within(() => {
      cy.contains('Enabled').should('be.visible');
      cy.findByRole('checkbox', { name: /Series Relocation/ }).should(
        'not.exist'
      );
      cy.contains('button', 'Edit').should('be.enabled');
      cy.contains('button', 'Run Now').should('be.enabled');
    });
  });

  it('keeps all three feature toggles independent across save and reload', () => {
    let persistedSettings = {
      ...storageResponse.settings,
      defaultSeriesVolumeId: 'physical:volume3',
      expansionSeriesVolumeId: 'physical:volume4',
      routes: [enabledStorageRoute],
    };
    cy.intercept('GET', '/api/v1/settings/storage', (request) => {
      request.reply({ ...storageResponse, settings: persistedSettings });
    }).as('storage');
    cy.intercept('POST', '/api/v1/settings/storage', (request) => {
      persistedSettings = request.body;
      request.reply(persistedSettings);
    }).as('saveIndependentSettings');

    cy.visit('/settings/storage');
    cy.wait('@storage');
    cy.wait('@storageJobs');

    const overflow = () =>
      cy.findByRole('checkbox', { name: 'Overflow Routing' });
    const placement = () =>
      cy.findByRole('checkbox', { name: 'Automatic Series Placement' });
    const relocation = () =>
      cy.findByRole('checkbox', { name: 'Series Relocation' });

    overflow().click().should('have.attr', 'aria-checked', 'true');
    placement().click().should('have.attr', 'aria-checked', 'true');
    relocation().should('have.attr', 'aria-checked', 'false');
    cy.contains('button', 'Save changes').click();
    cy.wait('@saveIndependentSettings');

    relocation().click();
    cy.wait('@setSeriesRelocationEnabled');
    relocation().should('have.attr', 'aria-checked', 'true');
    overflow().should('have.attr', 'aria-checked', 'true');
    placement().should('have.attr', 'aria-checked', 'true');

    overflow().click().should('have.attr', 'aria-checked', 'false');
    placement().click().should('have.attr', 'aria-checked', 'false');
    relocation().should('have.attr', 'aria-checked', 'true');
    cy.contains('button', 'Save changes').click();
    cy.wait('@saveIndependentSettings');

    cy.reload();
    cy.wait('@storage');
    cy.wait('@storageJobs');
    overflow().should('have.attr', 'aria-checked', 'false');
    placement().should('have.attr', 'aria-checked', 'false');
    relocation().should('have.attr', 'aria-checked', 'true');
  });

  it('keeps confirmed state on Storage and relocation save failures', () => {
    const configuredResponse = {
      ...storageResponse,
      settings: {
        ...storageResponse.settings,
        defaultSeriesVolumeId: 'physical:volume3',
        expansionSeriesVolumeId: 'physical:volume4',
        routes: [enabledStorageRoute],
      },
    };
    cy.intercept('GET', '/api/v1/settings/storage', configuredResponse).as(
      'storage'
    );
    cy.intercept('POST', '/api/v1/settings/storage', {
      statusCode: 500,
      body: { message: 'Storage save failed.' },
    }).as('failedStorageSave');
    cy.intercept('POST', '/api/v1/settings/jobs/series-relocation/enabled', {
      statusCode: 503,
      body: { message: 'Relocation state was not persisted.' },
    }).as('failedRelocationSave');

    cy.visit('/settings/storage');
    cy.wait('@storage');
    cy.wait('@storageJobs');

    cy.findByRole('checkbox', { name: 'Overflow Routing' })
      .click()
      .should('have.attr', 'aria-checked', 'true');
    cy.contains('button', 'Save changes').click();
    cy.wait('@failedStorageSave');
    cy.findByRole('checkbox', { name: 'Overflow Routing' }).should(
      'have.attr',
      'aria-checked',
      'true'
    );
    cy.findByRole('checkbox', { name: 'Automatic Series Placement' }).should(
      'have.attr',
      'aria-checked',
      'false'
    );

    cy.findByRole('checkbox', { name: 'Series Relocation' }).click();
    cy.wait('@failedRelocationSave');
    cy.findByRole('checkbox', { name: 'Series Relocation' }).should(
      'have.attr',
      'aria-checked',
      'false'
    );
    cy.contains('Relocation state was not persisted.').should('be.visible');
  });

  it('reports invalid or unsaved Series Relocation configuration without changing another toggle', () => {
    cy.intercept('GET', '/api/v1/settings/storage', storageResponse).as(
      'storage'
    );
    cy.visit('/settings/storage');
    cy.wait('@storage');
    cy.wait('@storageJobs');

    cy.findByRole('checkbox', { name: 'Series Relocation' }).click();
    cy.contains(
      'Series Relocation requires two different eligible Sonarr volumes.'
    ).should('be.visible');
    cy.findByRole('checkbox', { name: 'Series Relocation' }).should(
      'have.attr',
      'aria-checked',
      'false'
    );
    cy.findByRole('checkbox', { name: 'Overflow Routing' }).should(
      'have.attr',
      'aria-checked',
      'false'
    );
    cy.findByRole('checkbox', { name: 'Automatic Series Placement' }).should(
      'have.attr',
      'aria-checked',
      'false'
    );

    cy.findByLabelText('Default volume').select('physical:volume3');
    cy.findByLabelText('Expansion volume').select('physical:volume4');
    cy.findByLabelText('Relocation delay (h)').clear().type('72');
    cy.findByRole('checkbox', { name: 'Series Relocation' }).click();
    cy.contains(
      'Save the Series Routing volume and policy settings before enabling Series Relocation.'
    ).should('be.visible');
    cy.findByRole('checkbox', { name: 'Series Relocation' }).should(
      'have.attr',
      'aria-checked',
      'false'
    );
  });

  it('reports confirmed, partial, and failed capacity refreshes without clearing stale data', () => {
    let response: typeof storageResponse | { forceNetworkError: true } =
      storageResponse;
    let requestCount = 0;
    cy.intercept('GET', '/api/v1/settings/storage', (request) => {
      requestCount += 1;
      if ('forceNetworkError' in response) {
        request.reply(response);
        return;
      }
      request.reply({ delay: requestCount === 2 ? 250 : 0, body: response });
    }).as('refreshStorage');

    cy.visit('/settings/storage');
    cy.wait('@refreshStorage');
    cy.get('time').should('have.attr', 'datetime', storageResponse.refreshedAt);
    cy.get('[data-testid="storage-capacity-total-volume1"]')
      .invoke('text')
      .as('originalCapacity');

    response = {
      ...storageResponse,
      refreshedAt: '2026-10-16T10:05:00.000Z',
    };
    cy.findByRole('button', { name: 'Refresh capacity' })
      .click()
      .should('be.disabled')
      .and('have.attr', 'aria-busy', 'true')
      .find('svg')
      .should('have.class', 'animate-spin');
    cy.findByRole('button', { name: 'Refresh capacity' }).then(($button) => {
      $button[0].click();
    });
    cy.wait('@refreshStorage');
    cy.wrap(null).should(() => expect(requestCount).to.equal(2));
    cy.contains('Storage capacity refreshed.').should('be.visible');
    cy.get('time').should('have.attr', 'datetime', '2026-10-16T10:05:00.000Z');

    response = {
      ...storageResponse,
      refreshedAt: '2026-10-16T10:10:00.000Z',
      instances: storageResponse.instances.map((instance) =>
        instance.provider === 'sonarr'
          ? { ...instance, capacityAvailable: false }
          : instance
      ),
    };
    cy.findByRole('button', { name: 'Refresh capacity' }).click();
    cy.wait('@refreshStorage');
    cy.contains(
      'Storage capacity refreshed with warnings. Unable to refresh: Sonarr · Shows.'
    ).should('be.visible');

    response = {
      ...storageResponse,
      refreshedAt: '2026-10-16T10:15:00.000Z',
      instances: storageResponse.instances.map((instance) => ({
        ...instance,
        available: false,
        capacityAvailable: false,
      })),
    };
    cy.findByRole('button', { name: 'Refresh capacity' }).click();
    cy.wait('@refreshStorage');
    cy.contains('Unable to refresh storage capacity.').should('be.visible');

    response = { forceNetworkError: true };
    cy.findByRole('button', { name: 'Refresh capacity' }).click();
    cy.wait('@refreshStorage');
    cy.contains('Unable to refresh storage capacity.').should('be.visible');
    cy.get('@originalCapacity').then((originalCapacity) => {
      cy.get('[data-testid="storage-capacity-total-volume1"]').should(
        'have.text',
        originalCapacity
      );
    });
    cy.get('time').should('have.attr', 'datetime', '2026-10-16T10:15:00.000Z');
  });

  it('uses one strict threshold and treats the exact boundary as normal', () => {
    const response = JSON.parse(JSON.stringify(storageResponse));
    const volume1 = response.volumes.find(
      (volume: { volumeKey: string }) => volume.volumeKey === 'volume1'
    );
    const volume3 = response.volumes.find(
      (volume: { volumeKey: string }) => volume.volumeKey === 'volume3'
    );
    const volume4 = response.volumes.find(
      (volume: { volumeKey: string }) => volume.volumeKey === 'volume4'
    );
    Object.assign(volume1, {
      totalSpace: 1000,
      freeSpace: 99,
      usedSpace: 901,
      usedPercentage: 90.1,
      accessible: true,
    });
    Object.assign(volume3, {
      totalSpace: 1000,
      freeSpace: 151,
      usedSpace: 849,
      usedPercentage: 84.9,
      accessible: true,
    });
    Object.assign(volume4, {
      totalSpace: 2000,
      freeSpace: 200,
      usedSpace: 1800,
      usedPercentage: 90,
      accessible: true,
    });

    cy.intercept('GET', '/api/v1/settings/storage', response).as('storage');
    cy.intercept('POST', '/api/v1/settings/storage', (request) => {
      expect(request.body).to.include({
        freeSpaceThreshold: 15,
      });
      request.reply(request.body);
    }).as('saveStorage');

    cy.visit('/settings/storage');
    cy.wait('@storage');

    cy.get('[data-testid="storage-capacity-free-volume1"]').should(
      'have.css',
      'color',
      'rgb(205, 127, 127)'
    );
    cy.get('[data-testid="storage-capacity-free-volume4"]').should(
      'have.css',
      'color',
      'rgb(119, 173, 140)'
    );
    cy.get('[data-testid="storage-capacity-free-volume3"]').should(
      'have.css',
      'color',
      'rgb(119, 173, 140)'
    );
    cy.get('[data-testid^="storage-free-space-level-"]').should('not.exist');
    cy.get('[data-testid="storage-volume-volume4"]').should('have.length', 1);

    cy.get('#overflow-free-space-threshold').select('15');
    cy.get('[data-testid="storage-capacity-free-volume4"]').should(
      'have.css',
      'color',
      'rgb(205, 127, 127)'
    );
    cy.get('[data-testid="storage-capacity-free-volume3"]').should(
      'have.css',
      'color',
      'rgb(119, 173, 140)'
    );
    cy.contains('button', 'Save changes').click();
    cy.wait('@saveStorage');
  });

  it('keeps the compact header and exposes no unsupported threshold values', () => {
    cy.intercept('GET', '/api/v1/settings/storage', storageResponse).as(
      'storage'
    );
    cy.visit('/settings/storage');
    cy.wait('@storage');

    cy.get('#overflow-free-space-threshold')
      .find('option')
      .should('have.length', 4)
      .and('not.contain', '0%')
      .and('not.contain', '25%');
    cy.contains('Storage capacity and Overflow configuration.').should(
      'not.exist'
    );
    cy.contains('Capacity is fetched directly from configured Servarr').should(
      'not.exist'
    );
    cy.contains('Volumes below this free-space percentage').should('not.exist');
  });

  it('shows Provisioned only for confirmed positive capacity', () => {
    const response = JSON.parse(JSON.stringify(storageResponse));
    const volume1 = response.volumes.find(
      (volume: { volumeKey: string }) => volume.volumeKey === 'volume1'
    );
    volume1.provisionedSpaceBytes = '25';
    volume1.unaccountedUsageBytes = '475';
    cy.intercept('GET', '/api/v1/settings/storage', response).as('storage');

    cy.visit('/settings/storage');
    cy.wait('@storage');

    cy.get('[data-testid="storage-volume-volume1"]').within(() => {
      cy.get('[data-testid="storage-provisioned-segment-volume1"]').should(
        'be.visible'
      );
      cy.get('[data-testid="storage-provisioned-legend-volume1"]')
        .should('be.visible')
        .and('contain', 'Provisioned')
        .and('contain', '25 Bytes')
        .and('contain', '2.5%');
    });
    cy.get('[data-testid="storage-volume-volume4"]')
      .contains('Provisioned')
      .should('not.exist');
  });

  it('renders fresh roots from the normal data-backed providers', () => {
    cy.visit('/settings/storage');

    cy.contains('h3', 'Volume 1').should('be.visible');
    cy.contains('h3', 'Volume 3').should('be.visible');
    cy.contains('h3', 'Volume 9').should('be.visible');
    cy.contains('Root folder details').should('not.exist');
    cy.get('[data-testid="storage-volume-volume9"]').should('have.length', 1);
    cy.contains('No Radarr or Sonarr storage roots were found.').should(
      'not.exist'
    );
  });

  it('keeps an unrecognized path on its own card instead of capacity-grouping it', () => {
    const response = JSON.parse(JSON.stringify(storageResponse));
    response.locations.push({
      ...storageResponse.locations[0],
      id: 'radarr:1:root:12',
      rootFolderId: 12,
      name: 'Legacy Archive',
      path: '/legacy/archive',
    });
    response.volumes.push({
      ...storageResponse.volumes[0],
      id: 'location:radarr:1:root:12',
      name: 'Legacy Archive',
      volumeKey: null,
      locationIds: ['radarr:1:root:12'],
      segments: [
        {
          ...storageResponse.volumes[0].segments[0],
          id: 'radarr:1:root:12',
          locationId: 'radarr:1:root:12',
          rootFolderId: 12,
          label: 'Legacy Archive',
          path: '/legacy/archive',
        },
      ],
    });
    cy.intercept('GET', '/api/v1/settings/storage', response);

    cy.visit('/settings/storage');

    cy.get('article[data-testid^="storage-volume-"]').should('have.length', 4);
    cy.contains('h3', 'Legacy Archive').should('be.visible');
    cy.get('[data-testid="storage-segment-legend-radarr:1:root:12"]')
      .should('be.visible')
      .and('contain', 'Legacy Archive');
  });

  it('keeps volume cards and route groups responsive at every supported width', () => {
    cy.intercept('GET', '/api/v1/settings/storage', {
      ...storageResponse,
      settings: {
        ...storageResponse.settings,
        routes: [enabledStorageRoute],
      },
    }).as('storageLayout');

    for (const [width, height] of [
      [1440, 900],
      [900, 900],
      [768, 900],
      [600, 900],
      [390, 844],
    ]) {
      cy.viewport(width, height);
      cy.visit('/settings/storage');
      cy.wait('@storageLayout');

      cy.document().should((document) => {
        expect(document.documentElement.scrollWidth).to.equal(
          document.documentElement.clientWidth
        );
      });
      cy.get('[data-testid="storage-physical-volumes-section"]').then(
        ($physical) => {
          cy.get('[data-testid="storage-overflow-routing-section"]').then(
            ($overflow) => {
              expect($physical[0].compareDocumentPosition($overflow[0])).to.eq(
                Node.DOCUMENT_POSITION_FOLLOWING
              );
            }
          );
        }
      );
      cy.get('[data-testid="storage-overflow-routing-section"]').then(
        ($routing) => {
          cy.get('[data-testid="storage-series-routing-section"]').then(
            ($series) => {
              expect($routing[0].compareDocumentPosition($series[0])).to.eq(
                Node.DOCUMENT_POSITION_FOLLOWING
              );
            }
          );
        }
      );
      cy.get('[data-testid="storage-series-routing-section"]').then(
        ($series) => {
          cy.get('[data-testid="storage-automation-section"]').then(
            ($automation) => {
              expect($series[0].compareDocumentPosition($automation[0])).to.eq(
                Node.DOCUMENT_POSITION_FOLLOWING
              );
            }
          );
        }
      );
      cy.get('[data-testid="storage-add-route"]').should(($route) => {
        const route = $route[0];
        const source = route.querySelector<HTMLElement>('#overflow-source');
        const target = route.querySelector<HTMLElement>(
          '#overflow-destination'
        );
        const threshold = route.querySelector<HTMLElement>(
          '#overflow-route-threshold'
        );
        const arrow = route.querySelector<HTMLElement>('svg');
        const addButton = route.querySelector<HTMLElement>('button');

        expect(source).not.to.equal(null);
        expect(target).not.to.equal(null);
        expect(threshold).not.to.equal(null);
        expect(arrow).not.to.equal(null);
        expect(addButton).not.to.equal(null);
        expect(route.scrollWidth).to.be.at.most(route.clientWidth);

        const routeBounds = route.getBoundingClientRect();
        const sourceBounds = source?.getBoundingClientRect();
        const targetBounds = target?.getBoundingClientRect();
        const thresholdBounds = threshold?.getBoundingClientRect();
        const arrowBounds = arrow?.getBoundingClientRect();
        const addBounds = addButton?.getBoundingClientRect();

        if (routeBounds.width >= 280) {
          expect(sourceBounds?.top ?? 0).to.be.closeTo(
            targetBounds?.top ?? 0,
            1
          );
          expect(sourceBounds?.right ?? 0).to.be.lessThan(
            arrowBounds?.left ?? 0
          );
          expect(arrowBounds?.right ?? 0).to.be.lessThan(
            targetBounds?.left ?? 0
          );
        } else {
          expect(targetBounds?.top ?? 0).to.be.greaterThan(
            sourceBounds?.bottom ?? 0
          );
        }

        if (routeBounds.width >= 700) {
          expect(thresholdBounds?.top ?? 0).to.be.closeTo(
            sourceBounds?.top ?? 0,
            1
          );
          expect(addBounds?.top ?? 0).to.be.closeTo(sourceBounds?.top ?? 0, 1);
        } else {
          expect(thresholdBounds?.top ?? 0).to.be.greaterThan(
            sourceBounds?.bottom ?? 0
          );
          expect(addBounds?.top ?? 0).to.be.closeTo(
            thresholdBounds?.top ?? 0,
            1
          );
        }
      });
      cy.get('[data-testid="storage-saved-route"]').each(($route) => {
        const route = $route[0];
        const names = route.querySelectorAll<HTMLElement>('strong');
        const threshold = route.querySelector<HTMLElement>('input');
        const toggle = route.querySelector<HTMLElement>('[role="checkbox"]');
        const removeButton = route.querySelector<HTMLElement>('button');

        expect(names).to.have.length(2);
        expect(threshold).not.to.equal(null);
        expect(toggle).not.to.equal(null);
        expect(removeButton).not.to.equal(null);
        expect(route.scrollWidth).to.be.at.most(route.clientWidth);

        const routeBounds = route.getBoundingClientRect();
        const sourceBounds = names[0].getBoundingClientRect();
        const targetBounds = names[1].getBoundingClientRect();
        const thresholdBounds = threshold?.getBoundingClientRect();
        const toggleBounds = toggle?.getBoundingClientRect();
        const removeBounds = removeButton?.getBoundingClientRect();

        if (routeBounds.width >= 280) {
          expect(sourceBounds.top).to.be.closeTo(targetBounds.top, 1);
        } else {
          expect(targetBounds.top).to.be.greaterThan(sourceBounds.bottom);
        }

        if (routeBounds.width >= 700) {
          expect(
            (thresholdBounds?.top ?? 0) + (thresholdBounds?.height ?? 0) / 2
          ).to.be.closeTo(sourceBounds.top + sourceBounds.height / 2, 1);
        } else {
          expect(thresholdBounds?.top ?? 0).to.be.greaterThan(
            sourceBounds.bottom
          );
        }
        expect(toggleBounds?.right ?? 0).to.be.lessThan(
          removeBounds?.left ?? 0
        );
      });
      cy.get('[data-testid="storage-physical-volumes-section"]').within(() => {
        cy.get('#overflow-free-space-threshold').should('be.visible');
        cy.findByRole('button', { name: 'Refresh capacity' }).should(
          ($button) => {
            const bounds = $button[0].getBoundingClientRect();
            expect(bounds.width).to.be.at.least(40);
            expect(bounds.height).to.be.at.least(40);
          }
        );
      });
      cy.get('[data-testid="storage-volume-list"]').should(($list) => {
        expect(getComputedStyle($list[0]).display).to.equal('block');
      });
      cy.get('article[data-testid^="storage-volume-"]').each(($card) => {
        const card = $card[0].getBoundingClientRect();
        const list = $card[0].parentElement?.getBoundingClientRect();
        expect(list).not.to.equal(undefined);
        expect(card.width).to.be.closeTo(list?.width ?? 0, 1);
      });
      cy.get('[data-testid^="storage-volume-summary-"]').each(($summary) => {
        expect(getComputedStyle($summary[0]).display).to.equal('flex');
        expect(getComputedStyle($summary[0]).flexWrap).to.equal('wrap');
        expect($summary[0].scrollWidth).to.be.at.most($summary[0].clientWidth);
      });
      cy.get('[data-testid^="storage-capacity-"]').each(($metric) => {
        expect($metric[0].scrollWidth).to.be.at.most($metric[0].clientWidth);
      });
      cy.get('[data-testid^="storage-volume-bar-"]').each(($bar) => {
        const bar = $bar[0].getBoundingClientRect();
        const card = $bar[0].closest('article')?.getBoundingClientRect();
        expect(card).not.to.equal(undefined);
        expect(bar.width).to.be.closeTo((card?.width ?? 0) - 40, 1);
        expect(bar.height).to.equal(14);
      });
      cy.get('[data-testid^="storage-volume-legend-"]').each(($legend) => {
        expect(getComputedStyle($legend[0]).display).to.equal('flex');
        expect(getComputedStyle($legend[0]).flexWrap).to.equal('wrap');
      });
      cy.get(
        '[data-testid="automation-overflow-routing-row"], [data-testid="automation-automatic-series-placement-row"], [data-testid="automation-series-relocation-row"]'
      ).each(($row) => {
        const rowStyle = getComputedStyle($row[0]);
        const rowBounds = $row[0].getBoundingClientRect();
        const toggle = $row[0].querySelector<HTMLElement>('[role="checkbox"]');
        expect(toggle).not.to.equal(null);
        const toggleBounds = toggle?.getBoundingClientRect();
        expect(rowStyle.display).to.equal('flex');
        expect(rowStyle.alignItems).to.equal('center');
        expect(rowStyle.justifyContent).to.equal('space-between');
        expect(toggleBounds?.right ?? 0).to.be.closeTo(rowBounds.right, 1);
        cy.findByRole('checkbox', { name: 'Overflow Routing' }).then(
          ($overflowToggle) => {
            const overflowBounds = $overflowToggle[0].getBoundingClientRect();
            expect(toggleBounds?.width).to.equal(overflowBounds.width);
            expect(toggleBounds?.height).to.equal(overflowBounds.height);
          }
        );
      });
      cy.get(
        '[data-testid="storage-leaving-soon-segment-radarr:1:root:11"]'
      ).then(($leavingSoon) => {
        const leavingSoon = $leavingSoon[0].getBoundingClientRect();
        const bar = $leavingSoon[0].parentElement?.getBoundingClientRect();
        expect(bar).not.to.equal(undefined);
        expect(leavingSoon.width).to.be.closeTo((bar?.width ?? 0) * 0.01, 1);
      });
    }
  });

  it('keeps route controls within exact narrow container widths', () => {
    cy.intercept('GET', '/api/v1/settings/storage', {
      ...storageResponse,
      settings: {
        ...storageResponse.settings,
        routes: [enabledStorageRoute],
      },
    }).as('storageContainerWidths');

    cy.viewport(1440, 900);
    cy.visit('/settings/storage');
    cy.wait('@storageContainerWidths');

    for (const width of [700, 500, 420, 390, 350, 320, 280, 240]) {
      cy.get('.storage-routing-container').then(($container) => {
        const container = $container[0];
        container.style.boxSizing = 'content-box';
        container.style.width = `${width}px`;
      });

      cy.get('[data-testid="storage-add-route"]').should(($route) => {
        const route = $route[0];
        const source = route.querySelector<HTMLElement>('#overflow-source');
        const target = route.querySelector<HTMLElement>(
          '#overflow-destination'
        );
        const threshold = route.querySelector<HTMLElement>(
          '#overflow-route-threshold'
        );
        const arrow = route.querySelector<HTMLElement>(
          '.storage-route-arrow-icon'
        );
        const addButton = route.querySelector<HTMLElement>('button');

        expect(source).not.to.equal(null);
        expect(target).not.to.equal(null);
        expect(threshold).not.to.equal(null);
        expect(arrow).not.to.equal(null);
        expect(addButton).not.to.equal(null);
        expect(route.scrollWidth).to.be.at.most(route.clientWidth);

        const sourceBounds = source?.getBoundingClientRect();
        const targetBounds = target?.getBoundingClientRect();
        const thresholdBounds = threshold?.getBoundingClientRect();
        const addBounds = addButton?.getBoundingClientRect();
        const matrix = new DOMMatrixReadOnly(
          getComputedStyle(arrow!).transform
        );
        const arrowRotation = Math.abs(
          Math.round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI)
        );

        if (width >= 280) {
          expect(sourceBounds?.top ?? 0).to.be.closeTo(
            targetBounds?.top ?? 0,
            1
          );
          expect(sourceBounds?.width ?? 0).to.be.closeTo(
            targetBounds?.width ?? 0,
            1
          );
          expect(sourceBounds?.width ?? 0).to.be.at.most(180);
          expect(arrowRotation).to.equal(0);
        } else {
          expect(targetBounds?.top ?? 0).to.be.greaterThan(
            sourceBounds?.bottom ?? 0
          );
          expect(arrowRotation).to.equal(90);
        }

        if (width >= 700) {
          expect(thresholdBounds?.top ?? 0).to.be.closeTo(
            sourceBounds?.top ?? 0,
            1
          );
          expect(addBounds?.top ?? 0).to.be.closeTo(sourceBounds?.top ?? 0, 1);
        } else if (width >= 280) {
          expect(thresholdBounds?.top ?? 0).to.be.greaterThan(
            sourceBounds?.bottom ?? 0
          );
          expect(addBounds?.top ?? 0).to.be.closeTo(
            thresholdBounds?.top ?? 0,
            1
          );
        }
      });

      cy.get('[data-testid="storage-saved-route"]').should(($route) => {
        const route = $route[0];
        const names = route.querySelectorAll<HTMLElement>('strong');
        const threshold = route.querySelector<HTMLElement>('input');
        const actions = route.querySelector<HTMLElement>(
          '.storage-route-actions'
        );
        const toggle = route.querySelector<HTMLElement>('[role="checkbox"]');
        const removeButton = route.querySelector<HTMLElement>('button');

        expect(names).to.have.length(2);
        expect(threshold).not.to.equal(null);
        expect(actions).not.to.equal(null);
        expect(toggle).not.to.equal(null);
        expect(removeButton).not.to.equal(null);
        expect(route.scrollWidth).to.be.at.most(route.clientWidth);
        expect(actions?.contains(toggle!)).to.equal(true);
        expect(actions?.contains(removeButton!)).to.equal(true);

        const sourceBounds = names[0].getBoundingClientRect();
        const targetBounds = names[1].getBoundingClientRect();
        const thresholdBounds = threshold?.getBoundingClientRect();
        const actionsBounds = actions?.getBoundingClientRect();

        if (width >= 280) {
          expect(sourceBounds.top).to.be.closeTo(targetBounds.top, 1);
          expect(sourceBounds.width).to.be.closeTo(targetBounds.width, 1);
        } else {
          expect(targetBounds.top).to.be.greaterThan(sourceBounds.bottom);
        }

        if (width >= 700) {
          expect(thresholdBounds?.top ?? 0).to.be.closeTo(
            actionsBounds?.top ?? 0,
            1
          );
        } else if (width >= 280) {
          expect(thresholdBounds?.top ?? 0).to.be.closeTo(
            actionsBounds?.top ?? 0,
            1
          );
          expect(thresholdBounds?.top ?? 0).to.be.greaterThan(
            sourceBounds.bottom
          );
        }
      });
    }
  });

  it('does not expose Storage settings to a regular user', () => {
    login(Cypress.env('USER_EMAIL'), Cypress.env('USER_PASSWORD'));
    cy.request({
      method: 'GET',
      url: '/api/v1/settings/storage',
      failOnStatusCode: false,
    })
      .its('status')
      .should('equal', 403);
  });
});
