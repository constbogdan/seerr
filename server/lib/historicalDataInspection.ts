import {
  HydrationRunStatus,
  IdentityResolutionState,
  LibraryMediaType,
  LibraryReconciliationState,
  SourceCheckpointStatus,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import {
  CanonicalEpisode,
  CanonicalEpisodeIdentity,
  CanonicalMediaIdentity,
  CanonicalSeason,
  CanonicalSeasonIdentity,
} from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import {
  HydrationRun,
  SourceCheckpoint,
} from '@server/entity/LibraryHydration';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import type { WholphinHistoryArtifact } from '@server/lib/wholphinHistory';
import type { EntityManager } from 'typeorm';

export type HistoricalImportDisposition =
  | 'first-import'
  | 'exact-repeat'
  | 'repair'
  | 'additive-cumulative'
  | 'corrected-facts'
  | 'regressive-artifact'
  | 'historical-omission';

export interface HistoricalObservedRange {
  startedAt: string | null;
  endedAt: string | null;
  completeness: 'not-asserted';
}

export interface HistoricalImportIssue {
  code:
    | 'identity-conflict'
    | 'corrected-fact'
    | 'coverage-regression'
    | 'historical-omission';
  factType: string;
  sourceIdentity: string;
}

export interface HistoricalImportInspection {
  valid: true;
  importable: boolean;
  disposition: HistoricalImportDisposition;
  schema: 'wholphin-history-v1';
  datasetId: string;
  contentHash: string;
  observedRange: HistoricalObservedRange;
  acceptedObservedRange: HistoricalObservedRange | null;
  acceptedContentHash: string | null;
  counts: {
    viewers: number;
    media: number;
    seasons: number;
    episodes: number;
    libraryFacts: number;
    viewingFacts: number;
    completionFacts: number;
    activityFacts: number;
    untimedEvidenceFacts: number;
  };
  comparison: {
    exactFacts: number;
    missingFacts: number;
    correctedFacts: number;
    omittedFacts: number;
  };
  issues: HistoricalImportIssue[];
}

export interface HistoricalImportStatus {
  state: 'not-imported' | 'accepted';
  observedRange: HistoricalObservedRange | null;
  contentHash: string | null;
}

export class HistoricalImportConflictError extends Error {
  public readonly statusCode = 409;

  constructor(public readonly inspection: HistoricalImportInspection) {
    const reason = inspection.issues.some(
      (issue) => issue.code === 'identity-conflict'
    )
      ? 'canonical identity conflict'
      : inspection.disposition;
    super(`Historical import rejected: ${reason}`);
    this.name = 'HistoricalImportConflictError';
  }
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

const historicalClasses = new Set([
  'historical-session',
  'historical-playback-reporting',
  'historical-manual-completion',
  'historical-manual-activity',
  'historical-untimed-evidence',
]);

const iso = (value?: Date | string | null): string | null =>
  value ? new Date(value).toISOString() : null;

const normalized = (value: Record<string, unknown>): string =>
  JSON.stringify(
    Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
    )
  );

const range = (
  startedAt?: Date | string | null,
  endedAt?: Date | string | null
): HistoricalObservedRange => ({
  startedAt: iso(startedAt),
  endedAt: iso(endedAt),
  completeness: 'not-asserted',
});

const evidenceKey = (sourceClass: string, sourceActivityId: string) =>
  `${sourceClass}:${sourceActivityId}`;

const contentHash = (value?: string | null) =>
  value ? (value.startsWith('sha256:') ? value : `sha256:${value}`) : null;

const persistedEvidenceIdentity = (fact: ViewingEvidence) =>
  normalized({
    sourceUserId: fact.sourceUserId ?? null,
    sourceItemId: fact.sourceItemId ?? null,
    viewerId: fact.viewerId ?? null,
    canonicalMediaId: fact.canonicalMediaId ?? null,
    canonicalEpisodeId: fact.canonicalEpisodeId ?? null,
  });

const persistedEvidencePayload = (fact: ViewingEvidence) =>
  normalized({
    observedAt: iso(fact.observedAt),
    observedEndAt: iso(fact.observedEndAt),
    playbackDurationSeconds: fact.playbackDurationSeconds ?? null,
    playbackPositionTicks: fact.playbackPositionTicks ?? null,
    runtimeTicks: fact.runtimeTicks ?? null,
    progressBasisPoints: fact.progressBasisPoints ?? null,
    identityResolutionState: fact.identityResolutionState,
    completionClassification: fact.completionClassification,
    completionDerivationVersion: fact.completionDerivationVersion ?? null,
    provenance: fact.provenance ?? null,
  });

const artifactCounts = (artifact: WholphinHistoryArtifact) => ({
  viewers: artifact.viewers.length,
  media: artifact.media.length,
  seasons: artifact.seasons.length,
  episodes: artifact.episodes.length,
  libraryFacts: artifact.libraryFacts.length,
  viewingFacts: artifact.viewingFacts.length,
  completionFacts: artifact.completionFacts?.length ?? 0,
  activityFacts: artifact.activityFacts?.length ?? 0,
  untimedEvidenceFacts: artifact.untimedEvidenceFacts?.length ?? 0,
});

const acceptedRun = async (
  manager: EntityManager,
  sourceScope: string,
  checkpoint: SourceCheckpoint | null
) => {
  const repository = manager.getRepository(HydrationRun);
  if (checkpoint?.lastRunId) {
    const run = await repository.findOneBy({
      id: checkpoint.lastRunId,
      source: 'jellyfin',
      sourceScope,
      stage: 'historical-import',
      status: HydrationRunStatus.SUCCEEDED,
    });
    if (run) return run;
  }
  return repository.findOne({
    where: {
      source: 'jellyfin',
      sourceScope,
      stage: 'historical-import',
      status: HydrationRunStatus.SUCCEEDED,
    },
    order: { completedAt: 'DESC', id: 'DESC' },
  });
};

export const historicalImportStatus = async (
  manager: EntityManager,
  sourceScope?: string
): Promise<HistoricalImportStatus> => {
  const checkpointRepository = manager.getRepository(SourceCheckpoint);
  const checkpoint = sourceScope
    ? await checkpointRepository.findOneBy({
        source: 'jellyfin',
        sourceScope,
        stage: 'historical-import',
      })
    : await checkpointRepository.findOne({
        where: {
          source: 'jellyfin',
          stage: 'historical-import',
          status: SourceCheckpointStatus.CURRENT,
        },
        order: { lastSuccessfulAt: 'DESC', id: 'DESC' },
      });
  if (!checkpoint || checkpoint.status !== SourceCheckpointStatus.CURRENT) {
    return { state: 'not-imported', observedRange: null, contentHash: null };
  }
  const run = await acceptedRun(manager, checkpoint.sourceScope, checkpoint);
  return {
    state: 'accepted',
    observedRange: run
      ? range(run.coverageStartedAt, run.coverageEndedAt)
      : null,
    contentHash: contentHash(checkpoint.sourceGeneration),
  };
};

export const inspectHistoricalImport = async (
  manager: EntityManager,
  artifact: WholphinHistoryArtifact
): Promise<HistoricalImportInspection> => {
  const issues: HistoricalImportIssue[] = [];
  const addIssue = (issue: HistoricalImportIssue) => {
    if (issues.length < 100) issues.push(issue);
  };
  let exactFacts = 0;
  let missingFacts = 0;
  let correctedFacts = 0;
  let omittedFacts = 0;

  const checkpoint = await manager.getRepository(SourceCheckpoint).findOneBy({
    source: 'jellyfin',
    sourceScope: artifact.jellyfinServerScope,
    stage: 'historical-import',
  });
  const accepted = await acceptedRun(
    manager,
    artifact.jellyfinServerScope,
    checkpoint
  );
  const acceptedHash =
    checkpoint?.sourceGeneration ?? accepted?.sourceGeneration ?? null;
  const hasAcceptedImport = Boolean(
    accepted ||
    (checkpoint?.status === SourceCheckpointStatus.CURRENT && acceptedHash)
  );
  const incomingRange = range(
    artifact.coverage.startedAt,
    artifact.coverage.endedAt
  );
  const priorRange = accepted
    ? range(accepted.coverageStartedAt, accepted.coverageEndedAt)
    : null;

  if (priorRange?.startedAt && priorRange.endedAt) {
    if (
      !incomingRange.startedAt ||
      !incomingRange.endedAt ||
      incomingRange.startedAt > priorRange.startedAt ||
      incomingRange.endedAt < priorRange.endedAt
    ) {
      addIssue({
        code: 'coverage-regression',
        factType: 'coverage',
        sourceIdentity: artifact.datasetId,
      });
    }
  } else if (
    hasAcceptedImport &&
    acceptedHash !== artifact.contentHash.slice('sha256:'.length)
  ) {
    addIssue({
      code: 'coverage-regression',
      factType: 'accepted-checkpoint-without-range',
      sourceIdentity: artifact.datasetId,
    });
  }

  const mediaIdentities = await manager
    .getRepository(CanonicalMediaIdentity)
    .find();
  const mediaIdentityMap = new Map(
    mediaIdentities.map((identity) => [
      [
        identity.provider,
        identity.sourceScope,
        identity.mediaType,
        identity.value,
      ].join(':'),
      identity.canonicalMediaId,
    ])
  );
  const mediaIds = new Map<string, number>();
  for (const item of artifact.media) {
    const mediaType =
      item.mediaType === 'movie'
        ? LibraryMediaType.MOVIE
        : LibraryMediaType.SERIES;
    const owners = new Set(
      item.identities
        .map((identity) =>
          mediaIdentityMap.get(
            [
              identity.provider,
              identity.sourceScope,
              mediaType,
              identity.value,
            ].join(':')
          )
        )
        .filter((owner): owner is number => owner !== undefined)
    );
    if (owners.size > 1) {
      addIssue({
        code: 'identity-conflict',
        factType: 'media',
        sourceIdentity: item.id,
      });
      correctedFacts++;
    } else if (owners.size === 1) {
      const owner = [...owners][0];
      mediaIds.set(item.id, owner);
      if (hasAcceptedImport) {
        for (const identity of item.identities) {
          const persistedValues = mediaIdentities
            .filter(
              (persisted) =>
                persisted.canonicalMediaId === owner &&
                persisted.provider === identity.provider &&
                persisted.sourceScope === identity.sourceScope &&
                persisted.mediaType === mediaType
            )
            .map((persisted) => persisted.value);
          if (
            persistedValues.length > 0 &&
            !persistedValues.includes(identity.value)
          ) {
            addIssue({
              code: 'identity-conflict',
              factType: 'media-identity',
              sourceIdentity: item.id,
            });
            correctedFacts++;
          }
        }
      }
      for (const identity of item.identities) {
        const key = [
          identity.provider,
          identity.sourceScope,
          mediaType,
          identity.value,
        ].join(':');
        if (!mediaIdentityMap.has(key)) missingFacts++;
      }
    } else {
      missingFacts++;
    }
  }

  const seasons = await manager.getRepository(CanonicalSeason).find();
  const seasonMap = new Map(
    seasons.map((item) => [`${item.seriesId}:${item.seasonNumber}`, item.id])
  );
  const seasonIdentities = new Map(
    (
      await manager.getRepository(CanonicalSeasonIdentity).find({
        where: {
          provider: 'jellyfin',
          sourceScope: artifact.jellyfinServerScope,
        },
      })
    ).map((item) => [item.value, item.canonicalSeasonId])
  );
  const seasonIds = new Map<string, number>();
  for (const item of artifact.seasons) {
    const seriesId = mediaIds.get(item.seriesId);
    const resolved = seriesId
      ? seasonMap.get(`${seriesId}:${item.seasonNumber}`)
      : undefined;
    const identityOwner = item.jellyfinItemId
      ? seasonIdentities.get(item.jellyfinItemId)
      : undefined;
    if (identityOwner && resolved && identityOwner !== resolved) {
      addIssue({
        code: 'identity-conflict',
        factType: 'season',
        sourceIdentity: item.id,
      });
      correctedFacts++;
    } else if (identityOwner ?? resolved) {
      const owner = (identityOwner ?? resolved) as number;
      seasonIds.set(item.id, owner);
      if (
        hasAcceptedImport &&
        item.jellyfinItemId &&
        [...seasonIdentities.entries()].some(
          ([value, seasonId]) =>
            seasonId === owner && value !== item.jellyfinItemId
        ) &&
        !identityOwner
      ) {
        addIssue({
          code: 'identity-conflict',
          factType: 'season-identity',
          sourceIdentity: item.id,
        });
        correctedFacts++;
      }
      if (item.jellyfinItemId && !identityOwner) missingFacts++;
    } else {
      missingFacts++;
    }
  }

  const episodes = await manager.getRepository(CanonicalEpisode).find();
  const episodeMap = new Map(
    episodes.map((item) => [`${item.seasonId}:${item.episodeNumber}`, item.id])
  );
  const episodeIdentities = new Map(
    (
      await manager.getRepository(CanonicalEpisodeIdentity).find({
        where: {
          provider: 'jellyfin',
          sourceScope: artifact.jellyfinServerScope,
        },
      })
    ).map((item) => [item.value, item.canonicalEpisodeId])
  );
  const episodeIds = new Map<string, number>();
  for (const item of artifact.episodes) {
    const seasonId = seasonIds.get(item.seasonId);
    const resolved = seasonId
      ? episodeMap.get(`${seasonId}:${item.episodeNumber}`)
      : undefined;
    const identityOwner = item.jellyfinItemId
      ? episodeIdentities.get(item.jellyfinItemId)
      : undefined;
    if (identityOwner && resolved && identityOwner !== resolved) {
      addIssue({
        code: 'identity-conflict',
        factType: 'episode',
        sourceIdentity: item.id,
      });
      correctedFacts++;
    } else if (identityOwner ?? resolved) {
      const owner = (identityOwner ?? resolved) as number;
      episodeIds.set(item.id, owner);
      if (
        hasAcceptedImport &&
        item.jellyfinItemId &&
        [...episodeIdentities.entries()].some(
          ([value, episodeId]) =>
            episodeId === owner && value !== item.jellyfinItemId
        ) &&
        !identityOwner
      ) {
        addIssue({
          code: 'identity-conflict',
          factType: 'episode-identity',
          sourceIdentity: item.id,
        });
        correctedFacts++;
      }
      if (item.jellyfinItemId && !identityOwner) missingFacts++;
    } else {
      missingFacts++;
    }
  }

  const viewers = await manager.getRepository(Viewer).find({
    where: {
      source: 'jellyfin',
      sourceScope: artifact.jellyfinServerScope,
    },
  });
  const viewerBySource = new Map(
    viewers.map((viewer) => [viewer.sourceUserId, viewer])
  );
  const viewerIds = new Map(
    artifact.viewers
      .map(
        (viewer) =>
          [viewer.id, viewerBySource.get(viewer.jellyfinUserId)?.id] as const
      )
      .filter((entry): entry is readonly [string, number] => Boolean(entry[1]))
  );
  const viewerSourceIds = new Map(
    artifact.viewers.map((viewer) => [viewer.id, viewer.jellyfinUserId])
  );
  missingFacts += artifact.viewers.filter(
    (viewer) => !viewerBySource.has(viewer.jellyfinUserId)
  ).length;

  const persistedPresences = await manager.getRepository(LibraryPresence).find({
    where: {
      sourceSystem: 'jellyfin',
      sourceScope: artifact.jellyfinServerScope,
      sourceGeneration: artifact.schema,
    },
  });
  const presenceByItem = new Map(
    persistedPresences.map((item) => [item.sourceItemId, item])
  );
  const incomingPresenceKeys = new Set<string>();
  for (const fact of artifact.libraryFacts) {
    incomingPresenceKeys.add(fact.jellyfinItemId);
    const persisted = presenceByItem.get(fact.jellyfinItemId);
    if (!persisted) {
      missingFacts++;
      continue;
    }
    const expectedIdentity = normalized({
      canonicalMediaId: mediaIds.get(fact.mediaId) ?? null,
    });
    const actualIdentity = normalized({
      canonicalMediaId: persisted.canonicalMediaId,
    });
    const expectedPayload = normalized({
      addedAt: iso(fact.addedAt),
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
    const actualPayload = normalized({
      addedAt: iso(persisted.addedAt),
      addedAtSource: persisted.addedAtSource ?? null,
      addedAtConfidence: persisted.addedAtConfidence ?? null,
      lastSeenAt: iso(persisted.lastSeenAt),
      removedAt: iso(persisted.removedAt),
      jellyfinVisible: persisted.jellyfinVisible ?? null,
      isCurrent: persisted.isCurrent,
      reconciliationState: persisted.reconciliationState,
    });
    if (expectedIdentity !== actualIdentity) {
      correctedFacts++;
      addIssue({
        code: 'identity-conflict',
        factType: 'library',
        sourceIdentity: fact.id,
      });
    } else if (expectedPayload !== actualPayload) {
      correctedFacts++;
      addIssue({
        code: 'corrected-fact',
        factType: 'library',
        sourceIdentity: fact.id,
      });
    } else exactFacts++;
  }

  const persistedEvidence = (
    await manager.getRepository(ViewingEvidence).find({
      where: {
        source: 'jellyfin',
        sourceScope: artifact.jellyfinServerScope,
        sourceVersion: artifact.schema,
      },
    })
  ).filter((item) => historicalClasses.has(item.sourceClass));
  const evidenceByKey = new Map(
    persistedEvidence.map((item) => [
      evidenceKey(item.sourceClass, item.sourceActivityId),
      item,
    ])
  );
  const incomingEvidenceKeys = new Set<string>();

  const compareEvidence = (
    factType: string,
    sourceClass: string,
    sourceActivityId: string,
    identity: Record<string, unknown>,
    payload: Record<string, unknown>
  ) => {
    const key = evidenceKey(sourceClass, sourceActivityId);
    incomingEvidenceKeys.add(key);
    const persisted = evidenceByKey.get(key);
    if (!persisted) {
      missingFacts++;
      return;
    }
    if (normalized(identity) !== persistedEvidenceIdentity(persisted)) {
      correctedFacts++;
      addIssue({
        code: 'identity-conflict',
        factType,
        sourceIdentity: sourceActivityId,
      });
    } else if (normalized(payload) !== persistedEvidencePayload(persisted)) {
      correctedFacts++;
      addIssue({
        code: 'corrected-fact',
        factType,
        sourceIdentity: sourceActivityId,
      });
    } else exactFacts++;
  };

  for (const fact of artifact.viewingFacts) {
    compareEvidence(
      'viewing',
      fact.sourceClass,
      fact.id,
      {
        sourceUserId: viewerSourceIds.get(fact.viewerId) ?? null,
        sourceItemId: fact.jellyfinItemId,
        viewerId: viewerIds.get(fact.viewerId) ?? null,
        canonicalMediaId: mediaIds.get(fact.mediaId) ?? null,
        canonicalEpisodeId: fact.episodeId
          ? (episodeIds.get(fact.episodeId) ?? null)
          : null,
      },
      {
        observedAt: iso(fact.observedAt),
        observedEndAt: iso(fact.observedEndAt),
        playbackDurationSeconds: fact.playbackDurationSeconds,
        playbackPositionTicks: null,
        runtimeTicks: fact.runtimeTicks ?? null,
        progressBasisPoints: fact.progressBasisPoints ?? null,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: completionMap[fact.completion],
        completionDerivationVersion: 1,
        provenance: fact.sourceClass,
      }
    );
  }
  for (const fact of artifact.completionFacts ?? []) {
    compareEvidence(
      'completion',
      'historical-manual-completion',
      fact.id,
      {
        sourceUserId: viewerSourceIds.get(fact.viewerId) ?? null,
        sourceItemId: fact.jellyfinItemId,
        viewerId: viewerIds.get(fact.viewerId) ?? null,
        canonicalMediaId: mediaIds.get(fact.mediaId) ?? null,
        canonicalEpisodeId: fact.episodeId
          ? (episodeIds.get(fact.episodeId) ?? null)
          : null,
      },
      {
        observedAt: null,
        observedEndAt: null,
        playbackDurationSeconds: null,
        playbackPositionTicks: null,
        runtimeTicks: null,
        progressBasisPoints: null,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.CONFIRMED,
        completionDerivationVersion: 1,
        provenance: fact.provenance,
      }
    );
  }
  for (const fact of artifact.activityFacts ?? []) {
    compareEvidence(
      'activity',
      'historical-manual-activity',
      fact.id,
      {
        sourceUserId: null,
        sourceItemId: fact.jellyfinItemId,
        viewerId: null,
        canonicalMediaId: mediaIds.get(fact.mediaId) ?? null,
        canonicalEpisodeId: null,
      },
      {
        observedAt: iso(fact.activityAt),
        observedEndAt: iso(fact.activityAt),
        playbackDurationSeconds: null,
        playbackPositionTicks: null,
        runtimeTicks: null,
        progressBasisPoints: null,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: ViewingCompletionClassification.UNKNOWN,
        completionDerivationVersion: 1,
        provenance: fact.provenance,
      }
    );
  }
  for (const fact of artifact.untimedEvidenceFacts ?? []) {
    compareEvidence(
      'untimed-evidence',
      'historical-untimed-evidence',
      fact.id,
      {
        sourceUserId: viewerSourceIds.get(fact.viewerId) ?? null,
        sourceItemId: fact.jellyfinItemId,
        viewerId: viewerIds.get(fact.viewerId) ?? null,
        canonicalMediaId: mediaIds.get(fact.mediaId) ?? null,
        canonicalEpisodeId: fact.episodeId
          ? (episodeIds.get(fact.episodeId) ?? null)
          : null,
      },
      {
        observedAt: null,
        observedEndAt: null,
        playbackDurationSeconds: fact.playbackDurationSeconds ?? null,
        playbackPositionTicks: null,
        runtimeTicks: fact.runtimeTicks ?? null,
        progressBasisPoints: fact.progressBasisPoints ?? null,
        identityResolutionState: IdentityResolutionState.RESOLVED,
        completionClassification: completionMap[fact.completion],
        completionDerivationVersion: 1,
        provenance: fact.provenance,
      }
    );
  }

  if (hasAcceptedImport) {
    for (const persisted of persistedPresences) {
      if (!incomingPresenceKeys.has(persisted.sourceItemId)) {
        omittedFacts++;
        addIssue({
          code: 'historical-omission',
          factType: 'library',
          sourceIdentity: persisted.sourceItemId,
        });
      }
    }
    for (const persisted of persistedEvidence) {
      const key = evidenceKey(
        persisted.sourceClass,
        persisted.sourceActivityId
      );
      if (!incomingEvidenceKeys.has(key)) {
        omittedFacts++;
        addIssue({
          code: 'historical-omission',
          factType: 'viewing-evidence',
          sourceIdentity: key,
        });
      }
    }
  }

  const coverageRegression = issues.some(
    (issue) => issue.code === 'coverage-regression'
  );
  let disposition: HistoricalImportDisposition;
  if (correctedFacts > 0) disposition = 'corrected-facts';
  else if (omittedFacts > 0) disposition = 'historical-omission';
  else if (coverageRegression) disposition = 'regressive-artifact';
  else if (!hasAcceptedImport) disposition = 'first-import';
  else if (acceptedHash === artifact.contentHash.slice('sha256:'.length)) {
    disposition = missingFacts > 0 ? 'repair' : 'exact-repeat';
  } else disposition = 'additive-cumulative';

  return {
    valid: true,
    importable: [
      'first-import',
      'exact-repeat',
      'repair',
      'additive-cumulative',
    ].includes(disposition),
    disposition,
    schema: artifact.schema,
    datasetId: artifact.datasetId,
    contentHash: artifact.contentHash,
    observedRange: incomingRange,
    acceptedObservedRange: priorRange,
    acceptedContentHash: contentHash(acceptedHash),
    counts: artifactCounts(artifact),
    comparison: {
      exactFacts,
      missingFacts,
      correctedFacts,
      omittedFacts,
    },
    issues,
  };
};
