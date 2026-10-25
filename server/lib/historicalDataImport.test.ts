import {
  LibraryMediaType,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import dataSource, { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import FreshMedia from '@server/entity/FreshMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import {
  HydrationRun,
  SourceCheckpoint,
} from '@server/entity/LibraryHydration';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { Watchlist } from '@server/entity/Watchlist';
import historicalDataImport, {
  HistoricalDataImportService,
} from '@server/lib/historicalDataImport';
import { HistoricalImportConflictError } from '@server/lib/historicalDataInspection';
import {
  createWholphinHistoryArtifact,
  validateWholphinHistoryArtifact,
  type WholphinHistoryContent,
} from '@server/lib/wholphinHistory';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { DataSource } from 'typeorm';

setupTestDb();

const content = (): WholphinHistoryContent => ({
  schema: 'wholphin-history-v1',
  jellyfinServerScope: 'server-a',
  coverage: {
    startedAt: '2025-12-19T00:00:00.000Z',
    endedAt: '2026-10-03T00:00:00.000Z',
  },
  viewers: [{ id: 'viewer:one', jellyfinUserId: 'user-one' }],
  media: [
    {
      id: 'media:movie',
      mediaType: 'movie',
      title: 'Historical Movie',
      year: 2020,
      identities: [
        { provider: 'tmdb', sourceScope: '', value: '1234' },
        {
          provider: 'jellyfin',
          sourceScope: 'server-a',
          value: 'movie-item',
        },
      ],
    },
    {
      id: 'media:series',
      mediaType: 'series',
      title: 'Historical Series',
      year: 2021,
      identities: [
        { provider: 'tmdb', sourceScope: '', value: '5678' },
        {
          provider: 'jellyfin',
          sourceScope: 'server-a',
          value: 'series-item',
        },
      ],
    },
  ],
  seasons: [
    {
      id: 'season:one',
      seriesId: 'media:series',
      seasonNumber: 1,
      jellyfinItemId: 'season-item',
    },
  ],
  episodes: [
    {
      id: 'episode:one',
      seriesId: 'media:series',
      seasonId: 'season:one',
      episodeNumber: 1,
      jellyfinItemId: 'episode-item',
    },
  ],
  libraryFacts: [
    {
      id: 'presence:movie',
      mediaId: 'media:movie',
      jellyfinItemId: 'movie-item',
      addedAt: '2020-02-01T00:00:00.000Z',
    },
  ],
  viewingFacts: [
    {
      id: 'history-event:one',
      viewerId: 'viewer:one',
      mediaId: 'media:movie',
      jellyfinItemId: 'movie-item',
      sourceClass: 'historical-session',
      observedAt: '2026-01-01T00:00:00.000Z',
      observedEndAt: '2026-01-01T00:30:00.000Z',
      playbackDurationSeconds: 1800,
      runtimeTicks: '72000000000',
      progressBasisPoints: 2500,
      completion: 'partial',
    },
    {
      id: 'history-event:two',
      viewerId: 'viewer:one',
      mediaId: 'media:series',
      episodeId: 'episode:one',
      jellyfinItemId: 'episode-item',
      sourceClass: 'historical-playback-reporting',
      observedAt: '2026-02-01T00:00:00.000Z',
      observedEndAt: '2026-02-01T00:40:00.000Z',
      playbackDurationSeconds: 2400,
      completion: 'likely',
    },
  ],
});

describe('Wholphin historical-data contract', () => {
  it('is deterministic and rejects unsupported, corrupt, duplicate, and contradictory data', () => {
    const first = createWholphinHistoryArtifact(content());
    const second = createWholphinHistoryArtifact(content());
    assert.deepEqual(first, second);
    assert.equal(
      validateWholphinHistoryArtifact(first).datasetId,
      first.datasetId
    );
    assert.equal(
      validateWholphinHistoryArtifact(JSON.parse(JSON.stringify(first)))
        .datasetId,
      first.datasetId
    );

    assert.throws(() =>
      validateWholphinHistoryArtifact({
        ...first,
        contentHash: 'sha256:' + '0'.repeat(64),
      })
    );
    assert.throws(() =>
      validateWholphinHistoryArtifact({
        ...first,
        schema: 'unsupported-history-v2',
      })
    );
    const duplicateEvent = content();
    duplicateEvent.viewingFacts.push({ ...duplicateEvent.viewingFacts[0] });
    assert.throws(() =>
      validateWholphinHistoryArtifact(
        createWholphinHistoryArtifact(duplicateEvent)
      )
    );
    const contradictory = content();
    contradictory.media.push({
      id: 'media:duplicate-movie',
      mediaType: 'movie',
      identities: [{ provider: 'tmdb', sourceScope: '', value: '1234' }],
    });
    assert.throws(() =>
      validateWholphinHistoryArtifact(
        createWholphinHistoryArtifact(contradictory)
      )
    );
  });

  it('rejects malformed references and invalid typed provider identities', () => {
    const malformedReference = content();
    malformedReference.episodes[0].seasonId = 'missing-season';
    assert.throws(() =>
      validateWholphinHistoryArtifact(
        createWholphinHistoryArtifact(malformedReference)
      )
    );
    const invalidIdentity = content();
    invalidIdentity.media[0].identities[0].value = 'not-numeric';
    assert.throws(() =>
      validateWholphinHistoryArtifact(
        createWholphinHistoryArtifact(invalidIdentity)
      )
    );
  });

  it('keeps timed sessions strict while accepting distinct untimed and activity facts', () => {
    const extended = content();
    extended.libraryFacts[0].provenance = 'administrator-supplied-historical';
    extended.completionFacts = [
      {
        id: 'manual-completion:movie',
        viewerId: 'viewer:one',
        mediaId: 'media:movie',
        jellyfinItemId: 'movie-item',
        completion: 'confirmed',
        provenance: 'administrator-supplied-historical',
      },
    ];
    extended.activityFacts = [
      {
        id: 'manual-activity:movie',
        mediaId: 'media:movie',
        jellyfinItemId: 'movie-item',
        activityAt: '2026-09-01T12:00:00.000Z',
        provenance: 'administrator-supplied-historical',
      },
    ];
    extended.untimedEvidenceFacts = [
      {
        id: 'untimed:episode',
        viewerId: 'viewer:one',
        mediaId: 'media:series',
        episodeId: 'episode:one',
        jellyfinItemId: 'episode-item',
        sourceClass: 'historical-session',
        playbackDurationSeconds: 300,
        progressBasisPoints: 1000,
        completion: 'partial',
        provenance: 'administrator-rejected-source-timing',
      },
    ];
    assert.equal(
      validateWholphinHistoryArtifact(createWholphinHistoryArtifact(extended))
        .completionFacts?.length,
      1
    );
    const invalidTimed = content();
    delete (invalidTimed.viewingFacts[0] as { observedAt?: string }).observedAt;
    assert.throws(() => createWholphinHistoryArtifact(invalidTimed));
  });
});

describe('generic historical-data import', () => {
  it('merges normal Foundation facts and is an idempotent no-op on repeat', async () => {
    const artifact = createWholphinHistoryArtifact(content());
    const unrelatedBefore = {
      watchlist: await getRepository(Watchlist).count(),
      fresh: await getRepository(FreshMedia).count(),
      requests: await getRepository(MediaRequest).count(),
    };
    const first = await historicalDataImport.import(artifact);
    assert.deepEqual(
      {
        viewers: first.viewersCreated,
        media: first.mediaCreated,
        seasons: first.seasonsCreated,
        episodes: first.episodesCreated,
        presence: first.libraryFactsCreated,
        evidence: first.viewingFactsCreated,
      },
      {
        viewers: 1,
        media: 2,
        seasons: 1,
        episodes: 1,
        presence: 1,
        evidence: 2,
      }
    );
    const second = await historicalDataImport.import(artifact);
    assert.equal(first.disposition, 'first-import');
    assert.equal(second.disposition, 'exact-repeat');
    assert.equal(first.historicalCompleteness, 'not-asserted');
    assert.equal(second.viewersCreated, 0);
    assert.equal(second.mediaCreated, 0);
    assert.equal(second.seasonsCreated, 0);
    assert.equal(second.episodesCreated, 0);
    assert.equal(second.libraryFactsCreated, 0);
    assert.equal(second.viewingFactsCreated, 0);
    assert.equal(await getRepository(Viewer).count(), 1);
    assert.equal(await getRepository(CanonicalMedia).count(), 2);
    assert.equal(await getRepository(CanonicalSeason).count(), 1);
    assert.equal(await getRepository(CanonicalEpisode).count(), 1);
    assert.equal(await getRepository(LibraryPresence).count(), 1);
    assert.equal(await getRepository(ViewingEvidence).count(), 2);
    assert.deepEqual(
      {
        watchlist: await getRepository(Watchlist).count(),
        fresh: await getRepository(FreshMedia).count(),
        requests: await getRepository(MediaRequest).count(),
      },
      unrelatedBefore
    );
    assert.equal(await getRepository(HydrationRun).count(), 1);
  });

  it('creates only historical non-current presence and preserves uncertain completion', async () => {
    await historicalDataImport.import(createWholphinHistoryArtifact(content()));
    const presence = await getRepository(LibraryPresence).findOneByOrFail({});
    assert.equal(presence.sourceItemId, 'movie-item');
    assert.equal(presence.isCurrent, false);
    assert.equal(presence.jellyfinVisible, false);
    assert.equal(presence.lastSeenAt, null);
    assert.equal(presence.removedAt, null);
    assert.equal(presence.removalSource, null);
    assert.equal(await getRepository(CurrentViewingState).count(), 0);
    const evidence = await getRepository(ViewingEvidence).find({
      order: { sourceActivityId: 'ASC' },
    });
    assert.deepEqual(
      evidence.map((item) => item.completionClassification),
      [
        ViewingCompletionClassification.PARTIAL,
        ViewingCompletionClassification.LIKELY,
      ]
    );
    assert.ok(
      evidence.every(
        (item) => item.source === 'jellyfin' && item.sourceScope === 'server-a'
      )
    );
  });

  it('preserves historical membership when its physical added date is unknown', async () => {
    const artifactContent = content();
    delete artifactContent.libraryFacts[0].addedAt;

    const result = await historicalDataImport.import(
      createWholphinHistoryArtifact(artifactContent)
    );
    const presence = await getRepository(LibraryPresence).findOneByOrFail({});

    assert.equal(result.libraryFactsCreated, 1);
    assert.equal(presence.isCurrent, false);
    assert.equal(presence.addedAt, null);
    assert.equal(presence.addedAtSource, null);
    assert.equal(presence.addedAtConfidence, null);
  });

  it('preserves unknown historical completion without manufacturing played state', async () => {
    const artifactContent = content();
    artifactContent.viewingFacts = [
      { ...artifactContent.viewingFacts[0], completion: 'unknown' },
    ];
    await historicalDataImport.import(
      createWholphinHistoryArtifact(artifactContent)
    );
    const evidence = await getRepository(ViewingEvidence).findOneByOrFail({});
    assert.equal(
      evidence.completionClassification,
      ViewingCompletionClassification.UNKNOWN
    );
    assert.equal(await getRepository(CurrentViewingState).count(), 0);
  });

  it('imports distinct untimed completion, dated activity, and untimed evidence idempotently', async () => {
    const value = content();
    value.viewingFacts = [];
    value.libraryFacts[0].provenance = 'administrator-supplied-historical';
    value.completionFacts = [
      {
        id: 'manual-completion:movie',
        viewerId: 'viewer:one',
        mediaId: 'media:movie',
        jellyfinItemId: 'movie-item',
        completion: 'confirmed',
        provenance: 'administrator-supplied-historical',
      },
    ];
    value.activityFacts = [
      {
        id: 'manual-activity:movie',
        mediaId: 'media:movie',
        jellyfinItemId: 'movie-item',
        activityAt: '2026-09-01T12:00:00.000Z',
        provenance: 'administrator-supplied-historical',
      },
    ];
    value.untimedEvidenceFacts = [
      {
        id: 'untimed:episode',
        viewerId: 'viewer:one',
        mediaId: 'media:series',
        episodeId: 'episode:one',
        jellyfinItemId: 'episode-item',
        sourceClass: 'historical-session',
        progressBasisPoints: 2500,
        completion: 'partial',
        provenance: 'administrator-rejected-source-timing',
      },
    ];
    const artifact = createWholphinHistoryArtifact(value);
    const first = await historicalDataImport.import(artifact);
    assert.equal(first.completionFactsCreated, 1);
    assert.equal(first.activityFactsCreated, 1);
    assert.equal(first.untimedEvidenceFactsCreated, 1);
    const evidence = await getRepository(ViewingEvidence).find({
      order: { sourceClass: 'ASC' },
    });
    const completion = evidence.find(
      (item) => item.sourceClass === 'historical-manual-completion'
    );
    const activity = evidence.find(
      (item) => item.sourceClass === 'historical-manual-activity'
    );
    const untimed = evidence.find(
      (item) => item.sourceClass === 'historical-untimed-evidence'
    );
    assert.equal(
      completion?.completionClassification,
      ViewingCompletionClassification.CONFIRMED
    );
    assert.equal(completion?.observedAt, null);
    assert.equal(
      activity?.completionClassification,
      ViewingCompletionClassification.UNKNOWN
    );
    assert.equal(
      activity?.observedEndAt?.toISOString(),
      '2026-09-01T12:00:00.000Z'
    );
    assert.equal(untimed?.observedAt, null);
    assert.equal(untimed?.progressBasisPoints, 2500);
    assert.equal(
      (await getRepository(LibraryPresence).findOneByOrFail({})).addedAtSource,
      'administrator-supplied-historical'
    );
    const second = await historicalDataImport.import(artifact);
    assert.equal(second.completionFactsCreated, 0);
    assert.equal(second.activityFactsCreated, 0);
    assert.equal(second.untimedEvidenceFactsCreated, 0);
    assert.equal(await getRepository(ViewingEvidence).count(), 3);
  });

  it('reuses exact current identity without overwriting current metadata', async () => {
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Current Truth',
        year: 2024,
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'tmdb',
        sourceScope: '',
        value: '1234',
      })
    );
    const artifactContent = content();
    artifactContent.media = [artifactContent.media[0]];
    artifactContent.seasons = [];
    artifactContent.episodes = [];
    artifactContent.viewingFacts = [artifactContent.viewingFacts[0]];
    const result = await historicalDataImport.import(
      createWholphinHistoryArtifact(artifactContent)
    );
    assert.equal(result.mediaMatched, 1);
    assert.equal(result.mediaCreated, 0);
    const after = await getRepository(CanonicalMedia).findOneByOrFail({
      id: canonical.id,
    });
    assert.equal(after.titleSnapshot, 'Current Truth');
    assert.equal(after.year, 2024);
  });

  it('rolls back the whole import when permanent exact identities conflict', async () => {
    const first = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({ mediaType: LibraryMediaType.MOVIE })
    );
    const second = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({ mediaType: LibraryMediaType.MOVIE })
    );
    await getRepository(CanonicalMediaIdentity).save([
      new CanonicalMediaIdentity({
        canonicalMediaId: first.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'tmdb',
        sourceScope: '',
        value: '1234',
      }),
      new CanonicalMediaIdentity({
        canonicalMediaId: second.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'jellyfin',
        sourceScope: 'server-a',
        value: 'movie-item',
      }),
    ]);
    const before = {
      media: await getRepository(CanonicalMedia).count(),
      viewers: await getRepository(Viewer).count(),
      presence: await getRepository(LibraryPresence).count(),
      evidence: await getRepository(ViewingEvidence).count(),
      seerrMedia: await getRepository(Media).count(),
    };
    await assert.rejects(
      historicalDataImport.import(createWholphinHistoryArtifact(content())),
      /canonical identity conflict/
    );
    assert.deepEqual(
      {
        media: await getRepository(CanonicalMedia).count(),
        viewers: await getRepository(Viewer).count(),
        presence: await getRepository(LibraryPresence).count(),
        evidence: await getRepository(ViewingEvidence).count(),
        seerrMedia: await getRepository(Media).count(),
      },
      before
    );
  });

  it('uses one inspection contract for exact repeats and missing-fact repair', async () => {
    const artifact = createWholphinHistoryArtifact(content());
    await historicalDataImport.import(artifact);
    const checkpointBefore = await getRepository(
      SourceCheckpoint
    ).findOneByOrFail({ stage: 'historical-import' });
    const repeat = await historicalDataImport.inspect(artifact);
    assert.equal(repeat.disposition, 'exact-repeat');
    assert.equal(repeat.importable, true);
    await historicalDataImport.import(artifact);
    const checkpointAfter = await getRepository(
      SourceCheckpoint
    ).findOneByOrFail({ stage: 'historical-import' });
    assert.equal(await getRepository(HydrationRun).count(), 1);
    assert.equal(checkpointAfter.lastRunId, checkpointBefore.lastRunId);
    assert.equal(
      checkpointAfter.lastSuccessfulAt?.toISOString(),
      checkpointBefore.lastSuccessfulAt?.toISOString()
    );

    await getRepository(ViewingEvidence).delete({
      sourceActivityId: 'history-event:two',
    });
    const repairInspection = await historicalDataImport.inspect(artifact);
    assert.equal(repairInspection.disposition, 'repair');
    assert.equal(repairInspection.comparison.missingFacts, 1);
    const repair = await historicalDataImport.import(artifact);
    assert.equal(repair.disposition, 'repair');
    assert.equal(repair.viewingFactsCreated, 1);
    assert.equal(await getRepository(HydrationRun).count(), 2);

    await getRepository(CanonicalMediaIdentity).delete({
      provider: 'tmdb',
      sourceScope: '',
      value: '1234',
    });
    const identityRepair = await historicalDataImport.inspect(artifact);
    assert.equal(identityRepair.disposition, 'repair');
    const identityResult = await historicalDataImport.import(artifact);
    assert.equal(identityResult.disposition, 'repair');
    assert.equal(
      await getRepository(CanonicalMediaIdentity).countBy({
        provider: 'tmdb',
        sourceScope: '',
        value: '1234',
      }),
      1
    );
  });

  it('rejects corrected facts and identity changes without advancing acceptance', async () => {
    const original = createWholphinHistoryArtifact(content());
    await historicalDataImport.import(original);
    const checkpoint = await getRepository(SourceCheckpoint).findOneByOrFail({
      stage: 'historical-import',
    });
    const runCount = await getRepository(HydrationRun).count();

    const corrected = content();
    corrected.viewingFacts[0].observedEndAt = '2026-01-01T00:31:00.000Z';
    corrected.viewingFacts[0].playbackDurationSeconds = 1860;
    const correctedArtifact = createWholphinHistoryArtifact(corrected);
    const inspection = await historicalDataImport.inspect(correctedArtifact);
    assert.equal(inspection.disposition, 'corrected-facts');
    assert.equal(inspection.importable, false);
    await assert.rejects(
      historicalDataImport.import(correctedArtifact),
      (error: unknown) =>
        error instanceof HistoricalImportConflictError &&
        error.statusCode === 409
    );

    const changedViewer = content();
    changedViewer.viewers[0].jellyfinUserId = 'different-user';
    const viewerInspection = await historicalDataImport.inspect(
      createWholphinHistoryArtifact(changedViewer)
    );
    assert.equal(viewerInspection.disposition, 'corrected-facts');
    assert.ok(
      viewerInspection.issues.some(
        (issue) => issue.code === 'identity-conflict'
      )
    );

    const changedCanonical = content();
    changedCanonical.media[0].identities[0].value = '9999';
    const canonicalInspection = await historicalDataImport.inspect(
      createWholphinHistoryArtifact(changedCanonical)
    );
    assert.equal(canonicalInspection.disposition, 'corrected-facts');
    assert.ok(
      canonicalInspection.issues.some(
        (issue) => issue.factType === 'media-identity'
      )
    );
    const checkpointAfter = await getRepository(
      SourceCheckpoint
    ).findOneByOrFail({ stage: 'historical-import' });
    assert.equal(checkpointAfter.lastRunId, checkpoint.lastRunId);
    assert.equal(checkpointAfter.sourceGeneration, checkpoint.sourceGeneration);
    assert.equal(await getRepository(HydrationRun).count(), runCount);
  });

  it('rejects omissions and regressive coverage but accepts cumulative additions', async () => {
    await historicalDataImport.import(createWholphinHistoryArtifact(content()));

    const omitted = content();
    omitted.viewingFacts.pop();
    const omissionInspection = await historicalDataImport.inspect(
      createWholphinHistoryArtifact(omitted)
    );
    assert.equal(omissionInspection.disposition, 'historical-omission');
    assert.equal(omissionInspection.comparison.omittedFacts, 1);

    const older = content();
    older.coverage.endedAt = '2026-09-01T00:00:00.000Z';
    const olderInspection = await historicalDataImport.inspect(
      createWholphinHistoryArtifact(older)
    );
    assert.equal(olderInspection.disposition, 'regressive-artifact');

    const unbounded = content();
    unbounded.coverage = {};
    const unboundedInspection = await historicalDataImport.inspect(
      createWholphinHistoryArtifact(unbounded)
    );
    assert.equal(unboundedInspection.disposition, 'regressive-artifact');

    const cumulative = content();
    cumulative.coverage.endedAt = '2026-10-04T00:00:00.000Z';
    cumulative.viewingFacts.push({
      ...cumulative.viewingFacts[0],
      id: 'history-event:three',
      observedAt: '2026-10-04T00:00:00.000Z',
      observedEndAt: '2026-10-04T00:05:00.000Z',
      playbackDurationSeconds: 300,
    });
    const cumulativeArtifact = createWholphinHistoryArtifact(cumulative);
    const cumulativeInspection =
      await historicalDataImport.inspect(cumulativeArtifact);
    assert.equal(cumulativeInspection.disposition, 'additive-cumulative');
    assert.equal(cumulativeInspection.comparison.missingFacts, 1);
    const result = await historicalDataImport.import(cumulativeArtifact);
    assert.equal(result.disposition, 'additive-cumulative');
    assert.equal(result.viewingFactsCreated, 1);
  });

  it('serializes concurrent attempts and accepts only one first import', async () => {
    const artifact = createWholphinHistoryArtifact(content());
    const results = await Promise.all([
      historicalDataImport.import(artifact),
      historicalDataImport.import(artifact),
    ]);
    assert.deepEqual(results.map((result) => result.disposition).sort(), [
      'exact-repeat',
      'first-import',
    ]);
    assert.equal(await getRepository(HydrationRun).count(), 1);
    assert.equal(await getRepository(ViewingEvidence).count(), 2);
  });

  it('fences concurrent imports from independent SQLite connections', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'seerr-history-r4-'));
    const database = path.join(directory, 'history.sqlite3');
    assert.equal(dataSource.options.type, 'sqlite');
    if (dataSource.options.type !== 'sqlite') return;
    const base = dataSource.options;
    const primary = new DataSource({
      ...base,
      type: 'sqlite',
      database,
      synchronize: true,
      dropSchema: true,
      migrationsRun: false,
    });
    const secondary = new DataSource({
      ...base,
      type: 'sqlite',
      database,
      synchronize: false,
      dropSchema: false,
      migrationsRun: false,
    });
    try {
      await primary.initialize();
      await secondary.initialize();
      await primary.query('PRAGMA busy_timeout = 10000');
      await secondary.query('PRAGMA busy_timeout = 10000');
      const uncoordinated = {
        runExclusive: <T>(operation: () => Promise<T>) => operation(),
      };
      const first = new HistoricalDataImportService(primary, uncoordinated);
      const second = new HistoricalDataImportService(secondary, uncoordinated);
      const artifact = createWholphinHistoryArtifact(content());
      const results = await Promise.all([
        first.import(artifact),
        second.import(artifact),
      ]);
      assert.deepEqual(results.map((result) => result.disposition).sort(), [
        'exact-repeat',
        'first-import',
      ]);
      assert.equal(await primary.getRepository(HydrationRun).count(), 1);
      assert.equal(await primary.getRepository(ViewingEvidence).count(), 2);
    } finally {
      if (secondary.isInitialized) await secondary.destroy();
      if (primary.isInitialized) await primary.destroy();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
