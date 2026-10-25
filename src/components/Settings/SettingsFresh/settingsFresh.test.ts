import type { FreshStatus } from '@server/lib/fresh/types';
import type { FreshSettings } from '@server/lib/settings';
import axios from 'axios';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import * as jsxRuntime from 'react/jsx-runtime';
import * as swr from 'swr';
import { register } from 'tsconfig-paths';
import { JsxEmit, ModuleKind, transpileModule } from 'typescript';

const root = path.join(__dirname, '../../../..');
const paths = { '@app/*': ['src/*'], '@server/*': ['server/*'] };
const unregister = register({ baseUrl: root, paths });
// Render real client components under the server runner. Client tsc separately
// validates types; a local TSX loader avoids the server-only alias compiler.
const previousTsx = require.extensions['.tsx'];
const swrPath = require.resolve('swr');
const runtimePath = require.resolve('react/jsx-runtime');
const originalSwrModule = require.cache[swrPath]!;
const originalRuntimeModule = require.cache[runtimePath]!;
let settingsData: unknown;
let statusData: FreshStatus | undefined;
const swrCalls: { key: string; options: unknown }[] = [];
const revalidations: string[] = [];
let formCallbacks:
  | { onSave: (values: FreshSettings) => Promise<void>; health?: FreshStatus }
  | undefined;
require.cache[swrPath] = {
  ...originalSwrModule,
  exports: {
    ...swr,
    __esModule: true,
    default: (key: string, options?: unknown) => {
      swrCalls.push({ key, options });
      return {
        data:
          key === '/api/v1/settings/fresh'
            ? settingsData
            : key === '/api/v1/settings/fresh/status'
              ? statusData
              : undefined,
        mutate: async () => {
          revalidations.push(key);
        },
      };
    },
  },
};
const recordForm =
  (factory: typeof jsxRuntime.jsx): typeof jsxRuntime.jsx =>
  (...args) => {
    const [type, props] = args;
    if (typeof type === 'function' && type.name === 'FreshSettingsForm')
      formCallbacks = props as NonNullable<typeof formCallbacks>;
    return factory(...args);
  };
require.cache[runtimePath] = {
  ...originalRuntimeModule,
  exports: {
    ...jsxRuntime,
    jsx: recordForm(jsxRuntime.jsx),
    jsxs: recordForm(jsxRuntime.jsxs),
  },
};
require.extensions['.tsx'] = (module, filename) => {
  const compiled = transpileModule(readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ModuleKind.CommonJS,
      jsx: JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  });
  (
    module as NodeModule & {
      _compile: (source: string, filename: string) => void;
    }
  )._compile(compiled.outputText, filename);
};
after(() => {
  require.cache[swrPath] = originalSwrModule;
  require.cache[runtimePath] = originalRuntimeModule;
  require.extensions['.tsx'] = previousTsx;
  unregister();
});

