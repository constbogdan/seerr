import { MediaStatus } from '@server/constants/media';
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

const nativeRequire = createRequire(__filename);
const cache = new Map<string, object>();
const moduleExport = (value: unknown) => ({ __esModule: true, default: value });
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
            useUser: () => ({ hasPermission: () => false }),
          };
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
