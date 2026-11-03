import {
  HydrationRunStatus,
  IdentityResolutionState,
  LibraryMediaType,
  LibraryReconciliationState,
  SourceCheckpointStatus,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalEpisodeIdentity,
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
  CanonicalSeasonIdentity,
} from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import {
  HydrationRun,
  SourceCheckpoint,
} from '@server/entity/LibraryHydration';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import backgroundDatabaseWriteCoordinator from '@server/lib/backgroundDatabaseWriteCoordinator';
import {
  HistoricalImportConflictError,
  historicalImportStatus,
  inspectHistoricalImport,
  type HistoricalImportDisposition,
  type HistoricalImportInspection,
} from '@server/lib/historicalDataInspection';
import {
  validateWholphinHistoryArtifact,
  type WholphinHistoryArtifact,
} from '@server/lib/wholphinHistory';
import type { DataSource, EntityManager } from 'typeorm';

interface HistoricalImportWriteCoordinator {
  runExclusive<T>(operation: () => Promise<T>): Promise<T>;
}

export interface HistoricalDataImportSummary {
  datasetId: string;
  schema: 'wholphin-history-v1';
  disposition: Exclude<
    HistoricalImportDisposition,
    'corrected-facts' | 'regressive-artifact' | 'historical-omission'
  >;
  observedRange: HistoricalImportInspection['observedRange'];
  historicalCompleteness: 'not-asserted';
  viewersCreated: number;
  viewersMatched: number;
  mediaCreated: number;
  mediaMatched: number;
  seasonsCreated: number;
  seasonsMatched: number;
  episodesCreated: number;
  episodesMatched: number;
  libraryFactsCreated: number;
  libraryFactsMatched: number;
  viewingFactsCreated: number;
  viewingFactsMatched: number;
  completionFactsCreated: number;
  completionFactsMatched: number;
  activityFactsCreated: number;
  activityFactsMatched: number;
  untimedEvidenceFactsCreated: number;
  untimedEvidenceFactsMatched: number;
  conflicts: number;
}

const completionMap: Record<
  WholphinHistoryArtifact['viewingFacts'][number]['completion'],
  ViewingCompletionClassification
> = {
  confirmed: ViewingCompletionClassification.CONFIRMED,
  likely: ViewingCompletionClassification.LIKELY,
  partial: ViewingCompletionClassification.PARTIAL,
  unknown: ViewingCompletionClassification.UNKNOWN,
  'no-qualifying-evidence':
    ViewingCompletionClassification.NO_QUALIFYING_EVIDENCE,
};

const mediaTypeMap = {
  movie: LibraryMediaType.MOVIE,
  series: LibraryMediaType.SERIES,
} as const;

export class HistoricalDataImportService {
  constructor(
    private readonly connection: DataSource = dataSource,
    private readonly writeCoordinator: HistoricalImportWriteCoordinator = backgroundDatabaseWriteCoordinator
  ) {}

  public validate(input: unknown): WholphinHistoryArtifact {
    return validateWholphinHistoryArtifact(input);
  }

