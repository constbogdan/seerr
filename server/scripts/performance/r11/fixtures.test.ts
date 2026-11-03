import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  R11_BROWSER_REPETITIONS,
  R11_BULK_SIZES,
  R11_PAGE_SIZES,
  R11_VIEWPORT_WIDTHS,
  createR11LibraryItems,
  createR11SeriesDetail,
  createR11WatchlistPage,
  r11BulkFixtureCase,
} from './fixtures';

describe('R11 deterministic performance fixtures', () => {
  it('creates engagement-heavy Library workloads at every accepted size', () => {
    for (const size of R11_PAGE_SIZES) {
      const items = createR11LibraryItems(size);
      assert.equal(items.length, size);
      assert.equal(
        new Set(items.map(({ canonicalMediaId }) => canonicalMediaId)).size,
        size
      );
      for (const item of items) {
        assert.equal(item.watchlistUsers.length, 6);
        assert.equal(item.lastActiveUsers.length, 6);
        assert.equal(item.watchedUsers.length, 4);
        assert.equal(item.requesters.length, 3);
        assert.deepEqual(
          item.externalLinks.map(({ label }) => label),
          item.mediaType === 'series'
            ? ['Sonarr', 'Sonarr 4K']
            : ['Radarr', 'Radarr 4K']
        );
        if (item.mediaType === 'series')
          assert.equal(item.seasonSummaries.length, 6);
      }
      assert.ok(items.some(({ collection }) => collection));
    }
  });

  it('provides deterministic expanded Series attribution data', () => {
    const detail = createR11SeriesDetail(2);
    assert.equal(detail.canonicalMediaId, 2);
    assert.equal(detail.seasons.length, 6);
    detail.seasons.forEach((season, index) => {
      assert.equal(season.seasonNumber, index + 1);
      assert.equal(season.users.length, 4);
      assert.ok(season.sizeBytes);
    });
  });

  it('keeps every bulk prefix mixed and the ten-case outcome pattern stable', () => {
    for (const size of R11_BULK_SIZES) {
      const cases = Array.from({ length: size }, (_, index) =>
        r11BulkFixtureCase(index)
      );
      assert.deepEqual(
        new Set(cases.map(({ targetType }) => targetType)),
        new Set(['movie', 'series', 'season'])
      );
      assert.equal(
        cases.filter(({ expectedReason }) => expectedReason === 'unscheduled')
          .length,
        size * 0.4
      );
      assert.equal(
        cases.filter(({ expectedReason }) => expectedReason === 'scheduled')
          .length,
        size * 0.1
      );
      assert.equal(
        cases.filter(
          ({ expectedReason }) => expectedReason === 'processing_lease'
        ).length,
        size * 0.1
      );
    }
  });

  it('keeps the Watchlist and viewport workloads deterministic', () => {
    const identities = new Set<number>();
    for (let page = 1; page <= 3; page += 1) {
      const response = createR11WatchlistPage(page);
      assert.equal(response.results.length, 20);
      response.results.forEach(({ id }) => identities.add(id));
    }
    assert.equal(identities.size, 60);
    assert.deepEqual(R11_VIEWPORT_WIDTHS, [390, 640, 900, 1440]);
  });

  it('preserves a complete baseline for every accepted workload', () => {
    const baseline = JSON.parse(
      readFileSync(join(__dirname, 'baseline.json'), 'utf8')
    ) as {
      schemaVersion: number;
      bulkEligibility: {
        targetCount: number;
        queryCount: number;
        outcomeCounts: Record<string, number>;
        latencyMilliseconds: { samples: number[] };
      }[];
      libraryBrowser: {
        cardCount: number;
        samples: unknown[];
      }[];
      responsive: { width: number; overflowPixels: number }[];
      tmdb: {
        cold: { requests: number };
        warm: { additionalRequests: number };
        concurrentDuplicate: { callers: number; requests: number };
        delayedResponse: { completedWithoutTimeout: boolean };
        boundedTimeoutControl: { timedOut: boolean };
      };
    };

    assert.equal(baseline.schemaVersion, 1);
    assert.deepEqual(
      baseline.bulkEligibility.map(({ targetCount }) => targetCount),
      R11_BULK_SIZES
    );
    baseline.bulkEligibility.forEach((result) => {
      assert.ok(result.queryCount > 0);
      assert.equal(result.latencyMilliseconds.samples.length, 7);
      assert.equal(
        Object.values(result.outcomeCounts).reduce(
          (total, count) => total + count,
          0
        ),
        result.targetCount
      );
    });
    assert.deepEqual(
      baseline.libraryBrowser.map(({ cardCount }) => cardCount),
      R11_PAGE_SIZES
    );
    baseline.libraryBrowser.forEach(({ samples }) =>
      assert.equal(samples.length, R11_BROWSER_REPETITIONS)
    );
    assert.deepEqual(
      baseline.responsive.map(({ width }) => width),
      R11_VIEWPORT_WIDTHS
    );
    assert.equal(baseline.tmdb.cold.requests, 1);
    assert.equal(baseline.tmdb.warm.additionalRequests, 0);
    assert.equal(baseline.tmdb.concurrentDuplicate.callers, 10);
    assert.equal(baseline.tmdb.concurrentDuplicate.requests, 10);
    assert.equal(baseline.tmdb.delayedResponse.completedWithoutTimeout, true);
    assert.equal(baseline.tmdb.boundedTimeoutControl.timedOut, true);

    const browserBaseline = JSON.parse(
      readFileSync(join(__dirname, 'browser-baseline-turbopack.json'), 'utf8')
    ) as {
      schemaVersion: number;
      authority: string;
      buildAndRuntimeAssertions: {
        externalLinksPerCard: number;
        externalLinksUseSvg: boolean;
        runtimeErrorCount: number;
      };
      libraryBrowser: {
        cardCount: number;
        externalServiceLinks: number;
        samples: { runtimeErrorCount: number }[];
      }[];
      responsive: { width: number; overflowPixels: number }[];
    };
    assert.equal(browserBaseline.schemaVersion, 2);
    assert.equal(browserBaseline.authority, 'supported-production-turbopack');
    assert.equal(
      browserBaseline.buildAndRuntimeAssertions.externalLinksUseSvg,
      true
    );
    assert.equal(
      browserBaseline.buildAndRuntimeAssertions.externalLinksPerCard,
      2
    );
    assert.equal(
      browserBaseline.buildAndRuntimeAssertions.runtimeErrorCount,
      0
    );
    assert.deepEqual(
      browserBaseline.libraryBrowser.map(({ cardCount }) => cardCount),
      R11_PAGE_SIZES
    );
    browserBaseline.libraryBrowser.forEach(
      ({ cardCount, externalServiceLinks, samples }) => {
        assert.equal(externalServiceLinks, cardCount * 2);
        assert.equal(samples.length, R11_BROWSER_REPETITIONS);
        assert.ok(samples.every(({ runtimeErrorCount }) => !runtimeErrorCount));
      }
    );
    assert.deepEqual(
      browserBaseline.responsive.map(({ width }) => width),
      R11_VIEWPORT_WIDTHS
    );
  });
});
