import { FreshCandidateStatus } from '@server/constants/fresh';
import FreshCandidate from '@server/entity/FreshCandidate';
import FreshMedia from '@server/entity/FreshMedia';
import FreshObservation from '@server/entity/FreshObservation';
import { FreshSyncState } from '@server/entity/FreshSyncState';
import { AddFreshPersistence1790000000000 } from '@server/migration/sqlite/1790000000000-AddFreshPersistence';
import { UpgradeFreshMembership1790000000002 } from '@server/migration/sqlite/1790000000002-UpgradeFreshMembership';
import { AddFreshAvailabilityDates1790000000004 } from '@server/migration/sqlite/1790000000004-AddFreshAvailabilityDates';
import { AddFreshEligibilitySchemaVersion1790000000006 } from '@server/migration/sqlite/1790000000006-AddFreshEligibilitySchemaVersion';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('Fresh persistence migration', () => {
  it('creates the four-entity SQLite schema and singleton state through migrations', async () => {
    const database = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [FreshSyncState, FreshCandidate, FreshObservation, FreshMedia],
      migrations: [
        AddFreshPersistence1790000000000,
        UpgradeFreshMembership1790000000002,
        AddFreshAvailabilityDates1790000000004,
        AddFreshEligibilitySchemaVersion1790000000006,
      ],
      synchronize: false,
    });
    await database.initialize();
    try {
      await database.runMigrations();
      const tables = (
        (await database.query(
          `SELECT name FROM sqlite_master WHERE type = 'table'`
        )) as { name: string }[]
      ).map(({ name }) => name);
      for (const name of [
        'fresh_sync_state',
        'fresh_observation',
        'fresh_candidate',
        'fresh_media',
      ]) {
        assert.ok(tables.includes(name));
      }
      assert.equal(
        await database.getRepository(FreshSyncState).countBy({ id: 1 }),
        1
      );
      const now = new Date('2026-09-26T10:00:00Z');
      const media = await database.getRepository(FreshMedia).save(
        new FreshMedia({
          mediaType: 'movie',
          tmdbId: 101,
          firstSeenAt: now,
          lastSeenAt: now,
          resolvedAt: now,
          metadataRefreshedAt: now,
          displayTitle: 'Movie',
          sortTitle: 'movie',
          originalTitle: 'Movie',
        })
      );
      const candidate = await database.getRepository(FreshCandidate).save(
        new FreshCandidate({
          sourceGeneration: 1,
          mediaType: 'movie',
          normalizedTitle: 'movie',
          displayTitle: 'Movie',
          matchYear: 2026,
          status: FreshCandidateStatus.RESOLVED,
          freshMediaId: media.id,
          firstObservedAt: now,
          lastObservedAt: now,
        })
      );
      await database.getRepository(FreshObservation).save(
        new FreshObservation({
          sourceGeneration: 1,
          releaseId: '10',
          filterId: 7,
          candidateId: candidate.id,
          mediaType: 'movie',
          title: 'Movie',
          normalizedTitle: 'movie',
          year: 2026,
          observedAt: now,
        })
      );
      await assert.rejects(() =>
        database.getRepository(FreshObservation).save(
          new FreshObservation({
            sourceGeneration: 1,
            releaseId: '10',
            filterId: 7,
            candidateId: candidate.id,
            mediaType: 'movie',
            title: 'Duplicate',
            normalizedTitle: 'duplicate',
            year: 2026,
            observedAt: now,
          })
        )
      );
      await database.getRepository(FreshMedia).remove(media);
      assert.equal(
        (
          await database
            .getRepository(FreshCandidate)
            .findOneByOrFail({ id: candidate.id })
        ).freshMediaId,
        null
      );
      await database.getRepository(FreshCandidate).delete(candidate.id);
      assert.equal(await database.getRepository(FreshObservation).count(), 0);
      await database.undoLastMigration();
      await database.undoLastMigration();
      await database.undoLastMigration();
      await database.undoLastMigration();
      const remaining = (
        (await database.query(
          `SELECT name FROM sqlite_master WHERE type = 'table'`
        )) as { name: string }[]
      ).map(({ name }) => name);
      assert.equal(remaining.includes('fresh_media'), false);
      await database.runMigrations();
      assert.equal(
        await database.getRepository(FreshSyncState).countBy({ id: 1 }),
        1
      );
    } finally {
      await database.destroy();
    }
  });

  it('upgrades existing development rows without rewriting first-seen evidence', async () => {
    const database = new DataSource({ type: 'sqlite', database: ':memory:' });
    await database.initialize();
    const runner = database.createQueryRunner();
    try {
      await runner.query(
        `CREATE TABLE "fresh_sync_state" ("id" integer PRIMARY KEY, "projectionWindowDays" integer NOT NULL)`
      );
      await runner.query(
        `INSERT INTO "fresh_sync_state" ("id", "projectionWindowDays") VALUES (1, 120)`
      );
      await runner.query(
        `CREATE TABLE "fresh_media" ("id" integer PRIMARY KEY, "active" boolean NOT NULL, "firstSeenAt" datetime NOT NULL)`
      );
      await runner.query(
        `INSERT INTO "fresh_media" ("id", "active", "firstSeenAt") VALUES (1, 1, '2026-09-20 00:00:00')`
      );
      await runner.query(
        `CREATE TABLE "fresh_candidate" ("id" integer PRIMARY KEY, "status" integer NOT NULL, "freshMediaId" integer, "lastFailureReason" varchar(64), "nextAttemptAt" datetime)`
      );
      await runner.query(
        `INSERT INTO "fresh_candidate" ("id", "status", "freshMediaId") VALUES (1, 3, 1)`
      );
      await new UpgradeFreshMembership1790000000002().up(runner);
      await new AddFreshEligibilitySchemaVersion1790000000006().up(runner);
      const [state] = (await runner.query(
        `SELECT "mediaEligibilityDays", "freshVisibilityDays", "eligibilitySchemaVersion" FROM "fresh_sync_state"`
      )) as {
        mediaEligibilityDays: number;
        freshVisibilityDays: number;
        eligibilitySchemaVersion: number;
      }[];
      const [media] = (await runner.query(
        `SELECT "admitted", "membershipReason", "firstSeenAt" FROM "fresh_media"`
      )) as {
        admitted: number;
        membershipReason: string;
        firstSeenAt: string;
      }[];
      assert.deepEqual(state, {
        mediaEligibilityDays: 120,
        freshVisibilityDays: 7,
        eligibilitySchemaVersion: 0,
      });
      assert.equal(media.admitted, 1);
      assert.equal(media.membershipReason, 'active_fresh');
      assert.match(media.firstSeenAt, /2026-09-20/);
    } finally {
      await runner.release();
      await database.destroy();
    }
  });
});
