const movie = {
  adult: false,
  backdropPath: null,
  genreIds: [],
  id: 12345,
  mediaType: 'movie',
  originalLanguage: 'en',
  originalTitle: 'Corner Geometry Test',
  overview: 'A deterministic TitleCard geometry fixture.',
  popularity: 1,
  posterPath: null,
  releaseDate: '2026-10-22',
  title: 'Corner Geometry Test',
  video: false,
  voteAverage: 8,
  voteCount: 1,
  mediaInfo: {
    status: 5,
    watchlists: [],
  },
};

const adminUser = {
  id: 1,
  warnings: [],
  displayName: 'TitleCard Test Admin',
  email: 'titlecard-test@seerr.dev',
  avatar: '',
  permissions: 2,
  userType: 2,
  includeInUserMetrics: true,
  createdAt: '2026-10-22T00:00:00.000Z',
  updatedAt: '2026-10-22T00:00:00.000Z',
  requestCount: 0,
};

const authenticateWithFixture = (): void => {
  cy.intercept('GET', '/api/v1/auth/me', adminUser).as('fixtureUser');
  cy.intercept('GET', '/api/v1/settings/discover', []);
  cy.intercept('GET', '/api/v1/request/count', { count: 0 });
  cy.intercept('GET', '/api/v1/issue/count', { count: 0 });
  cy.visit('/login');
  cy.wait('@fixtureUser');
  cy.location('pathname').should('eq', '/');
};

const visitFixture = (): void => {
  cy.intercept('GET', '/api/v1/discover/trending*', {
    page: 1,
    totalPages: 1,
    totalResults: 1,
    results: [movie],
  }).as('trending');
  cy.window().then((window) => {
    const nextWindow = window as typeof window & {
      next: { router: { push: (href: string) => Promise<boolean> } };
    };
    return nextWindow.next.router.push('/discover/trending');
  });
  cy.wait('@trending');
  cy.get('[data-testid="title-card"] a[aria-label]').focus();
  cy.get('[data-action-slot="watchlist"]').should('be.visible');
};

const assertTopCornerGeometry = (): void => {
  cy.get('[data-testid="title-card-corner-frame"]').then(($frame) => {
    const frame = $frame[0].getBoundingClientRect();
    const badge = $frame
      .find('[data-testid="title-card-classification-state"]')[0]
      .getBoundingClientRect();
    const bookmark = $frame
      .find('[data-action-slot="watchlist"]')[0]
      .getBoundingClientRect();

    expect(Math.abs(badge.top - bookmark.top)).to.be.lessThan(0.75);
    expect(
      Math.abs(badge.left - frame.left - (frame.right - bookmark.right))
    ).to.be.lessThan(0.75);
  });
};

describe('TitleCard top-corner geometry', () => {
  beforeEach(() => {
    authenticateWithFixture();
  });

  it('uses matching badge and bookmark insets at desktop width', () => {
    cy.viewport(1280, 720);
    visitFixture();
    assertTopCornerGeometry();
  });

  it('uses matching badge and bookmark insets at mobile width', () => {
    cy.viewport(390, 844);
    visitFixture();
    assertTopCornerGeometry();
  });
});
