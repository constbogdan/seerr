describe('Settings sidebar navigation', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
  });

  it('expands without navigating, highlights the active page, and follows route boundaries', () => {
    cy.viewport(1440, 900);
    cy.visit('/settings/storage');

    cy.get('[data-testid="sidebar-menu-settings"]')
      .should('have.attr', 'aria-expanded', 'true')
      .and('have.attr', 'aria-controls', 'settings-navigation-submenu-desktop');
    cy.get('[data-testid="settings-submenu-storage-desktop"]').should(
      'have.attr',
      'aria-current',
      'page'
    );
    cy.get('[data-testid="settings-nav-desktop"]').should('not.exist');
    cy.get('#settings-page-selector').should('not.be.visible');

    cy.get('[data-testid="sidebar-menu-settings"]').click();
    cy.location('pathname').should('eq', '/settings/storage');
    cy.get('[data-testid="sidebar-menu-settings"]').should(
      'have.attr',
      'aria-expanded',
      'false'
    );
    cy.get('[data-testid="settings-submenu-desktop"]').should('not.exist');

    cy.get('[data-testid="sidebar-menu-settings"]').click();
    cy.get('[data-testid="settings-submenu-general-desktop"]').click();
    cy.location('pathname').should('eq', '/settings/main');
    cy.get('[data-testid="settings-submenu-general-desktop"]').should(
      'have.attr',
      'aria-current',
      'page'
    );

    cy.visit('/discover/movies');
    cy.get('[data-testid="sidebar-menu-settings"]').should(
      'have.attr',
      'aria-expanded',
      'false'
    );
    cy.go('back');
    cy.location('pathname').should('eq', '/settings/main');
    cy.get('[data-testid="sidebar-menu-settings"]').should(
      'have.attr',
      'aria-expanded',
      'true'
    );
  });

  it('uses the expandable drawer navigation and compact selector on tablet', () => {
    cy.viewport(900, 700);
    cy.visit('/settings/storage');

    cy.get('#settings-page-selector').should('be.visible');
    cy.get('[data-testid="sidebar-toggle"]').click();
    cy.get('#tablet-navigation-drawer').should('be.visible');
    cy.get('[data-testid="sidebar-menu-settings-mobile"]').should(
      'have.attr',
      'aria-expanded',
      'true'
    );
    cy.get('[data-testid="settings-submenu-storage-tablet"]').should(
      'have.attr',
      'aria-current',
      'page'
    );
    cy.get('[data-testid="settings-submenu-jobs-tablet"]').click();
    cy.location('pathname').should('eq', '/settings/jobs');
    cy.get('body').should(($body) => {
      const drawer = $body.find('#tablet-navigation-drawer');
      expect(drawer.length === 0 || !Cypress.dom.isVisible(drawer)).to.eq(true);
    });
  });

  for (const width of [390, 320]) {
    it(`keeps the compact selector available at ${width}px`, () => {
      cy.viewport(width, 700);
      cy.visit('/settings/storage');

      cy.get('#settings-page-selector')
        .should('be.visible')
        .select('/settings/main');
      cy.location('pathname').should('eq', '/settings/main');
      cy.get('body').should(($body) => {
        const tabletSettings = $body.find(
          '[data-testid="sidebar-menu-settings-mobile"]'
        );
        expect(
          tabletSettings.length === 0 || !Cypress.dom.isVisible(tabletSettings)
        ).to.eq(true);
      });
    });
  }

  it('keeps the active submenu destination reachable on a short desktop', () => {
    cy.viewport(1024, 500);
    cy.visit('/settings/about');

    cy.get('[data-testid="settings-submenu-about-desktop"]')
      .should('be.visible')
      .then(($link) => {
        const bounds = $link[0].getBoundingClientRect();
        expect(bounds.top).to.be.at.least(0);
        expect(bounds.bottom).to.be.at.most(500);
      });
  });
});
