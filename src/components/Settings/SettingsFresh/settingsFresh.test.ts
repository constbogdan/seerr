import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
// The node:test harness cannot resolve @app imports from its server tsconfig.
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import MediaTypeFilter from '../../Common/MediaTypeFilter';
import {
  CONFIGURED_TOKEN_MASK,
  composeAutobrrBaseUrl,
  loadFreshFilters,
  selectedFreshFilter,
  splitAutobrrBaseUrl,
  toFreshFilterSelectOptions,
  toFreshSettingsFormValues,
  toFreshSettingsUpdate,
  type FreshSettingsResponse,
} from './settingsFresh';

const response: FreshSettingsResponse = {
  enabled: true,
  baseUrl: 'http://autobrr.internal:7474',
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

describe('Fresh settings client boundary', () => {
  it('composes and decomposes autobrr host, protocol, port, and DNS names', () => {
    assert.deepEqual(splitAutobrrBaseUrl(response.baseUrl), {
      protocol: 'http',
      hostname: 'autobrr.internal',
      port: 7474,
      basePath: '',
    });
    assert.equal(
      composeAutobrrBaseUrl({
        protocol: 'https',
        hostname: '192.0.2.10',
        port: 7474,
        basePath: '',
      }),
      'https://192.0.2.10:7474'
    );
  });

  it('keeps configured-token state out of form and update payloads', () => {
    const form = toFreshSettingsFormValues({
      ...response,
      apiToken: 'fixture-token',
    } as FreshSettingsResponse & { apiToken: string });
    assert.equal(form.apiToken, CONFIGURED_TOKEN_MASK);
    assert.equal('apiTokenConfigured' in form, false);
    const update = toFreshSettingsUpdate(form);
    assert.equal('apiTokenConfigured' in update, false);
    assert.equal('apiToken' in update, false);
    assert.doesNotMatch(JSON.stringify(form), /fixture-token/);
  });

  it('sends a replacement token only when one is supplied', () => {
    const update = toFreshSettingsUpdate({
      ...toFreshSettingsFormValues(response),
      apiToken: ' replacement-token ',
    });
    assert.equal(update.apiToken, 'replacement-token');
  });

  it('preserves the configured filter when loaded options arrive', () => {
    const options = toFreshFilterSelectOptions([
      { id: 7, name: 'Fresh Movies & TV', enabled: true },
      { id: 8, name: 'Other', enabled: true },
    ]);
    assert.deepEqual(selectedFreshFilter(options, response.filterId), {
      value: 7,
      label: 'Fresh Movies & TV',
    });
  });

  it('uses a clear unavailable state instead of displaying a raw filter ID', () => {
    assert.deepEqual(
      selectedFreshFilter(
        [],
        response.filterId,
        'Configured filter unavailable'
      ),
      {
        value: 7,
        label: 'Configured filter unavailable',
      }
    );
  });

  it('keeps the Fresh window and cached filter label across the form boundary', () => {
    const form = toFreshSettingsFormValues(response);
    assert.equal(form.mediaEligibilityDays, 90);
    assert.equal(form.freshVisibilityDays, 7);
    assert.equal(form.cachedFilterName, 'Fresh Movies & TV');
    const update = toFreshSettingsUpdate(form);
    assert.equal(update.mediaEligibilityDays, 90);
    assert.equal(update.freshVisibilityDays, 7);
    assert.equal(update.apiToken, undefined);
    assert.equal(update.cachedFilterName, 'Fresh Movies & TV');
  });

  it('renders connection testing before autobrr filter selection', () => {
    const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
    assert.match(
      source,
      /inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-gray-100 sm:text-sm/
    );
    assert.match(source, /name="port"[\s\S]*?className="short"/);
    assert.match(source, /id="mediaEligibilityDays"[\s\S]*?className="short"/);
    assert.match(source, /id="freshVisibilityDays"[\s\S]*?className="short"/);
    assert.match(source, /<SensitiveInput[\s\S]*?name="apiToken"/);
    assert.match(source, /messages\.apiTokenHelp/);
    assert.doesNotMatch(source, /tokenPlaceholder/);
    assert.match(
      readFileSync(path.join(__dirname, 'settingsFresh.ts'), 'utf8'),
      /CONFIGURED_TOKEN_MASK/
    );
    assert.match(source, /setFieldValue\('apiToken', e\.target\.value\)/);
    assert.match(source, /typeof errors\.apiToken === 'string'/);
    assert.ok(source.indexOf('onClick={loadFilters}') >= 0);
    assert.ok(source.indexOf('inputId="filterId"') >= 0);
    assert.ok(
      source.indexOf('onClick={loadFilters}') <
        source.indexOf('inputId="filterId"')
    );
    assert.match(source, /values\.cachedFilterName/);
    assert.match(source, /messages\.unavailableFilter/);
    assert.match(source, /setFieldValue\('filterId', option\?\.value \?\? 0\)/);
    assert.match(
      source,
      /setFieldValue\('cachedFilterName', option\?\.label \?\? ''\)/
    );
  });

  it('uses the shared synchronization endpoint and reports its real outcome', () => {
    const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
    assert.match(source, /refresh: 'Sync Now'/);
    assert.match(source, /setRefreshing\(true\)/);
    assert.match(source, /\/api\/v1\/settings\/fresh\/refresh/);
    assert.match(source, /\['stale', 'unavailable'\]\.includes/);
    assert.match(source, /messages\.refreshSuccess/);
    assert.match(source, /messages\.refreshFailed/);
    assert.match(source, /latestAttempt\.failingStage/);
    assert.match(source, /latestAttempt\.failureReason/);
    assert.match(source, /latestAttempt\.decisions\.length > 0/);
  });

  it('keeps persistent pipeline state visible without an in-memory attempt', () => {
    const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
    assert.match(source, /messages\.currentItems/);
    assert.match(source, /projection\?\.checkpoint/);
    assert.match(source, /projection\?\.continuityStatus/);
    assert.match(source, /projection\?\.lastRefresh/);
    assert.match(source, /projection\?\.lastReconciliation/);
    assert.match(source, /projectionRows\.map/);
    assert.ok(
      source.indexOf('projectionRows.map') <
        source.indexOf('!diagnostics?.latestAttempt')
    );
    assert.match(
      source,
      /Object\.entries\(diagnostics\.latestAttempt\.stages\)/
    );
  });

  it('keeps durable candidate diagnostics separate from transient decisions', () => {
    const source = readFileSync(
      path.join(__dirname, 'CandidateDiagnostics.tsx'),
      'utf8'
    );
    assert.match(source, /\/api\/v1\/settings\/fresh\/candidates\?/);
    assert.match(source, /page: String\(page\)/);
    assert.match(source, /mediaType/);
    assert.match(source, /MediaTypeFilter/);
    assert.match(source, /id="freshCandidateMediaType"/);
    assert.match(source, /value: 'all'/);
    assert.match(source, /value: 'movie'/);
    assert.match(source, /value: 'tv'/);
    assert.match(source, /status/);
    assert.match(source, /sort/);
    assert.match(source, /Needs Attention/);
    assert.match(
      source,
      /setStatus\(cardStatus as FreshCandidateDiagnosticStatus\)/
    );
    assert.match(source, /eligibility_unknown/);
    assert.match(source, /aria-controls={detailsId}/);
    assert.match(source, /ChevronRightIcon/);
    assert.doesNotMatch(source, /const hasDetails/);
    assert.match(source, /eligibilityDateSource/);
    assert.match(source, /firstQualifyingObservation/);
    assert.match(source, /visibleUntil/);
    assert.match(source, /className="w-28"/);
    assert.match(source, /candidate\.matchYear \?/);
    assert.match(source, /· \{candidate\.mediaType/);
    assert.match(source, /type="text"[\s\S]*?placeholder="Search title"/);
    assert.match(source, /href={mediaPath}/);
    assert.match(source, /https:\/\/www\.themoviedb\.org/);
    assert.match(source, /target="_blank"/);
    assert.ok(
      source.indexOf("['First observed'") < source.indexOf('const CandidateRow')
    );
    assert.match(source, /candidate\.actionable/);
    assert.match(source, /\/resolve`/);
    assert.doesNotMatch(source, /latestAttempt/);
  });

  it('renders the native media icon segment adjacent to the media-type select', () => {
    const markup = renderToStaticMarkup(
      createElement(MediaTypeFilter, {
        id: 'freshCandidateMediaType',
        value: 'all',
        options: [
          { value: 'all', label: 'All' },
          { value: 'movie', label: 'Movies' },
          { value: 'tv', label: 'Series' },
        ],
        onChange: () => undefined,
      })
    );
    const control = markup.match(
      /<div class="flex"><span class="[^"]*shrink-0[^"]*">[\s\S]*?<\/span><select id="freshCandidateMediaType"[^>]*>/
    );

    assert.ok(control, 'expected an adjacent icon segment and media select');
    assert.match(control[0], /<svg/);
    assert.match(control[0], /class="[^"]*rounded-r-only[^"]*"/);
  });

  it('uses native destructive confirmation for a completed Fresh rebuild', () => {
    const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
    assert.match(source, /rebuildTitle: 'Rebuild Fresh Data\?'/);
    assert.match(source, /persisted Fresh discovery history/);
    assert.match(source, /Watchlist, requests, media-library state/);
    assert.match(source, /okButtonType="danger"/);
    assert.match(source, /\/api\/v1\/settings\/fresh\/rebuild/);
    assert.match(source, /await axios\.post/);
    assert.match(source, /messages\.rebuildSuccess/);
    assert.match(source, /messages\.rebuildFailed/);
  });

  it('uses a responsive two-column content-filter layout without changing filter fields', () => {
    const source = readFileSync(
      path.join(__dirname, 'FreshContentFilters.tsx'),
      'utf8'
    );
    assert.match(source, /grid gap-x-6 md:grid-cols-2/);
    for (const field of [
      'includeGenreIds',
      'excludeGenreIds',
      'includeOriginalLanguages',
      'excludeOriginalLanguages',
      'includeContentRatings',
      'excludeContentRatings',
      'minimumTmdbScore',
      'minimumTmdbVotes',
    ]) {
      assert.match(source, new RegExp(field));
    }
  });

  it('returns no raw provider error when filter loading fails', async () => {
    const rawError =
      'https://tracker.invalid/download?apikey=secret-provider-token';
    const result = await loadFreshFilters(async () => {
      throw new Error(rawError);
    });
    assert.deepEqual(result, { ok: false });
    assert.doesNotMatch(JSON.stringify(result), /secret-provider-token/);
  });
});
