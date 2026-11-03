import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

import { sonarrSeriesTypeInitialValues } from './seriesTypeValues';

describe('Sonarr series-type form initialization', () => {
  const modal = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');

  it('defaults a new Sonarr service to Standard and Anime', () => {
    assert.deepEqual(sonarrSeriesTypeInitialValues(null), {
      seriesType: 'standard',
      animeSeriesType: 'anime',
    });
  });

  it('defaults missing legacy values to the options visibly selected by the form', () => {
    assert.deepEqual(sonarrSeriesTypeInitialValues({}), {
      seriesType: 'standard',
      animeSeriesType: 'anime',
    });
  });

  it('preserves persisted regular and Anime Series Type values', () => {
    assert.deepEqual(
      sonarrSeriesTypeInitialValues({
        seriesType: 'daily',
        animeSeriesType: 'standard',
      }),
      {
        seriesType: 'daily',
        animeSeriesType: 'standard',
      }
    );
  });

  it('uses the initialized values in Formik and the unchanged save payload', () => {
    assert.match(modal, /seriesType: seriesTypeInitialValues\.seriesType/);
    assert.match(
      modal,
      /animeSeriesType: seriesTypeInitialValues\.animeSeriesType/
    );
    assert.match(modal, /seriesType: values\.seriesType/);
    assert.match(modal, /animeSeriesType: values\.animeSeriesType/);
  });
});
