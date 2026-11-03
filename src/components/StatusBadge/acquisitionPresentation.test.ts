import { MediaStatus, MediaType } from '@server/constants/media';
import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import { acquisitionDownload } from '@server/test/acquisitionFixtures';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import { createElement, type ComponentType, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { IntlProvider } from 'react-intl';
import ts from 'typescript';
// Client aliases are not available in the node:test server tsconfig.
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import {
  observeAcquisitionDownloads,
  type AcquisitionObservation,
} from '../../utils/acquisitionObservation';
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import { getAcquisitionPresentation } from '../../utils/acquisitionPresentation';
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import type { DownloadTitleItem } from '../../utils/downloadTitle';

const nativeRequire = createRequire(__filename);
const cache = new Map<string, object>();
const moduleExport = (value: unknown) => ({ __esModule: true, default: value });
let observation: AcquisitionObservation | undefined;
let administrator = false;
function load(filename: string): object {
  if (cache.has(filename)) return cache.get(filename)!;
  const source = readFileSync(filename, 'utf8');
  const exports = {};
  cache.set(filename, exports);
  runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
      },
    }).outputText,
    {
      exports,
      Date,
      require: (id: string) => {
        if (id === '@app/assets/spinner.svg')
          return moduleExport(() => createElement('svg'));
        if (id === '@app/hooks/useUser')
          return {
            Permission: nativeRequire('@server/lib/permissions').Permission,
            useUser: () => ({ hasPermission: () => administrator }),
          };
        // This SSR fixture tests rendered presentation, not effects. The real
        // React hook/SWR lifecycle is covered by acquisitionObservation.browser.ts.
        if (id === '@app/hooks/useAcquisitionPresentation')
          return moduleExport((rows: Row[], scope: string, sample: object) => {
            observation = observeAcquisitionDownloads(
              rows,
              scope,
              sample,
              false,
              observation
            );
            return getAcquisitionPresentation(rows, observation.advancing);
          });
        if (id === '@app/hooks/useSettings')
          return moduleExport(() => ({ currentSettings: {} }));
        if (id === '@app/components/Common/Tooltip')
          return moduleExport(
            ({
              children,
              content,
            }: {
              children: ReactNode;
              content: ReactNode;
            }) =>
              createElement(
                'section',
                null,
                children,
                createElement('aside', null, content)
              )
          );
        if (id === 'next/link') return moduleExport(() => null);
        const local = id.startsWith('@app/')
          ? path.join(__dirname, '../..', id.slice(5))
          : id.startsWith('.')
            ? path.resolve(path.dirname(filename), id)
            : undefined;
        if (local) {
          for (const suffix of ['.tsx', '.ts', '/index.tsx']) {
            try {
              return load(local + suffix);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
            }
          }
          throw new Error(`Missing fixture module ${id}`);
        }
        return nativeRequire(id);
      },
    }
  );
  return exports;
}
type Row = ReturnType<typeof acquisitionDownload>;
const StatusBadge = (
  load(path.join(__dirname, 'index.tsx')) as {
    default: ComponentType<{
      status: MediaStatus;
      inProgress: boolean;
      mediaType: 'tv';
      downloadItem: Row[];
    }>;
  }
).default;
function render(rows: Row[], status = MediaStatus.PROCESSING) {
  // Explicit preceding byte sample for the synthetic progressing rows.
  observation = observeAcquisitionDownloads(
    rows.map((row) => ({
      ...row,
      sizeLeft: Math.min(row.size, row.sizeLeft + 1),
    })),
    JSON.stringify([undefined, 'tv', undefined, false, undefined]),
    {},
    false
  );
  const markup = renderToStaticMarkup(
    createElement(
      IntlProvider,
      { locale: 'en' },
      createElement(StatusBadge, {
        status,
        inProgress: true,
        mediaType: 'tv',
        downloadItem: rows,
      })
    )
  );
  return {
    badge: markup.split('<aside>')[0],
    detail: markup.split('<aside>')[1],
  };
}

