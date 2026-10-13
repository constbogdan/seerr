import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { AutomaticRemovalPolicy } from '@server/constants/removal';
import {
  RemovalScheduleOrigin,
  RemovalTargetType,
} from '@server/constants/removal';
import { normalizeLibraryDatabaseDate } from '@server/lib/libraryActivity';
import {
  completeCalendarMonthsBetween,
  currentMonthBounds,
  isAutomaticallyEligible,
  meetsAutomaticRemovalCriteria,
  parseServarrSourceItemId,
  planAutomaticRemovalPool,
  rankRemovalCandidates,
  removalBatchSize,
  subtractCalendarMonths,
  type RemovalCandidate,
} from '@server/lib/removalScheduler';

describe('Servarr Library identity projection', () => {
  it('reads the typed source-item IDs persisted by Library hydration', () => {
    assert.equal(parseServarrSourceItemId('movie:42', 'radarr'), 42);
    assert.equal(parseServarrSourceItemId('series:84', 'sonarr'), 84);
    assert.equal(parseServarrSourceItemId('42', 'radarr'), 42);
    assert.equal(parseServarrSourceItemId('series:84', 'radarr'), null);
    assert.equal(parseServarrSourceItemId('movie:42', 'sonarr'), null);
  });

  it('treats database datetime strings as UTC without substituting now', () => {
    assert.equal(
      normalizeLibraryDatabaseDate('2026-02-14 17:35:59.694')?.toISOString(),
      '2026-02-14T17:35:59.694Z'
    );
    assert.equal(normalizeLibraryDatabaseDate(null), null);
  });
});

const policy: AutomaticRemovalPolicy = {
  enabled: true,
  minimumAgeMonths: 3,
  inactivityMonths: 1,
  itemsPerRun: 10,
};

const candidate = (
  id: number,
  addedAt: string,
  lastActiveAt: string | null = null,
  mediaType: 'movie' | 'series' = 'movie'
): RemovalCandidate => ({
  canonicalMediaId: id,
  mediaType,
  title: `Movie ${id}`,
  year: 2020,
  addedAt: new Date(addedAt),
  lastActiveAt: lastActiveAt ? new Date(lastActiveAt) : null,
  sourceSystem: 'radarr',
  sourceScope: 'service:0',
  serviceId: 0,
  externalServiceId: id,
});

describe('automatic removal limits', () => {
  it('selects only the configured number of eligible items per run', () => {
    assert.equal(removalBatchSize(0, policy), 0);
    assert.equal(removalBatchSize(4, policy), 4);
    assert.equal(removalBatchSize(100, policy), 10);
    assert.equal(removalBatchSize(100, { ...policy, enabled: false }), 0);
    assert.equal(removalBatchSize(100, { ...policy, itemsPerRun: 0 }), 0);
  });
});

describe('current-library month bounds', () => {
  it('uses complete calendar months and excludes partial months', () => {
    assert.equal(
      completeCalendarMonthsBetween(
        new Date('2025-12-18T12:00:00.000Z'),
        new Date('2026-10-06T12:00:00.000Z')
      ),
      9
    );
    assert.equal(
      completeCalendarMonthsBetween(
        new Date('2026-09-06T12:00:00.000Z'),
        new Date('2026-10-06T12:00:00.000Z')
      ),
      1
    );
    assert.equal(
      completeCalendarMonthsBetween(
        new Date('2026-09-07T12:00:00.000Z'),
        new Date('2026-10-06T12:00:00.000Z')
      ),
      0
    );
  });

  it('bounds each media type independently by its oldest Current Added fact', () => {
    const now = new Date('2026-10-06T12:00:00.000Z');
    const values = [
      candidate(1, '2025-12-18T12:00:00.000Z'),
      candidate(2, '2026-01-01T12:00:00.000Z'),
      candidate(3, '2026-04-06T12:00:00.000Z', null, 'series'),
    ];

    assert.deepEqual(currentMonthBounds(values, 'movie', now), {
      oldestCurrentAddedAt: new Date('2025-12-18T12:00:00.000Z'),
      maximumSelectableMonths: 9,
    });
    assert.deepEqual(currentMonthBounds(values, 'series', now), {
      oldestCurrentAddedAt: new Date('2026-04-06T12:00:00.000Z'),
      maximumSelectableMonths: 6,
    });
    assert.deepEqual(currentMonthBounds([], 'movie', now), {
      oldestCurrentAddedAt: null,
      maximumSelectableMonths: 0,
    });
  });
});