describe('Fresh V2 settings presentation', () => {
  const data = {
    enabled: true,
    baseUrl: 'https://autobrr.test',
    filterId: 7,
    cachedFilterName: 'Fresh Filter',
    freshVisibilityDays: 90,
    apiTokenConfigured: true,
  };
  it('uses the standard settings hostname grid and protocol group for HTTP and HTTPS without changing Port', async () => {
    const { FreshSettingsForm } = await import('./index');
    for (const protocol of ['http', 'https']) {
      const markup = renderToStaticMarkup(
        createElement(
          IntlProvider,
          { locale: 'en' },
          createElement(FreshSettingsForm, {
            data: { ...data, baseUrl: `${protocol}://autobrr.test:7474` },
            filters: [],
            onSave: async () => undefined,
            onTest: async () => undefined,
            onFilters: async () => undefined,
          })
        )
      );
      assert.match(
        markup,
        /<div class="form-row"><label for="fresh-hostname" class="text-label">Hostname or IP Address<span class="label-required" aria-hidden="true">\*<\/span><\/label><div class="form-input-area"><div class="form-input-field">/
      );
      assert.ok(
        markup.includes(`<span class="protocol">${protocol}://</span>`)
      );
      const hostname = markup.match(/<input\b[^>]*name="hostname"[^>]*>/)?.[0];
      assert.ok(hostname);
      assert.match(hostname, /class="rounded-r-only"/);
      assert.match(hostname, /inputMode="url"/);
      assert.match(hostname, /value="autobrr.test"/);
      const port = markup.match(/<input\b[^>]*name="port"[^>]*>/)?.[0];
      assert.ok(port);
      assert.match(port, /class="short rounded-md /);
      assert.match(port, /value="7474"/);
    }
  });
  it('loads health on opening without a Refresh Status control or polling, and revalidates after a successful save', async () => {
    const { default: SettingsFresh, toFreshSettingsDraft } =
      await import('./index');
    const { toFreshSettingsUpdate } = await import('./settingsFresh');
    settingsData = data;
    statusData = {
      status: 'ready',
      refreshing: false,
      backfillComplete: true,
      itemCount: 2,
      pendingWork: 0,
    };
    swrCalls.length = 0;
    revalidations.length = 0;
    const render = () =>
      renderToStaticMarkup(
        createElement(
          IntlProvider,
          { locale: 'en' },
          createElement(SettingsFresh)
        )
      );
    const markup = render();
    assert.match(markup, /Synchronization/);
    assert.match(markup, /Up to date/);
    assert.doesNotMatch(markup, /Refresh Status/);
    const healthReads = swrCalls.filter(
      (call) => call.key === '/api/v1/settings/fresh/status'
    );
    assert.equal(healthReads.length, 1);
    assert.equal(
      healthReads[0].options,
      undefined,
      'keep ordinary SWR loading/revalidation; no polling options'
    );
    assert.ok(formCallbacks);
    assert.deepEqual(formCallbacks.health, statusData);
    const put = mock.method(axios, 'put', async () => ({ data: {} }));
    const post = mock.method(axios, 'post', () =>
      assert.fail(
        'status must not test connection, load filters or run synchronization'
      )
    );
    try {
      const update = toFreshSettingsUpdate(toFreshSettingsDraft(data));
      await formCallbacks.onSave(update);
      assert.equal(put.mock.calls.length, 1);
      assert.deepEqual(put.mock.calls[0].arguments, [
        '/api/v1/settings/fresh',
        update,
      ]);
      assert.deepEqual(revalidations, [
        '/api/v1/settings/fresh',
        '/api/v1/settings/fresh/status',
      ]);
      assert.equal(post.mock.calls.length, 0);
      statusData = undefined;
      assert.match(render(), /Temporarily unavailable/);
      assert.doesNotMatch(render(), /Refresh Status/);
    } finally {
      put.mock.restore();
      post.mock.restore();
      settingsData = undefined;
      statusData = undefined;
    }
  });
  it('renders Fresh with inline enablement, standard dark settings fields and separate content filters', async () => {
    const { FreshSettingsForm } = await import('./index');
    const markup = renderToStaticMarkup(
      createElement(
        IntlProvider,
        { locale: 'en' },
        createElement(FreshSettingsForm, {
          data,
          filters: [{ id: 7, name: 'Fresh Filter' }],
          health: {
            status: 'preparing',
            refreshing: false,
            itemCount: 2,
            backfillComplete: false,
            pendingWork: 3,
          },
          onSave: async () => undefined,
          onTest: async () => undefined,
          onFilters: async () => undefined,
        })
      )
    );
    assert.match(markup, /aria-label="Enable Fresh"/);
    assert.match(markup, /aria-checked="true"/);
    assert.match(markup, />Fresh<\/h3>/);
    assert.match(
      markup,
      /Automatically discover Movies and Series from an approved autobrr filter\./
    );
    assert.match(
      markup,
      /flex items-center justify-between gap-4[^]*?<h3[^]*?aria-label="Enable Fresh"/
    );
    assert.match(markup, /fresh-hostname/);
    assert.match(markup, /fresh-port/);
    assert.match(markup, /Use SSL/);
    assert.match(markup, /fresh-api-token/);
    assert.match(markup, /fresh-filter/);
    assert.match(markup, /Fresh Visibility/);
    assert.match(markup, /name="freshVisibilityDays"[^>]*value="90"/);
    assert.match(markup, /Test Connection &amp; Load Filters/);
    assert.match(markup, /Fresh Content Filters/);
    assert.match(markup, /aria-label="Exclude Genres"/);
    assert.match(markup, /aria-label="Exclude Original Languages"/);
    assert.match(markup, /Minimum TMDB Score/);
    assert.match(markup, /Minimum TMDB Votes/);
    assert.ok(
      markup.indexOf('Test Connection &amp; Load Filters') <
        markup.indexOf('id="fresh-filter"')
    );
    assert.ok(
      markup.indexOf('Fresh Content Filters') >
        markup.indexOf('fresh-visibility')
    );
    assert.match(markup, /Processing release history/);
    assert.equal((markup.match(/class="form-row"/g) ?? []).length, 11);
    assert.equal((markup.match(/class="form-input-area"/g) ?? []).length, 11);
    const numericInputs = (markup.match(/<input\b[^>]*>/g) ?? []).filter(
      (tag) => /inputMode="(?:numeric|decimal)"/.test(tag)
    );
    assert.equal(numericInputs.length, 4);
    for (const tag of numericInputs) {
      assert.match(tag, /bg-gray-700/);
      assert.match(tag, /text-white/);
      assert.match(tag, /border-gray-500/);
      assert.match(tag, /class="short /);
      assert.match(tag, /type="text"/);
    }
    for (const classAttribute of markup.matchAll(/class="([^"]*)"/g)) {
      assert.equal(
        classAttribute[1].split(' ').includes('form-input'),
        false,
        'wrapper must not receive Tailwind forms input styling'
      );
    }
    assert.doesNotMatch(
      markup,
      /Needs Attention|Reviewable|Candidate|Override|Rebuild|Eligibility/
    );
    const labels = [
      ...markup.matchAll(
        /<label\b[^>]*for="([^"]+)"[^>]*>([\s\S]*?)<\/label>/g
      ),
    ];
    assert.deepEqual(
      labels
        .filter((label) => label[2].includes('label-required'))
        .map((label) => label[1]),
      ['fresh-hostname', 'fresh-port', 'fresh-api-token', 'fresh-filter']
    );
    assert.equal((markup.match(/class="label-required"/g) ?? []).length, 4);
    const tokenInput = (markup.match(/<input\b[^>]*>/g) ?? []).find((tag) =>
      tag.includes('name="apiToken"')
    );
    assert.ok(tokenInput);
    assert.match(tokenInput, /Token configured; leave blank to keep it/);
    assert.doesNotMatch(tokenInput, /\brequired(?:="[^"]*")?(?:\s|\/?>)/);
  });
  it('validates and casts text-style numeric drafts without changing ranges or blank-token replacement semantics', async () => {
    const { createFreshSettingsValidation, toFreshSettingsDraft } =
      await import('./index');
    const { toFreshSettingsUpdate } = await import('./settingsFresh');
    const schema = createFreshSettingsValidation('Enter a valid value.');
    const draft = {
      ...toFreshSettingsDraft(data),
      port: '7474',
      freshVisibilityDays: '88',
      minimumTmdbScore: '7.5',
      minimumTmdbVotes: '100',
      apiToken: '',
    };
    const validated = await schema.validate(draft);
    const update = toFreshSettingsUpdate(
      validated as ReturnType<typeof toFreshSettingsDraft>
    );
    assert.equal(update.baseUrl, 'https://autobrr.test:7474');
    assert.equal(update.freshVisibilityDays, 88);
    assert.equal(update.minimumTmdbScore, 7.5);
    assert.equal(update.minimumTmdbVotes, 100);
    assert.equal(update.apiToken, '');
    for (const [field, validValues, invalidValues] of [
      ['port', ['1', '65535'], ['', '0', '65536', '1.5', 'bad']],
      ['freshVisibilityDays', ['1', '90'], ['', '0', '91', '1.5', 'bad']],
      ['minimumTmdbScore', ['0', '7.5', '10'], ['', '-1', '10.1', '7junk']],
      [
        'minimumTmdbVotes',
        ['0', '100', String(Number.MAX_SAFE_INTEGER)],
        ['', '-1', '1.5', String(Number.MAX_SAFE_INTEGER + 1), 'bad'],
      ],
    ] as const) {
      for (const value of validValues)
        assert.equal(
          await schema.isValid({ ...draft, [field]: value }),
          true,
          `${field}=${value}`
        );
      for (const value of invalidValues)
        assert.equal(
          await schema.isValid({ ...draft, [field]: value }),
          false,
          `${field}=${value}`
        );
    }
  });
  it('never puts stored credentials into the settings draft', async () => {
    const { toFreshSettingsDraft } = await import('./index');
    assert.equal(toFreshSettingsDraft(data).apiToken, '');
    assert.equal(toFreshSettingsDraft(data).filterId, 7);
    const draft = toFreshSettingsDraft(data);
    assert.equal(draft.hostname, 'autobrr.test');
    assert.equal(draft.port, 443);
    assert.equal(draft.ssl, true);
    assert.equal(draft.freshVisibilityDays, 90);
    assert.deepEqual(draft.excludeGenreIds, []);
    assert.deepEqual(draft.excludeOriginalLanguages, []);
    assert.equal(draft.minimumTmdbScore, 0);
    assert.equal(draft.minimumTmdbVotes, 0);
  });
  it('round-trips connection paths, IPv6, visibility and canonical content settings without UI-only fields', async () => {
    const { toFreshSettingsDraft, toFreshSettingsUpdate } =
      await import('./settingsFresh');
    for (const baseUrl of [
      'http://autobrr.test:7474/base',
      'https://autobrr.test/path',
      'http://[::1]:7474',
    ]) {
      const draft = toFreshSettingsDraft({
        ...data,
        baseUrl,
        excludeGenreIds: [16, 10762, 10766],
        excludeOriginalLanguages: ['hi'],
        minimumTmdbScore: 7,
        minimumTmdbVotes: 100,
      });
      const update = toFreshSettingsUpdate(draft);
      assert.equal(update.baseUrl, baseUrl);
      assert.equal(update.freshVisibilityDays, 90);
      assert.deepEqual(update.excludeOriginalLanguages, ['hi']);
      assert.deepEqual(update.excludeGenreIds, [16, 10762, 10766]);
      assert.equal(update.minimumTmdbScore, 7);
      assert.equal(update.minimumTmdbVotes, 100);
      assert.equal('hostname' in update, false);
      assert.equal('ssl' in update, false);
    }
    assert.throws(() =>
      toFreshSettingsUpdate({
        ...toFreshSettingsDraft(data),
        hostname: 'user@host',
      })
    );
    assert.throws(() =>
      toFreshSettingsUpdate({ ...toFreshSettingsDraft(data), port: 0 })
    );
  });
  it('renders disabled and unavailable health truthfully without new work queues', async () => {
    const { FreshSettingsForm } = await import('./index');
    const markup = renderToStaticMarkup(
      createElement(
        IntlProvider,
        { locale: 'en' },
        createElement(FreshSettingsForm, {
          data: { ...data, enabled: false },
          filters: [],
          onSave: async () => undefined,
          onTest: async () => undefined,
          onFilters: async () => undefined,
        })
      )
    );
    assert.match(markup, /aria-checked="false"/);
    assert.match(markup, /Temporarily unavailable/);
    assert.match(markup, /Fresh Filter/);
  });
});