describe('rendered acquisition StatusBadge and detailed entries', () => {
  const waiting = acquisitionDownload(1, {
    status: 'queued',
    timeLeft: '00:00:00',
  });
  const active = acquisitionDownload(2, { sizeLeft: 230 });
  for (const status of [
    MediaStatus.PROCESSING,
    MediaStatus.PARTIALLY_AVAILABLE,
    MediaStatus.AVAILABLE,
    MediaStatus.DELETED,
  ]) {
    it(`uses one representative for phase, Episode, accessible progress and width at media status ${status}`, () => {
      const { badge, detail } = render([waiting, active], status);
      assert.match(badge, /Downloading/);
      assert.match(badge, /S1E2/);
      assert.doesNotMatch(badge, /S1E1/);
      assert.match(badge, /aria-label="Downloading S1E2"/);
      assert.match(badge, /aria-valuenow="77"/);
      assert.match(badge, /width:77%/);
      assert.equal((detail.match(/<li /g) ?? []).length, 2);
      assert.match(detail, /Season 1 Episode 1/);
      assert.match(detail, /Season 1 Episode 2/);
    });
  }
  it('updates label and percentage together when a representative disappears or is replaced', () => {
    assert.match(render([waiting, active]).badge, /aria-valuenow="77"/);
    const next = render([acquisitionDownload(3, { sizeLeft: 880 })]).badge;
    assert.match(next, /S1E3/);
    assert.match(next, /aria-valuenow="12"/);
    assert.doesNotMatch(next, /S1E2|77%/);
    assert.doesNotMatch(
      render([], MediaStatus.AVAILABLE).badge,
      /progressbar|Finalizing|S1E/
    );
  });
  it('keeps Finalizing indeterminate without inventing a completed percentage', () => {
    const { badge, detail } = render([
      acquisitionDownload(1, {
        acquisitionPhase: AcquisitionPhase.FINALIZING,
        sizeLeft: 0,
      }),
    ]);
    assert.match(badge, /Finalizing S1E1/);
    assert.match(badge, /animate-pulse/);
    assert.doesNotMatch(badge, /aria-valuenow/);
    assert.doesNotMatch(detail, />100%<|>0%</);
  });
  it('does not call a queued row Downloading and does not invent invalid progress', () => {
    const { badge } = render([waiting]);
    assert.match(badge, /Searching \/ Waiting/);
    assert.doesNotMatch(badge, /Downloading/);
    const invalid = render([
      acquisitionDownload(1, { size: 0, sizeLeft: 0 }),
    ]).badge;
    assert.doesNotMatch(invalid, /aria-valuenow|NaN|Infinity/);
  });
  it('retains shared-pack Season labeling and its single detailed pack entry', () => {
    const rows = [
      acquisitionDownload(1, { downloadId: 'pack' }),
      acquisitionDownload(2, { downloadId: 'pack' }),
    ];
    const { badge, detail } = render(rows);
    assert.match(badge, />S1</);
    assert.doesNotMatch(badge, /S1E/);
    assert.equal((detail.match(/role="progressbar"/g) ?? []).length, 1);
  });
});

const downloadModule = load(
  path.join(__dirname, '../DownloadBlock/index.tsx')
) as {
  default: ComponentType<{ downloadItem: DownloadTitleItem; title?: string }>;
  useDownloadTitle: () => (item: DownloadTitleItem, title?: string) => string;
};
const renderDownload = (
  row: DownloadTitleItem,
  admin: boolean,
  title = 'Synthetic Series'
) => {
  administrator = admin;
  try {
    return renderToStaticMarkup(
      createElement(
        IntlProvider,
        { locale: 'en' },
        createElement(downloadModule.default, { downloadItem: row, title })
      )
    );
  } finally {
    administrator = false;
  }
};
const finalizing = (
  changes: Partial<DownloadTitleItem> = {}
): DownloadTitleItem => ({
  ...acquisitionDownload(1, {
    title: '',
    acquisitionPhase: AcquisitionPhase.FINALIZING,
    size: 0,
    sizeLeft: 0,
  }),
  episode: {
    id: 101,
    seasonNumber: 1,
    episodeNumber: 1,
    absoluteEpisodeNumber: 1,
    title: 'Synthetic Episode',
  },
  ...changes,
});

