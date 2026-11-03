const sliderSelector = '[data-testid=discover-slider-edit-mode]';

const dragSliderOnto = (sourceTitle: string, targetTitle: string): void => {
  cy.window().then((window) => {
    const dataTransfer = new window.DataTransfer();
    const dragEvent = {
      dataTransfer,
      eventConstructor: 'DragEvent',
    };

    cy.contains(sliderSelector, sourceTitle)
      .trigger('dragstart', dragEvent)
      .then(() => {
        expect(Array.from(dataTransfer.types)).to.include('id');
        Object.defineProperty(dataTransfer, 'effectAllowed', {
          configurable: true,
          value: 'all',
        });
        expect(dataTransfer.effectAllowed).to.equal('all');
      });
    cy.contains(sliderSelector, targetTitle).then(($target) => {
      const targetBounds = $target[0].getBoundingClientRect();
      const targetEvent = {
        ...dragEvent,
        clientX: targetBounds.left + targetBounds.width / 2,
        clientY: targetBounds.bottom - 1,
      };

      cy.wrap($target)
        .trigger('dragenter', targetEvent)
        .trigger('dragover', targetEvent);
      cy.wrap($target).trigger('drop', targetEvent);
    });
    cy.contains(sliderSelector, sourceTitle).trigger('dragend', dragEvent);
  });
};

const expectConsecutiveSliderOrder = (
  firstTitle: string,
  secondTitle: string
): void => {
  cy.get(sliderSelector).then(($sliders) => {
    const labels = Array.from($sliders, (slider) => slider.textContent ?? '');
    const firstIndex = labels.findIndex((label) => label.includes(firstTitle));
    const secondIndex = labels.findIndex((label) =>
      label.includes(secondTitle)
    );

    expect(firstIndex, `${firstTitle} slider index`).to.be.greaterThan(-1);
    expect(secondIndex, `${secondTitle} slider index`).to.equal(firstIndex + 1);
  });
};

describe('Discover Customization', () => {
  beforeEach(() => {
    cy.loginAsAdmin();
    cy.intercept('/api/v1/settings/discover').as('getDiscoverSliders');
  });

  it('show the discover customization settings', () => {
    cy.visit('/');

    cy.get('[data-testid=discover-start-editing]').click();

    cy.get('[data-testid=create-slider-header')
      .should('contain', 'Create New Slider')
      .scrollIntoView();

    // There should be some built in options
    cy.get('[data-testid=discover-slider-edit-mode]').should(
      'contain',
      'Recently Added'
    );
    cy.get('[data-testid=discover-slider-edit-mode]').should(
      'contain',
      'Recent Requests'
    );
  });

  it('can drag to re-order elements and save to persist the changes', () => {
    cy.visit('/');

    cy.get('[data-testid=discover-start-editing]').click();

    expectConsecutiveSliderOrder('Recently Added', 'Recent Requests');
    dragSliderOnto('Recently Added', 'Recent Requests');
    expectConsecutiveSliderOrder('Recent Requests', 'Recently Added');

    cy.get('[data-testid=discover-customize-submit').click();
    cy.wait('@getDiscoverSliders');

    cy.reload();

    cy.get('[data-testid=discover-start-editing]').click();

    expectConsecutiveSliderOrder('Recent Requests', 'Recently Added');
    dragSliderOnto('Recently Added', 'Recent Requests');
    expectConsecutiveSliderOrder('Recently Added', 'Recent Requests');

    cy.get('[data-testid=discover-customize-submit').click();
    cy.wait('@getDiscoverSliders');
  });

  it('can create a new discover option and remove it', () => {
    cy.visit('/');
    cy.intercept('/api/v1/settings/discover/*').as('discoverSlider');
    cy.intercept('/api/v1/search/keyword*').as('searchKeyword');

    cy.get('[data-testid=discover-start-editing]').click();

    const sliderTitle = 'Custom Keyword Slider';

    cy.get('#sliderType').select('TMDB Movie Keyword');

    cy.get('#title').type(sliderTitle);
    // First confirm that an invalid keyword doesn't allow us to submit anything
    cy.get('#data').type('invalidkeyword{enter}', { delay: 100 });
    cy.wait('@searchKeyword');

    cy.get('[data-testid=create-discover-option-form]')
      .find('button')
      .should('be.disabled');

    cy.get('#data').clear();
    cy.get('#data').type('christmas{enter}', { delay: 100 });

    // Confirming we have some results
    cy.contains('.slider-header', sliderTitle)
      .next('[data-testid=media-slider]')
      .find('[data-testid=title-card]');

    cy.get('[data-testid=create-discover-option-form]').submit();

    cy.wait('@discoverSlider');
    cy.wait('@getDiscoverSliders');
    cy.wait(1000);

    cy.get('[data-testid=discover-slider-edit-mode]')
      .first()
      .should('contain', sliderTitle);

    // Make sure its still there even if we reload
    cy.reload();

    cy.get('[data-testid=discover-start-editing]').click();

    cy.get('[data-testid=discover-slider-edit-mode]')
      .first()
      .should('contain', sliderTitle);

    // Verify it's not rendering on our discover page (its still disabled!)
    cy.visit('/');

    cy.get('.slider-header').should('not.contain', sliderTitle);

    cy.get('[data-testid=discover-start-editing]').click();

    // Enable it, and check again
    cy.get('[data-testid=discover-slider-edit-mode]')
      .first()
      .find('[role="checkbox"]')
      .click();

    cy.get('[data-testid=discover-customize-submit').click();
    cy.wait('@getDiscoverSliders');

    cy.visit('/');

    cy.contains('.slider-header', sliderTitle)
      .next('[data-testid=media-slider]')
      .find('[data-testid=title-card]');

    cy.get('[data-testid=discover-start-editing]').click();

    // let's delete it and confirm its deleted.
    cy.get('[data-testid=discover-slider-edit-mode]')
      .first()
      .find('[data-testid=discover-slider-remove-button]')
      .click();

    cy.wait('@discoverSlider');
    cy.wait('@getDiscoverSliders');
    cy.wait(1000);

    cy.get('[data-testid=discover-slider-edit-mode]')
      .first()
      .should('not.contain', sliderTitle);
  });
});
