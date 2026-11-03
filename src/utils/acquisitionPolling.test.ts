import { MediaRequestStatus, MediaStatus } from '@server/constants/media';
import { AcquisitionPhase } from '@server/lib/acquisitionPhase';
import { acquisitionDownload } from '@server/test/acquisitionFixtures';
import {
  acquisitionHookSource,
  acquisitionSurfaces,
} from '@server/test/acquisitionPolling';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { observeAcquisitionDownloads } from './acquisitionObservation';
import { getAcquisitionPresentation } from './acquisitionPresentation';
import {
  getMediaRefreshInterval,
  getRequestDownloadStatus,
  getRequestRefreshInterval,
} from './refreshIntervalHelper';

const approved = {
  id: 71,
  status: MediaRequestStatus.APPROVED,
  type: 'tv',
  is4k: false,
  seasons: [{ seasonNumber: 1, status: MediaRequestStatus.APPROVED }],
  media: {
    status: MediaStatus.PROCESSING,
    status4k: MediaStatus.UNKNOWN,
    downloadStatus: [] as ReturnType<typeof acquisitionDownload>[],
    downloadStatus4k: [] as ReturnType<typeof acquisitionDownload>[],
  },
};
const active = {
  ...approved,
  media: { ...approved.media, downloadStatus: [acquisitionDownload()] },
};
const finalizing = {
  ...active,
  media: {
    ...active.media,
    downloadStatus: [
      acquisitionDownload(1, {
        acquisitionPhase: AcquisitionPhase.FINALIZING,
        sizeLeft: 0,
      }),
    ],
  },
};
const completed = {
  ...approved,
  status: MediaRequestStatus.COMPLETED,
  media: { ...approved.media, status: MediaStatus.AVAILABLE },
};