  public async import(input: unknown): Promise<HistoricalDataImportSummary> {
    const artifact = this.validate(input);
    return this.writeCoordinator.runExclusive(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await this.connection.transaction(
            'SERIALIZABLE',
            async (manager) => {
              const checkpoints = manager.getRepository(SourceCheckpoint);
              if (this.connection.options.type === 'postgres') {
                await manager.query(
                  `INSERT INTO "source_checkpoint"
                    ("source", "sourceScope", "stage", "status")
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT ("source", "sourceScope", "stage") DO NOTHING`,
                  [
                    'jellyfin',
                    artifact.jellyfinServerScope,
                    'historical-import',
                    SourceCheckpointStatus.UNINITIALIZED,
                  ]
                );
              } else {
                await manager.query(
                  `INSERT OR IGNORE INTO "source_checkpoint"
                    ("source", "sourceScope", "stage", "status")
                   VALUES (?, ?, ?, ?)`,
                  [
                    'jellyfin',
                    artifact.jellyfinServerScope,
                    'historical-import',
                    SourceCheckpointStatus.UNINITIALIZED,
                  ]
                );
              }
              const checkpoint = await checkpoints.findOneByOrFail({
                source: 'jellyfin',
                sourceScope: artifact.jellyfinServerScope,
                stage: 'historical-import',
              });
              if (this.connection.options.type === 'postgres') {
                await checkpoints
                  .createQueryBuilder('checkpoint')
                  .setLock('pessimistic_write')
                  .where('checkpoint.id = :id', { id: checkpoint.id })
                  .getOneOrFail();
              } else {
                await manager.query(
                  'UPDATE "source_checkpoint" SET "id" = "id" WHERE "id" = ?',
                  [checkpoint.id]
                );
              }
              const inspection = await inspectHistoricalImport(
                manager,
                artifact
              );
              if (!inspection.importable) {
                throw new HistoricalImportConflictError(inspection);
              }
              if (inspection.disposition === 'exact-repeat') {
                return this.exactRepeatSummary(artifact, inspection);
              }
              return this.merge(manager, artifact, inspection, checkpoint);
            }
          );
        } catch (error) {
          const code = (error as { code?: string }).code;
          const retryable = ['SQLITE_BUSY', '40001', '40P01'].includes(
            code ?? ''
          );
          if (!retryable || attempt >= 4) throw error;
          await new Promise((resolve) =>
            setTimeout(resolve, 25 * 2 ** attempt)
          );
        }
      }
    });
  }

  public async inspect(input: unknown): Promise<HistoricalImportInspection> {
    const artifact = this.validate(input);
    return this.connection.transaction('SERIALIZABLE', (manager) =>
      inspectHistoricalImport(manager, artifact)
    );
  }

  public async status() {
    return this.connection.transaction((manager) =>
      historicalImportStatus(manager)
    );
  }

  private exactRepeatSummary(
    artifact: WholphinHistoryArtifact,
    inspection: HistoricalImportInspection
  ): HistoricalDataImportSummary {
    return {
      datasetId: artifact.datasetId,
      schema: artifact.schema,
      disposition: 'exact-repeat',
      observedRange: inspection.observedRange,
      historicalCompleteness: 'not-asserted',
      viewersCreated: 0,
      viewersMatched: artifact.viewers.length,
      mediaCreated: 0,
      mediaMatched: artifact.media.length,
      seasonsCreated: 0,
      seasonsMatched: artifact.seasons.length,
      episodesCreated: 0,
      episodesMatched: artifact.episodes.length,
      libraryFactsCreated: 0,
      libraryFactsMatched: artifact.libraryFacts.length,
      viewingFactsCreated: 0,
      viewingFactsMatched: artifact.viewingFacts.length,
      completionFactsCreated: 0,
      completionFactsMatched: artifact.completionFacts?.length ?? 0,
      activityFactsCreated: 0,
      activityFactsMatched: artifact.activityFacts?.length ?? 0,
      untimedEvidenceFactsCreated: 0,
      untimedEvidenceFactsMatched: artifact.untimedEvidenceFacts?.length ?? 0,
      conflicts: 0,
    };
  }

  private async merge(
    manager: EntityManager,
    artifact: WholphinHistoryArtifact,
    inspection: HistoricalImportInspection,
    checkpoint: SourceCheckpoint
  ): Promise<HistoricalDataImportSummary> {
    const summary: HistoricalDataImportSummary = {
      datasetId: artifact.datasetId,
      schema: artifact.schema,
      disposition:
        inspection.disposition as HistoricalDataImportSummary['disposition'],
      observedRange: inspection.observedRange,
      historicalCompleteness: 'not-asserted',
      viewersCreated: 0,
      viewersMatched: 0,
      mediaCreated: 0,
      mediaMatched: 0,
      seasonsCreated: 0,
      seasonsMatched: 0,
      episodesCreated: 0,
      episodesMatched: 0,
      libraryFactsCreated: 0,
      libraryFactsMatched: 0,
      viewingFactsCreated: 0,
      viewingFactsMatched: 0,
      completionFactsCreated: 0,
      completionFactsMatched: 0,
      activityFactsCreated: 0,
      activityFactsMatched: 0,
      untimedEvidenceFactsCreated: 0,
      untimedEvidenceFactsMatched: 0,
      conflicts: 0,
    };
    const now = new Date();
    const generation = artifact.contentHash.slice('sha256:'.length);
    const runRepository = manager.getRepository(HydrationRun);
    const run = await runRepository.save(
      new HydrationRun({
        source: 'jellyfin',
        sourceScope: artifact.jellyfinServerScope,
        sourceGeneration: generation,
        stage: 'historical-import',
        status: HydrationRunStatus.RUNNING,
        startedAt: now,
        coverageStartedAt: artifact.coverage.startedAt
          ? new Date(artifact.coverage.startedAt)
          : null,
        coverageEndedAt: artifact.coverage.endedAt
          ? new Date(artifact.coverage.endedAt)
          : null,
      })
    );

    const mediaByArtifactId = new Map<string, CanonicalMedia>();
    for (const item of artifact.media) {
      const mediaType = mediaTypeMap[item.mediaType];
      const identityRepository = manager.getRepository(CanonicalMediaIdentity);
      const matches = (
        await Promise.all(
          item.identities.map((identity) =>
            identityRepository.findOneBy({
              provider: identity.provider,
              sourceScope: identity.sourceScope,
              mediaType,
              value: identity.value,
            })
          )
        )
      ).filter((identity): identity is CanonicalMediaIdentity =>
        Boolean(identity)
      );
      const canonicalIds = new Set(
        matches.map((match) => match.canonicalMediaId)
      );
      if (canonicalIds.size > 1) {
        summary.conflicts++;
        throw new Error('Historical import canonical identity conflict');
      }
      const mediaRepository = manager.getRepository(CanonicalMedia);
      let canonical = matches.length
        ? await mediaRepository.findOneByOrFail({
            id: matches[0].canonicalMediaId,
          })
        : undefined;
      if (!canonical) {
        const tmdb = item.identities.find(
          (identity) => identity.provider === 'tmdb'
        );
        const currentMedia = tmdb
          ? await manager.getRepository(Media).findOneBy({
              tmdbId: Number(tmdb.value),
              mediaType:
                item.mediaType === 'movie' ? MediaType.MOVIE : MediaType.TV,
            })
          : null;
        canonical = await mediaRepository.save(
          new CanonicalMedia({
            mediaType,
            titleSnapshot: item.title,
            year: item.year,
            currentMediaId: currentMedia?.id,
          })
        );
        summary.mediaCreated++;
      } else {
        summary.mediaMatched++;
        if (!canonical.titleSnapshot && item.title)
          canonical.titleSnapshot = item.title;
        if (!canonical.year && item.year) canonical.year = item.year;
        await mediaRepository.save(canonical);
      }
      for (const identity of item.identities) {
        const existing = await identityRepository.findOneBy({
          provider: identity.provider,
          sourceScope: identity.sourceScope,
          mediaType,
          value: identity.value,
        });
        if (existing && existing.canonicalMediaId !== canonical.id) {
          summary.conflicts++;
          throw new Error('Historical import identity ownership conflict');
        }
        if (!existing) {
          await identityRepository.save(
            new CanonicalMediaIdentity({
              canonicalMediaId: canonical.id,
              mediaType,
              provider: identity.provider,
              sourceScope: identity.sourceScope,
              value: identity.value,
            })
          );
        }
      }
      mediaByArtifactId.set(item.id, canonical);
    }

    const seasonByArtifactId = new Map<string, CanonicalSeason>();
    for (const item of artifact.seasons) {
      const series = mediaByArtifactId.get(item.seriesId);
      if (!series || series.mediaType !== LibraryMediaType.SERIES) {
        throw new Error('Historical import missing canonical series');
      }
      const repository = manager.getRepository(CanonicalSeason);
      let season = await repository.findOneBy({
        seriesId: series.id,
        seasonNumber: item.seasonNumber,
      });
      if (season) summary.seasonsMatched++;
      else {
        season = await repository.save(
          new CanonicalSeason({
            seriesId: series.id,
            seasonNumber: item.seasonNumber,
          })
        );
        summary.seasonsCreated++;
      }
      if (item.jellyfinItemId) {
        const identities = manager.getRepository(CanonicalSeasonIdentity);
        const existing = await identities.findOneBy({
          provider: 'jellyfin',
          sourceScope: artifact.jellyfinServerScope,
          value: item.jellyfinItemId,
        });
        if (existing && existing.canonicalSeasonId !== season.id) {
          throw new Error('Historical import season identity conflict');
        }
        if (!existing) {
          await identities.save(
            new CanonicalSeasonIdentity({
              canonicalSeasonId: season.id,
              provider: 'jellyfin',
              sourceScope: artifact.jellyfinServerScope,
              value: item.jellyfinItemId,
            })
          );
        }
      }
      seasonByArtifactId.set(item.id, season);
    }

    const episodeByArtifactId = new Map<string, CanonicalEpisode>();
    for (const item of artifact.episodes) {
      const season = seasonByArtifactId.get(item.seasonId);
      if (!season)
        throw new Error('Historical import missing canonical season');
      const repository = manager.getRepository(CanonicalEpisode);
      let episode = await repository.findOneBy({
        seasonId: season.id,
        episodeNumber: item.episodeNumber,
      });
      if (episode) summary.episodesMatched++;
      else {
        episode = await repository.save(
          new CanonicalEpisode({
            seasonId: season.id,
            episodeNumber: item.episodeNumber,
            airDate: item.airDate,
            isSpecial: season.seasonNumber === 0,
          })
        );
        summary.episodesCreated++;
      }
      if (item.jellyfinItemId) {
        const identities = manager.getRepository(CanonicalEpisodeIdentity);
        const existing = await identities.findOneBy({
          provider: 'jellyfin',
          sourceScope: artifact.jellyfinServerScope,
          value: item.jellyfinItemId,
        });
        if (existing && existing.canonicalEpisodeId !== episode.id) {
          throw new Error('Historical import episode identity conflict');
        }
        if (!existing) {
          await identities.save(
            new CanonicalEpisodeIdentity({
              canonicalEpisodeId: episode.id,
              provider: 'jellyfin',
              sourceScope: artifact.jellyfinServerScope,
              value: item.jellyfinItemId,
            })
          );
        }
      }
      episodeByArtifactId.set(item.id, episode);
    }

    const viewerByArtifactId = new Map<string, Viewer>();
    for (const item of artifact.viewers) {
      const repository = manager.getRepository(Viewer);
      let viewer = await repository.findOneBy({
        source: 'jellyfin',
        sourceScope: artifact.jellyfinServerScope,
        sourceUserId: item.jellyfinUserId,
      });
      if (viewer) summary.viewersMatched++;
      else {
        const user = await manager.getRepository(User).findOneBy({
          jellyfinUserId: item.jellyfinUserId,
        });
        viewer = await repository.save(
          new Viewer({
            source: 'jellyfin',
            sourceScope: artifact.jellyfinServerScope,
            sourceUserId: item.jellyfinUserId,
            userId: user?.id,
          })
        );
        summary.viewersCreated++;
      }
      viewerByArtifactId.set(item.id, viewer);
    }

    for (const fact of artifact.libraryFacts) {
      const canonical = mediaByArtifactId.get(fact.mediaId);
      if (!canonical) throw new Error('Historical import missing media fact');
      const repository = manager.getRepository(LibraryPresence);
      let presence = await repository.findOneBy({
        sourceSystem: 'jellyfin',
        sourceScope: artifact.jellyfinServerScope,
        sourceItemId: fact.jellyfinItemId,
        sourceGeneration: artifact.schema,
      });
      if (presence) summary.libraryFactsMatched++;
      else {
        presence = new LibraryPresence({
          canonicalMediaId: canonical.id,
          sourceSystem: 'jellyfin',
          sourceScope: artifact.jellyfinServerScope,
          sourceItemId: fact.jellyfinItemId,
          sourceGeneration: artifact.schema,
          firstObservedAt: now,
          addedAt: fact.addedAt ? new Date(fact.addedAt) : null,
          addedAtSource: fact.addedAt
            ? (fact.provenance ?? 'jellyfin-date-created')
            : null,
          addedAtConfidence: fact.addedAt ? 'exact' : null,
          lastSeenAt: null,
          removedAt: null,
          jellyfinVisible: false,
          isCurrent: false,
          reconciliationState: LibraryReconciliationState.STALE,
        });
        await repository.save(presence);
        summary.libraryFactsCreated++;
      }
    }

    for (const fact of artifact.viewingFacts) {
      const viewer = viewerByArtifactId.get(fact.viewerId);
      const canonical = mediaByArtifactId.get(fact.mediaId);
      const episode = fact.episodeId
        ? episodeByArtifactId.get(fact.episodeId)
        : undefined;
      if (!viewer || !canonical || (fact.episodeId && !episode)) {
        throw new Error('Historical import missing viewing relation');
      }
      const repository = manager.getRepository(ViewingEvidence);
      const existing = await repository.findOneBy({
        source: 'jellyfin',
        sourceScope: artifact.jellyfinServerScope,
        sourceClass: fact.sourceClass,
        sourceActivityId: fact.id,
      });
      if (existing) {
        summary.viewingFactsMatched++;
        continue;
      }
      await repository.save(
        new ViewingEvidence({
          source: 'jellyfin',
          sourceScope: artifact.jellyfinServerScope,
          sourceClass: fact.sourceClass,
          sourceActivityId: fact.id,
          sourceGeneration: generation,
          sourceVersion: artifact.schema,
          sourceUserId: viewer.sourceUserId,
          sourceItemId: fact.jellyfinItemId,
          viewerId: viewer.id,
          canonicalMediaId: canonical.id,
          canonicalEpisodeId: episode?.id,
          observedAt: new Date(fact.observedAt),
          observedEndAt: new Date(fact.observedEndAt),
          playbackDurationSeconds: fact.playbackDurationSeconds,
          runtimeTicks: fact.runtimeTicks,
          progressBasisPoints: fact.progressBasisPoints,
          identityResolutionState: IdentityResolutionState.RESOLVED,
          completionClassification: completionMap[fact.completion],
          completionDerivationVersion: 1,
          completionDerivedAt: now,
          provenance: fact.sourceClass,
        })
      );
      summary.viewingFactsCreated++;
    }

    for (const fact of artifact.completionFacts ?? []) {
      const viewer = viewerByArtifactId.get(fact.viewerId);
      const canonical = mediaByArtifactId.get(fact.mediaId);
      const episode = fact.episodeId
        ? episodeByArtifactId.get(fact.episodeId)
        : undefined;
      if (!viewer || !canonical || (fact.episodeId && !episode)) {
        throw new Error('Historical import missing completion relation');
      }
      const repository = manager.getRepository(ViewingEvidence);
      const existing = await repository.findOneBy({
        source: 'jellyfin',
        sourceScope: artifact.jellyfinServerScope,
        sourceClass: 'historical-manual-completion',
        sourceActivityId: fact.id,
      });
      if (existing) {
        summary.completionFactsMatched++;
        continue;
      }
      await repository.save(
        new ViewingEvidence({
          source: 'jellyfin',
          sourceScope: artifact.jellyfinServerScope,
          sourceClass: 'historical-manual-completion',
          sourceActivityId: fact.id,
          sourceGeneration: generation,
          sourceVersion: artifact.schema,
          sourceUserId: viewer.sourceUserId,
          sourceItemId: fact.jellyfinItemId,
          viewerId: viewer.id,
          canonicalMediaId: canonical.id,
          canonicalEpisodeId: episode?.id,
          observedAt: null,
          observedEndAt: null,
          identityResolutionState: IdentityResolutionState.RESOLVED,
          completionClassification: ViewingCompletionClassification.CONFIRMED,
          completionDerivationVersion: 1,
          completionDerivedAt: now,
          provenance: fact.provenance,
        })
      );
      summary.completionFactsCreated++;
    }

    for (const fact of artifact.activityFacts ?? []) {
      const canonical = mediaByArtifactId.get(fact.mediaId);
      if (!canonical) {
        throw new Error('Historical import missing activity relation');
      }
      const repository = manager.getRepository(ViewingEvidence);
      const existing = await repository.findOneBy({
        source: 'jellyfin',
        sourceScope: artifact.jellyfinServerScope,
        sourceClass: 'historical-manual-activity',
        sourceActivityId: fact.id,
      });
      if (existing) {
        summary.activityFactsMatched++;
        continue;
      }
      const activityAt = new Date(fact.activityAt);
      await repository.save(
        new ViewingEvidence({
          source: 'jellyfin',
          sourceScope: artifact.jellyfinServerScope,
          sourceClass: 'historical-manual-activity',
          sourceActivityId: fact.id,
          sourceGeneration: generation,
          sourceVersion: artifact.schema,
          sourceItemId: fact.jellyfinItemId,
          canonicalMediaId: canonical.id,
          observedAt: activityAt,
          observedEndAt: activityAt,
          identityResolutionState: IdentityResolutionState.RESOLVED,
          completionClassification: ViewingCompletionClassification.UNKNOWN,
          completionDerivationVersion: 1,
          completionDerivedAt: now,
          provenance: fact.provenance,
        })
      );
      summary.activityFactsCreated++;
    }

    for (const fact of artifact.untimedEvidenceFacts ?? []) {
      const viewer = viewerByArtifactId.get(fact.viewerId);
      const canonical = mediaByArtifactId.get(fact.mediaId);
      const episode = fact.episodeId
        ? episodeByArtifactId.get(fact.episodeId)
        : undefined;
      if (!viewer || !canonical || (fact.episodeId && !episode)) {
        throw new Error('Historical import missing untimed evidence relation');
      }
      const repository = manager.getRepository(ViewingEvidence);
      const existing = await repository.findOneBy({
        source: 'jellyfin',
        sourceScope: artifact.jellyfinServerScope,
        sourceClass: 'historical-untimed-evidence',
        sourceActivityId: fact.id,
      });
      if (existing) {
        summary.untimedEvidenceFactsMatched++;
        continue;
      }
      await repository.save(
        new ViewingEvidence({
          source: 'jellyfin',
          sourceScope: artifact.jellyfinServerScope,
          sourceClass: 'historical-untimed-evidence',
          sourceActivityId: fact.id,
          sourceGeneration: generation,
          sourceVersion: artifact.schema,
          sourceUserId: viewer.sourceUserId,
          sourceItemId: fact.jellyfinItemId,
          viewerId: viewer.id,
          canonicalMediaId: canonical.id,
          canonicalEpisodeId: episode?.id,
          observedAt: null,
          observedEndAt: null,
          playbackDurationSeconds: fact.playbackDurationSeconds,
          runtimeTicks: fact.runtimeTicks,
          progressBasisPoints: fact.progressBasisPoints,
          identityResolutionState: IdentityResolutionState.RESOLVED,
          completionClassification: completionMap[fact.completion],
          completionDerivationVersion: 1,
          completionDerivedAt: now,
          provenance: fact.provenance,
        })
      );
      summary.untimedEvidenceFactsCreated++;
    }

    run.status = HydrationRunStatus.SUCCEEDED;
    run.completedAt = now;
    run.rowsInspected =
      artifact.media.length +
      artifact.libraryFacts.length +
      artifact.viewingFacts.length +
      (artifact.completionFacts?.length ?? 0) +
      (artifact.activityFacts?.length ?? 0) +
      (artifact.untimedEvidenceFacts?.length ?? 0);
    run.rowsCreated =
      summary.viewersCreated +
      summary.mediaCreated +
      summary.seasonsCreated +
      summary.episodesCreated +
      summary.libraryFactsCreated +
      summary.viewingFactsCreated +
      summary.completionFactsCreated +
      summary.activityFactsCreated +
      summary.untimedEvidenceFactsCreated;
    run.rowsUpdated =
      summary.viewersMatched +
      summary.mediaMatched +
      summary.libraryFactsMatched +
      summary.viewingFactsMatched +
      summary.completionFactsMatched +
      summary.activityFactsMatched +
      summary.untimedEvidenceFactsMatched;
    await runRepository.save(run);
    const checkpoints = manager.getRepository(SourceCheckpoint);
    checkpoint.sourceGeneration = generation;
    checkpoint.status = SourceCheckpointStatus.CURRENT;
    checkpoint.lastAttemptAt = now;
    checkpoint.lastSuccessfulAt = now;
    checkpoint.lastRunId = run.id;
    await checkpoints.save(checkpoint);
    return summary;
  }
}

const historicalDataImport = new HistoricalDataImportService();
export default historicalDataImport;