describe('rendered Finalizing identity and existing download titles', () => {
  for (const admin of [true, false]) {
    it(`renders Finalizing coordinates/title with matching native tooltip (admin=${admin})`, () => {
      const markup = renderDownload(finalizing(), admin);
      assert.match(markup, /title="S01E01 — Synthetic Episode"/);
      assert.match(markup, />S01E01 — Synthetic Episode<\/div>/);
      assert.match(markup, /Finalizing/);
      assert.doesNotMatch(markup, /aria-valuenow|NaN|undefined/);
    });
    it(`falls back to coordinates, then known Series without invented hints (admin=${admin})`, () => {
      const row = finalizing();
      assert.match(
        renderDownload(
          { ...row, episode: { ...row.episode!, title: undefined } },
          admin
        ),
        /title="S01E01"/
      );
      assert.match(
        renderDownload({ ...row, episode: undefined }, admin),
        /title="Synthetic Series"/
      );
      assert.doesNotMatch(
        renderDownload({ ...row, episode: undefined }, admin),
        /S00E00|S01E01|undefined/
      );
    });
    it(`retains regular Specials Episode coordinates (admin=${admin})`, () => {
      const row = finalizing();
      assert.match(
        renderDownload(
          { ...row, episode: { ...row.episode!, seasonNumber: 0 } },
          admin
        ),
        /S00E01 — Synthetic Episode/
      );
    });
  }
  it('preserves valid admin release titles even when an Episode title exists', () => {
    assert.match(
      renderDownload(finalizing({ title: 'Synthetic.Release.S01E01' }), true),
      /title="Synthetic.Release.S01E01"/
    );
    assert.doesNotMatch(
      renderDownload(finalizing({ title: 'Synthetic.Release.S01E01' }), true),
      /— Synthetic Episode/
    );
  });
  it('preserves non-admin normal Season/Episode formatting without exposing a release name', () => {
    const markup = renderDownload(
      acquisitionDownload(1, { title: 'Private.Release.Name' }),
      false
    );
    assert.match(markup, /Synthetic Series: Season 1 Episode 1/);
    assert.doesNotMatch(markup, /Private.Release.Name/);
  });
  it('keeps Movie titles and indeterminate Finalizing presentation', () => {
    const row = finalizing({
      mediaType: MediaType.MOVIE,
      episode: undefined,
      title: 'Synthetic Movie Release',
    });
    assert.match(
      renderDownload(row, true, 'Synthetic Movie'),
      /title="Synthetic Movie Release"/
    );
    assert.match(
      renderDownload(row, false, 'Synthetic Movie'),
      /title="Synthetic Movie"/
    );
    assert.doesNotMatch(
      renderDownload(row, false, 'Synthetic Movie'),
      /S01E|aria-valuenow/
    );
  });
  it('does not invent a range for a shared multi-Episode pack', () => {
    const row = finalizing({ downloadId: 'pack' });
    assert.match(renderDownload(row, true), /S01E01 — Synthetic Episode/);
    assert.doesNotMatch(renderDownload(row, true), /E01-E|Episodes 1-/);
  });
  it('uses the identical label formatter in the Manage tooltip and DownloadBlock', () => {
    const source = readFileSync(
      path.join(__dirname, '../ManageSlideOver/index.tsx'),
      'utf8'
    );
    assert.equal(
      (source.match(/content=\{downloadTitle\(status, mediaTitle\)\}/g) ?? [])
        .length,
      2
    );
    assert.equal((source.match(/title=\{mediaTitle\}/g) ?? []).length, 2);
    const Probe = () =>
      createElement(
        'span',
        null,
        downloadModule.useDownloadTitle()(finalizing(), 'Synthetic Series')
      );
    const markup = renderToStaticMarkup(
      createElement(IntlProvider, { locale: 'en' }, createElement(Probe))
    );
    assert.match(markup, /S01E01 — Synthetic Episode/);
  });
});