describe('automatic removal eligibility and ranking', () => {
  const now = new Date('2026-10-06T00:00:00Z');

  it('uses only Added and Last active, with Added as the inactivity fallback', () => {
    assert.equal(
      isAutomaticallyEligible(
        candidate(1, '2026-01-01T00:00:00Z'),
        policy,
        now
      ),
      true
    );
    assert.equal(
      isAutomaticallyEligible(
        candidate(2, '2026-01-01T00:00:00Z', '2026-10-01T00:00:00Z'),
        policy,
        now
      ),
      false
    );
    assert.equal(
      isAutomaticallyEligible(
        candidate(3, '2026-09-20T00:00:00Z'),
        policy,
        now
      ),
      false
    );
  });

  it('calculates factual criteria while automatic scheduling is disabled', () => {
    const disabled = { ...policy, enabled: false };
    const eligible = candidate(1, '2026-01-01T00:00:00Z');

    assert.equal(meetsAutomaticRemovalCriteria(eligible, disabled, now), true);
    assert.equal(isAutomaticallyEligible(eligible, disabled, now), false);
  });

  it('keeps calendar-month Added and inactivity thresholds inclusive', () => {
    const exact = candidate(1, '2026-07-06T00:00:00Z', '2026-09-06T00:00:00Z');
    assert.equal(meetsAutomaticRemovalCriteria(exact, policy, now), true);

    const oneMonthPolicy = {
      ...policy,
      minimumAgeMonths: 1,
      inactivityMonths: 1,
    };
    const neverActive = candidate(2, '2026-09-06T00:00:00Z');
    assert.equal(
      meetsAutomaticRemovalCriteria(neverActive, oneMonthPolicy, now),
      true
    );
    const active = candidate(3, '2026-01-01T00:00:00Z', '2026-09-06T00:00:00Z');
    assert.equal(
      meetsAutomaticRemovalCriteria(active, oneMonthPolicy, now),
      true
    );
  });

  it('uses calendar arithmetic instead of a 30-day approximation', () => {
    assert.equal(
      subtractCalendarMonths(
        new Date('2026-03-31T12:30:00.000Z'),
        1
      ).toISOString(),
      '2026-02-28T12:30:00.000Z'
    );
    assert.equal(
      meetsAutomaticRemovalCriteria(
        candidate(1, '2026-02-28T12:30:00.000Z'),
        { ...policy, minimumAgeMonths: 1, inactivityMonths: 0 },
        new Date('2026-03-31T12:30:00.000Z')
      ),
      true
    );
  });

  it('ranks longest inactive, then oldest Added, then canonical ID', () => {
    const ranked = rankRemovalCandidates([
      candidate(4, '2025-03-01T00:00:00Z', '2025-05-01T00:00:00Z'),
      candidate(3, '2025-01-01T00:00:00Z', '2025-05-01T00:00:00Z'),
      candidate(2, '2025-01-01T00:00:00Z', '2025-05-01T00:00:00Z'),
      candidate(1, '2025-04-01T00:00:00Z', '2025-04-15T00:00:00Z'),
    ]);
    assert.deepEqual(
      ranked.map((item) => item.canonicalMediaId),
      [1, 2, 3, 4]
    );
  });

  it('plans the configured per-run subset in deterministic eligibility order', () => {
    const candidates = [
      candidate(4, '2025-04-01T00:00:00Z', '2025-04-15T00:00:00Z'),
      candidate(3, '2025-03-01T00:00:00Z', '2025-03-15T00:00:00Z'),
      candidate(2, '2025-02-01T00:00:00Z', '2025-02-15T00:00:00Z'),
      candidate(1, '2025-01-01T00:00:00Z', '2025-01-15T00:00:00Z'),
    ];
    const plan = planAutomaticRemovalPool({
      mediaType: 'movie',
      candidates,
      active: [
        {
          canonicalMediaId: 1,
          origin: RemovalScheduleOrigin.MANUAL,
          targetType: RemovalTargetType.MOVIE,
        },
      ],
      policy: {
        ...policy,
        itemsPerRun: 2,
      },
      now,
    });

    assert.deepEqual(
      plan.eligibleUnscheduled.map((item) => item.canonicalMediaId),
      [2, 3, 4]
    );
    assert.deepEqual(
      plan.selected.map((item) => item.canonicalMediaId),
      [2, 3]
    );
    assert.equal(plan.eligibleUnscheduledCount, 3);
  });

  it('marks an unscheduled selection as the exact prefix of ranked eligibility', () => {
    const candidates = [
      candidate(3, '2025-03-01T00:00:00Z'),
      candidate(1, '2025-01-01T00:00:00Z'),
      candidate(2, '2025-02-01T00:00:00Z'),
    ];
    const plan = planAutomaticRemovalPool({
      mediaType: 'movie',
      candidates,
      active: [],
      policy: {
        ...policy,
        itemsPerRun: 2,
      },
      now,
    });

    assert.deepEqual(
      plan.eligibleUnscheduled.map((item) => item.canonicalMediaId),
      [1, 2, 3]
    );
    assert.deepEqual(
      plan.selected.map((item) => item.canonicalMediaId),
      [1, 2]
    );
  });

  it('keeps Movie and Series per-run policies independent', () => {
    const candidates = [
      candidate(1, '2025-01-01T00:00:00Z'),
      candidate(2, '2025-02-01T00:00:00Z'),
      candidate(3, '2025-01-01T00:00:00Z', null, 'series'),
      candidate(4, '2025-02-01T00:00:00Z', null, 'series'),
    ];
    const movie = planAutomaticRemovalPool({
      mediaType: 'movie',
      candidates,
      active: [],
      policy: { ...policy, itemsPerRun: 1 },
      now,
    });
    const series = planAutomaticRemovalPool({
      mediaType: 'series',
      candidates,
      active: [],
      policy: { ...policy, itemsPerRun: 2 },
      now,
    });

    assert.deepEqual(
      movie.selected.map((item) => item.canonicalMediaId),
      [1]
    );
    assert.deepEqual(
      series.selected.map((item) => item.canonicalMediaId),
      [3, 4]
    );
  });
});