type Options = {
  fallbackData: unknown;
  refreshInterval: (latest?: unknown) => number;
  compare?: (left: unknown, right: unknown) => boolean;
};
type Surface = keyof typeof acquisitionSurfaces;
function options(surface: Surface, parent = approved, route = 200) {
  const exports: { default?: (context: object) => Options } = {};
  runInNewContext(
    ts.transpileModule(`export default ${acquisitionHookSource(surface)}`, {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    { exports, require: createRequire(__filename) }
  );
  const details = { id: 200, mediaInfo: parent.media };
  const key = ['/api/v1/tv/200', 'owner-specific-cache-key'];
  let calls = 0;
  const result = exports.default!({
    request: parent,
    movie: details,
    tv: details,
    routeMovieId: route,
    routeTvId: route,
    detailsCacheKey: key,
    getRequestRefreshInterval,
    getMediaRefreshInterval,
    useSWR: (actualKey: unknown, ...args: unknown[]) => {
      calls++;
      assert.deepEqual(
        actualKey,
        surface.startsWith('Request') ? '/api/v1/request/71' : key
      );
      return args.at(-1);
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(result).sort(), [
    ...(surface === 'MovieDetails' ? [] : ['compare']),
    'fallbackData',
    'refreshInterval',
  ]);
  return result;
}
const latest = (surface: Surface, request: typeof approved) =>
  surface.startsWith('Request')
    ? request
    : { id: 200, mediaInfo: request.media };

// Execute the real JSX bindings, including RequestCard/RequestItem error views,
// so a regression to a response-object or filtered-array token fails this test.
function observationSamples(surface: Surface, request: typeof approved) {
  const filename = path.join(__dirname, '../..', acquisitionSurfaces[surface]);
  const source = ts.createSourceFile(
    filename,
    readFileSync(filename, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX
  );
  const samples: object[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isJsxAttribute(node) &&
      node.name.getText(source) === 'acquisitionObservation' &&
      node.initializer &&
      ts.isJsxExpression(node.initializer) &&
      node.initializer.expression
    ) {
      samples.push(
        runInNewContext(`(${node.initializer.expression.getText(source)})`, {
          requestData: request,
          data: { id: 200, mediaInfo: request.media },
        })
      );
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.equal(samples.length, 2);
  return samples;
}

describe('actual acquisition queue observation bindings', () => {
  for (const surface of ['TvDetails', 'RequestCard', 'RequestItem'] as const) {
    for (const is4k of [false, true]) {
      it(`${surface}: ${is4k ? '4K' : 'standard'} metadata-only projections preserve activity, fresh unchanged queues clear it`, () => {
        const quality = is4k ? 'downloadStatus4k' : 'downloadStatus';
        const finalizingRow = acquisitionDownload(1, {
          acquisitionPhase: AcquisitionPhase.FINALIZING,
          sizeLeft: 0,
        });
        const unrelatedRow = acquisitionDownload(3, {
          episode: {
            id: 203,
            seasonNumber: 2,
            episodeNumber: 3,
            absoluteEpisodeNumber: 13,
          },
        });
        const fixture = (sizeLeft: number) => ({
          ...approved,
          is4k,
          media: {
            ...approved.media,
            [quality]: [
              finalizingRow,
              acquisitionDownload(2, { sizeLeft }),
              unrelatedRow,
            ],
          },
        });
        const first = fixture(500);
        const moving = fixture(100);
        const projected = {
          ...moving,
          onUserWatchlist: true,
          media: { ...moving.media },
        };
        const fresh = JSON.parse(JSON.stringify(projected)) as typeof moving;
        const bindingIndexes =
          surface === 'TvDetails' ? [is4k ? 1 : 0] : [0, 1];
        for (const index of bindingIndexes) {
          const token = (response: typeof moving) =>
            observationSamples(surface, response)[index];
          const rows = (response: typeof moving) =>
            getRequestDownloadStatus(response.media[quality], [1]);
          const scope = `${surface}:${is4k}`;
          const initial = observeAcquisitionDownloads(
            rows(first),
            scope,
            token(first),
            false
          );
          const active = observeAcquisitionDownloads(
            rows(moving),
            scope,
            token(moving),
            false,
            initial
          );
          const projection = observeAcquisitionDownloads(
            rows(projected),
            scope,
            token(projected),
            false,
            active
          );
          assert.equal(projection, active);
          const result = getAcquisitionPresentation(
            rows(projected),
            projection.advancing
          );
          assert.equal(result.phase, AcquisitionPhase.DOWNLOADING);
          assert.equal(result.item?.episode?.episodeNumber, 2);
          assert.equal(result.progress, 90);
          assert.equal(projection.remaining.size, 1);
          assert.equal(token(projected), projected.media[quality]);
          assert.notEqual(token(fresh), token(projected));
          const unchanged = observeAcquisitionDownloads(
            rows(fresh),
            scope,
            token(fresh),
            false,
            projection
          );
          assert.equal(unchanged.advancing.size, 0);
          assert.equal(
            getAcquisitionPresentation(rows(fresh), unchanged.advancing).phase,
            AcquisitionPhase.FINALIZING
          );
        }
      });
    }
  }
});

describe('actual acquisition SWR component configurations', () => {
  for (const surface of ['RequestCard', 'RequestItem', 'TvDetails'] as const) {
    it(`${surface}: observes identical fresh JSON responses without changing the polling cadence`, () => {
      const config = options(surface);
      const sample = {};
      assert.equal(config.compare?.(sample, sample), true);
      assert.equal(config.compare?.({}, {}), false);
      assert.equal(config.refreshInterval(latest(surface, active)), 15_000);
    });
  }
  for (const surface of Object.keys(acquisitionSurfaces) as Surface[]) {
    it(`${surface}: starts from approved empty queue, tracks latest response and stops after cleanup`, () => {
      const config = options(surface);
      assert.equal(config.refreshInterval(), 15_000);
      assert.equal(config.refreshInterval(latest(surface, active)), 15_000);
      assert.equal(config.refreshInterval(latest(surface, finalizing)), 15_000);
      assert.equal(config.refreshInterval(latest(surface, completed)), 0);
      // Calling again with the same authoritative response cannot resurrect the parent.
      assert.equal(config.refreshInterval(latest(surface, completed)), 0);
    });
    it(`${surface}: a terminal parent cannot prevent a newer acquisition response from polling`, () => {
      const config = options(surface, completed);
      assert.equal(config.refreshInterval(), 0);
      assert.equal(config.refreshInterval(latest(surface, active)), 15_000);
    });
    it(`${surface}: stale Finalizing fallback does not outlive an authoritative completed response`, () => {
      const config = options(surface, finalizing);
      assert.equal(config.refreshInterval(), 15_000);
      assert.equal(config.refreshInterval(latest(surface, completed)), 0);
    });
  }
  for (const surface of ['MovieDetails', 'TvDetails'] as const)
    it(`${surface}: never polls using fallback data for another route`, () => {
      const config = options(surface, active, 999);
      assert.equal(config.fallbackData, undefined);
      assert.equal(config.refreshInterval(), 0);
      assert.equal(config.refreshInterval(latest(surface, active)), 15_000);
    });

  it('keeps requested-Season and quality isolation, including completed requests with Finalizing cleanup', () => {
    const otherSeason = acquisitionDownload(2, {
      episode: {
        id: 202,
        seasonNumber: 2,
        episodeNumber: 2,
        absoluteEpisodeNumber: 12,
      },
    });
    const unrelated = {
      ...completed,
      media: {
        ...completed.media,
        downloadStatus: [otherSeason],
        downloadStatus4k: [acquisitionDownload()],
      },
    };
    assert.equal(getRequestRefreshInterval(unrelated, 15_000), 0);
    assert.equal(
      getRequestRefreshInterval({ ...unrelated, is4k: true }, 15_000),
      15_000
    );
    assert.equal(
      getRequestRefreshInterval(
        { ...completed, media: finalizing.media },
        15_000
      ),
      15_000
    );
  });
  it('stops failed, declined, completed and available-Season requests without live rows', () => {
    for (const status of [
      MediaRequestStatus.FAILED,
      MediaRequestStatus.DECLINED,
      MediaRequestStatus.COMPLETED,
    ])
      assert.equal(
        getRequestRefreshInterval({ ...approved, status }, 15_000),
        0
      );
    assert.equal(
      getRequestRefreshInterval(
        {
          ...approved,
          media: {
            ...approved.media,
            seasons: [
              {
                seasonNumber: 1,
                status: MediaStatus.AVAILABLE,
                status4k: MediaStatus.UNKNOWN,
              },
            ],
          },
        },
        15_000
      ),
      0
    );
    assert.equal(
      getMediaRefreshInterval(
        { ...completed.media, requests: [completed] },
        15_000
      ),
      0
    );
  });
});
