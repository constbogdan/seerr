import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  factualDaysAgo,
  factualRelativeDay,
  parseFactualDate,
} from './factualDate';

describe('factual relative dates', () => {
  it('gives Library and Removal the same Added and Last-active day values', () => {
    const now = new Date(2026, 9, 6, 15, 41, 8);
    const added = new Date(2025, 11, 18, 20, 1, 57);
    const lastActive = new Date(2026, 1, 14, 19, 35, 59);

    assert.equal(factualRelativeDay(added, now), -292);
    assert.equal(factualDaysAgo(added, now), 292);
    assert.equal(factualRelativeDay(lastActive, now), -234);
    assert.equal(factualDaysAgo(lastActive, now), 234);
  });

  it('keeps the December 18 and December 19 controls on adjacent days', () => {
    const now = new Date(2026, 9, 6, 0, 1);

    assert.equal(factualDaysAgo(new Date(2025, 11, 18, 23, 59), now), 292);
    assert.equal(factualDaysAgo(new Date(2025, 11, 19, 0, 1), now), 291);
  });

  it('increments consistently at the local calendar-day boundary', () => {
    const now = new Date(2026, 9, 6, 0, 1);

    assert.equal(factualDaysAgo(new Date(2026, 9, 6, 0, 0), now), 0);
    assert.equal(factualDaysAgo(new Date(2026, 9, 5, 23, 59), now), 1);
  });

  it('handles equivalent ISO instants around UTC midnight consistently', () => {
    const instant = '2026-10-05T23:30:00.000Z';
    const equivalent = new Date(instant);
    const now = new Date('2026-10-06T00:30:00.000Z');

    assert.equal(
      factualRelativeDay(instant, now),
      factualRelativeDay(equivalent, now)
    );
    assert.equal(factualDaysAgo(instant, now), factualDaysAgo(equivalent, now));
  });

  it('never interprets a SQLite UTC timestamp as local time', () => {
    assert.equal(
      parseFactualDate('2025-12-18 18:01:57.000').toISOString(),
      '2025-12-18T18:01:57.000Z'
    );
  });
});
