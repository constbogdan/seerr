import { FreshCandidateStatus } from '@server/constants/fresh';
import FreshAdmissionOverride from '@server/entity/FreshAdmissionOverride';
import FreshCandidate from '@server/entity/FreshCandidate';
import FreshDiscoveryHistory from '@server/entity/FreshDiscoveryHistory';
import FreshManualResolution from '@server/entity/FreshManualResolution';
import FreshMedia from '@server/entity/FreshMedia';
import FreshObservation from '@server/entity/FreshObservation';
import { FreshSyncState } from '@server/entity/FreshSyncState';
import { AddFreshPersistence1790000000000 } from '@server/migration/sqlite/1790000000000-AddFreshPersistence';
import { UpgradeFreshMembership1790000000002 } from '@server/migration/sqlite/1790000000002-UpgradeFreshMembership';
import { AddFreshAvailabilityDates1790000000004 } from '@server/migration/sqlite/1790000000004-AddFreshAvailabilityDates';
import { AddFreshEligibilitySchemaVersion1790000000006 } from '@server/migration/sqlite/1790000000006-AddFreshEligibilitySchemaVersion';
import { RefineFreshDiscovery1790000000010 } from '@server/migration/sqlite/1790000000010-RefineFreshDiscovery';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

describe('Fresh persistence migration', () => {
  it('preserves existing Fresh media when development synchronization adds automatic reasons', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'seerr-fresh-sync-'));
    const databasePath = path.join(directory, 'db.sqlite3');
    const legacy = new DataSource({
      type: 'sqlite',
      database: databasePath,
      migrations: [
        AddFreshPersistence1790000000000,
        UpgradeFreshMembership1790000000002,
        AddFreshAvailabilityDates1790000000004,
        AddFreshEligibilitySchemaVersion1790000000006,
      ],
      synchronize: false,
    });
    const synchronized = new DataSource({
      type: 'sqlite',
      database: databasePath,
      entities: [FreshMedia],
      synchronize: true,
    });
    try {
      await legacy.initialize();
      await legacy.runMigrations();
      await legacy.query(`
        INSERT INTO "fresh_media"
          ("mediaType", "tmdbId", "active", "admitted", "lastMatchedGeneration",
           "firstSeenAt", "lastSeenAt", "resolvedAt", "metadataRefreshedAt",
           "displayTitle", "sortTitle", "originalTitle", "membershipReason",
           "genreIds", "originCountries", "originalLanguage", "voteAverage", "voteCount")
        VALUES
          ('movie', 101, 1, 1, 4, '2026-09-20 00:00:00', '2026-09-21 00:00:00',
           '2026-09-20 00:00:00', '2026-09-20 00:00:00', 'Existing Movie',
           'existing movie', 'Existing Movie', 'active_fresh', '[]', '[]', '', 0, 0)
      `);
      await legacy.destroy();

      await synchronized.initialize();
      const [media] = (await synchronized.query(
        `SELECT "tmdbId", "automaticReasons" FROM "fresh_media"`
      )) as { tmdbId: number; automaticReasons: string }[];
      assert.deepEqual(media, { tmdbId: 101, automaticReasons: '[]' });
    } finally {
      if (legacy.isInitialized) await legacy.destroy();
      if (synchronized.isInitialized) await synchronized.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('keeps the PostgreSQL refinement schema timezone-aware and sentinel-keyed', () => {
    const source = readFileSync(
      path.join(
        process.cwd(),
        'server/migration/postgres/1790000000011-RefineFreshDiscovery.ts'
      ),
      'utf8'
    );
    assert.match(source, /const time = 'timestamp with time zone'/);
    assert.match(source, /UQ_fresh_discovery_history_identity/);
    assert.match(source, /'seasonKey',\s*'specialEpisodeKey'/s);
    assert.doesNotMatch(source, /timestamp without time zone/);
  });

  it('creates the refined Fresh SQLite schema and singleton state through migrations', async () => {
    const database = new DataSource({
      type: 'sqlite',
      database: ':memory:',
      entities: [
        FreshSyncState,
        FreshCandidate,
        FreshObservation,
        FreshMedia,
        FreshDiscoveryHistory,
        FreshManualResolution,
        FreshAdmissionOverride,
      ],
      migrations: [
        AddFreshPersistence1790000000000,
        UpgradeFreshMembership1790000000002,
        AddFreshAvailabilityDates1790000000004,
        AddFreshEligibilitySchemaVersion1790000000006,
        RefineFreshDiscovery1790000000010,
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
        'fresh_discovery_history',
        'fresh_manual_resolution',
        'fresh_admission_override',
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
      // The refinement migration is deliberately forward-only: rolling it
      // back would erase irreversible discovery history and human decisions.
      assert.equal(await database.showMigrations(), false);
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

  it('seeds only admitted legacy media into irreversible history', async () => {
    const database = new DataSource({
      type: 'sqlite',
      database: ':memory:',
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
      await database.query(
        `UPDATE "fresh_sync_state" SET "generation" = 4, "checkpointReleaseId" = '4126', "freshVisibilityDays" = 10 WHERE "id" = 1`
      );
      await database.query(`
        INSERT INTO "fresh_media"
          ("mediaType", "tmdbId", "active", "admitted", "lastMatchedGeneration",
           "firstSeenAt", "lastSeenAt", "resolvedAt", "metadataRefreshedAt",
           "displayTitle", "sortTitle", "originalTitle", "mediaDate", "membershipReason",
           "genreIds", "originCountries", "originalLanguage", "voteAverage", "voteCount")
        VALUES
          ('movie', 101, 1, 1, 4, '2026-09-20 00:00:00', '2026-09-21 00:00:00',
           '2026-09-20 00:00:00', '2026-09-20 00:00:00', 'Admitted Movie',
           'admitted movie', 'Admitted Movie', '2026-09-01', 'active_fresh', '[]', '[]', '', 0, 0),
          ('movie', 102, 0, 0, 4, '2026-09-20 00:00:00', '2026-09-21 00:00:00',
           '2026-09-20 00:00:00', '2026-09-20 00:00:00', 'Outside Movie',
           'outside movie', 'Outside Movie', '2020-01-01', 'outside_eligibility_window', '[]', '[]', '', 0, 0),
          ('tv', 201, 1, 1, 4, '2026-09-22 00:00:00', '2026-09-23 00:00:00',
           '2026-09-22 00:00:00', '2026-09-22 00:00:00', 'Legacy Series',
           'legacy series', 'Legacy Series', '2020-01-01', 'active_fresh', '[]', '[]', '', 0, 0)
      `);

      const runner = database.createQueryRunner();
      await new RefineFreshDiscovery1790000000010().up(runner);
      await runner.release();
      const histories = (await database.query(
        `SELECT "mediaType", "tmdbId", "identityKind", "seasonKey", "legacyProjection", "firstFreshAt", "visibleUntil" FROM "fresh_discovery_history" ORDER BY "tmdbId"`
      )) as {
        mediaType: string;
        tmdbId: number;
        identityKind: string;
        seasonKey: number;
        legacyProjection: number;
        firstFreshAt: string;
        visibleUntil: string;
      }[];
      assert.equal(histories.length, 2);
      assert.deepEqual(
        histories.map((history) => ({
          type: history.mediaType,
          id: history.tmdbId,
          kind: history.identityKind,
          season: history.seasonKey,
          legacy: Boolean(history.legacyProjection),
        })),
        [
          { type: 'movie', id: 101, kind: 'movie', season: -1, legacy: false },
          { type: 'tv', id: 201, kind: 'legacy_tv', season: -1, legacy: true },
        ]
      );
      assert.match(histories[0].firstFreshAt, /2026-09-20/);
      assert.match(histories[0].visibleUntil, /2026-09-30/);
      const [state] = (await database.query(
        `SELECT "generation", "checkpointReleaseId" FROM "fresh_sync_state" WHERE "id" = 1`
      )) as { generation: number; checkpointReleaseId: string }[];
      assert.deepEqual(state, { generation: 4, checkpointReleaseId: '4126' });
    } finally {
      await database.destroy();
    }
  });
});
