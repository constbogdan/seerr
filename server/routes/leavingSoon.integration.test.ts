import { LibraryMediaType } from '@server/constants/libraryHistory';
import {
  RemovalScheduleOrigin,
  RemovalScheduleStatus,
  RemovalTargetType,
} from '@server/constants/removal';
import { getRepository } from '@server/datasource';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import { LibraryService } from '@server/lib/library';
import { isAuthenticated } from '@server/middleware/auth';
import { createLeavingSoonRouter } from '@server/routes/leavingSoon';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import request from 'supertest';

setupTestDb();

const service = new LibraryService({
  fetchPresentation: async () => {
    throw new Error('No external metadata in this fixture');
  },
});
const app = express();
app.use((req, _res, next) => {
  if (req.header('x-authenticated')) {
    req.user = {
      id: 1,
      hasPermission: () => true,
    } as unknown as Express.Request['user'];
  }
  next();
});
app.use(
  '/leaving-soon',
  isAuthenticated(),
  createLeavingSoonRouter(service, {
    grantStatusAccess: () => true,
    statusFor: () => null,
  })
);

const day = (dayNumber: number) =>
  new Date(`2026-12-${String(dayNumber).padStart(2, '0')}T00:00:00.000Z`);

async function currentItem(mediaType: LibraryMediaType, title: string) {
  const media = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({ mediaType, titleSnapshot: title, year: 2026 })
  );
  await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: media.id,
      sourceSystem: mediaType === LibraryMediaType.MOVIE ? 'radarr' : 'sonarr',
      sourceScope: 'fixture',
      sourceItemId: String(media.id),
      addedAt: new Date('2026-01-01T00:00:00.000Z'),
      firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
      servarrHasFile: true,
      isCurrent: true,
    })
  );
  return media;
}

async function schedule(
  media: CanonicalMedia,
  removeAt: Date,
  status = RemovalScheduleStatus.ACTIVE,
  seasonNumber?: number
) {
  await getRepository(RemovalSchedule).save(
    new RemovalSchedule({
      canonicalMediaId: media.id,
      targetType:
        seasonNumber === undefined
          ? media.mediaType === LibraryMediaType.MOVIE
            ? RemovalTargetType.MOVIE
            : RemovalTargetType.SERIES
          : RemovalTargetType.SEASON,
      seasonNumber: seasonNumber ?? null,
      sourceSystem:
        media.mediaType === LibraryMediaType.MOVIE ? 'radarr' : 'sonarr',
      sourceScope: 'fixture',
      origin: RemovalScheduleOrigin.MANUAL,
      status,
      activeKey:
        status === RemovalScheduleStatus.ACTIVE ||
        status === RemovalScheduleStatus.DEFERRED
          ? `${media.id}:${seasonNumber ?? 'all'}`
          : null,
      scheduledAt: day(1),
      removeAt,
    })
  );
}

const read = async (query = '') => {
  const response = await request(app)
    .get(`/leaving-soon${query ? `?${query}` : ''}`)
    .set('x-authenticated', 'yes');
  assert.equal(response.status, 200, query);
  return response.body as {
    pageInfo: {
      pages: number;
      page: number;
      results: number;
      pageSize: number;
    };
    results: {
      canonicalMediaId: number;
      mediaType: string;
      schedules: { removeAt: string; status: string }[];
    }[];
  };
};

describe('Leaving Soon sorted Library projection', () => {
  it('returns an empty successful page when no current item has an actionable schedule', async () => {
    await currentItem(LibraryMediaType.MOVIE, 'Unscheduled');
    const response = await read();
    assert.deepEqual(response.results, []);
    assert.deepEqual(response.pageInfo, {
      pages: 0,
      page: 1,
      results: 0,
      pageSize: 20,
    });
  });

  it('filters before totals and pages, orders by earliest current due date, and ties by canonical ID', async () => {
    const movieIds = new Map<number, number>();
    // Reverse creation order proves that the result is not ordered by Added or ID.
    for (let dueDay = 21; dueDay >= 1; dueDay--) {
      const media = await currentItem(
        LibraryMediaType.MOVIE,
        `Movie ${dueDay}`
      );
      movieIds.set(dueDay, media.id);
      await schedule(media, day(dueDay));
    }
    const series = await currentItem(LibraryMediaType.SERIES, 'Series');
    await schedule(series, day(20), RemovalScheduleStatus.DEFERRED, 1);
    await schedule(series, day(25), RemovalScheduleStatus.ACTIVE, 2);
    const unscheduled = await currentItem(
      LibraryMediaType.MOVIE,
      'Unscheduled'
    );
    const completed = await currentItem(LibraryMediaType.MOVIE, 'Completed');
    await schedule(completed, day(1), RemovalScheduleStatus.COMPLETED);

    const allFirst = await read();
    const allSecond = await read('page=2');
    assert.equal(allFirst.pageInfo.results, 22);
    assert.equal(allFirst.pageInfo.pages, 2);
    assert.equal(allFirst.pageInfo.pageSize, 20);
    assert.deepEqual(
      allFirst.results.map((item) => item.canonicalMediaId),
      Array.from({ length: 20 }, (_, index) => movieIds.get(index + 1))
    );
    assert.deepEqual(
      allSecond.results.map((item) => item.canonicalMediaId),
      [series.id, movieIds.get(21)]
    );
    assert.equal(allSecond.pageInfo.results, 22);
    assert.equal(allSecond.pageInfo.page, 2);
    assert.deepEqual(
      allSecond.results[0].schedules.map((item) => [
        item.removeAt,
        item.status,
      ]),
      [
        [day(20).toISOString(), 'deferred'],
        [day(25).toISOString(), 'active'],
      ]
    );

    const movieFirst = await read('mediaType=movie');
    const movieSecond = await read('mediaType=movie&page=2');
    assert.equal(movieFirst.pageInfo.results, 21);
    assert.equal(movieFirst.pageInfo.pages, 2);
    assert.equal(movieSecond.pageInfo.results, 21);
    assert.deepEqual(
      movieSecond.results.map((item) => item.canonicalMediaId),
      [movieIds.get(21)]
    );
    const onlySeries = await read('mediaType=series');
    assert.equal(onlySeries.pageInfo.results, 1);
    assert.deepEqual(
      onlySeries.results.map((item) => item.canonicalMediaId),
      [series.id]
    );
    assert.equal(onlySeries.results[0].mediaType, 'series');

    // An item without an active or deferred date sorts last in the general
    // Library query; it never enters the scheduled-only Leaving Soon page.
    const allLibrary = await service.query({
      take: 30,
      skip: 0,
      scope: 'current',
      mediaType: 'all',
      watchlist: 'any',
      watched: 'any',
      scheduled: 'any',
      sort: 'removalDue',
      sortDirection: 'asc',
    });
    assert.deepEqual(
      allLibrary.results.slice(-2).map((item) => item.canonicalMediaId),
      [unscheduled.id, completed.id]
    );
  });
});
