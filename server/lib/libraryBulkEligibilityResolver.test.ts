import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  LibraryMediaType,
  LibraryRemovalSource,
} from '@server/constants/libraryHistory';
import { MediaStatus, MediaType } from '@server/constants/media';
import {
  RemovalExecutionInitiator,
  RemovalExecutionPhase,
  RemovalExecutionState,
  RemovalTargetType,
} from '@server/constants/removal';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalMedia,
  CanonicalSeason,
} from '@server/entity/CanonicalMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
} from '@server/entity/LibraryHistory';
import Media from '@server/entity/Media';
import {
  RemovalExecution,
  RemovalExecutionClaim,
} from '@server/entity/RemovalExecution';
import libraryBulkActions from '@server/lib/libraryBulkActions';
import { resolveCurrentRemovalTargetsForEligibility } from '@server/lib/libraryBulkEligibilityResolver';
import {
  MediaRemovalError,
  resolveCurrentRemovalTarget,
  type RemovalTarget,
  type ResolvedRemovalTarget,
} from '@server/lib/mediaRemoval';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';

setupTestDb();

beforeEach(() => {
  getSettings().radarr = [
    {
      id: 1,
      name: 'Eligibility Radarr',
      hostname: 'radarr.invalid',
      port: 7878,
      apiKey: 'test',
      useSsl: false,
      is4k: false,
      isDefault: true,
    } as RadarrSettings,
  ];
  getSettings().sonarr = [
    {
      id: 2,
      name: 'Eligibility Sonarr',
      hostname: 'sonarr.invalid',
      port: 8989,
      apiKey: 'test',
      useSsl: false,
      is4k: false,
      isDefault: true,
    } as SonarrSettings,
  ];
});

let fixtureSequence = 0;

const createCanonical = async ({
  mediaType,
  seerrMediaType,
  serviceId,
}: {
  mediaType: LibraryMediaType;
  seerrMediaType?: MediaType;
  serviceId?: number;
}) => {
  fixtureSequence += 1;
  const media = await getRepository(Media).save(
    new Media({
      mediaType:
        seerrMediaType ??
        (mediaType === LibraryMediaType.MOVIE ? MediaType.MOVIE : MediaType.TV),
      tmdbId: 880_000 + fixtureSequence,
      status: MediaStatus.AVAILABLE,
      status4k: MediaStatus.UNKNOWN,
      serviceId: serviceId ?? (mediaType === LibraryMediaType.MOVIE ? 1 : 2),
      seasons: [],
    })
  );
  return getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType,
      titleSnapshot: `Eligibility ${fixtureSequence}`,
      currentMediaId: media.id,
    })
  );
};

const createPresence = (
  canonicalMediaId: number,
  sourceSystem: 'radarr' | 'sonarr',
  options: {
    sourceScope?: string;
    sourceItemId?: string;
    current?: boolean;
  } = {}
) =>
  getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId,
      sourceSystem,
      sourceScope:
        options.sourceScope ?? `service:${sourceSystem === 'radarr' ? 1 : 2}`,
      sourceItemId:
        options.sourceItemId ??
        `${sourceSystem === 'radarr' ? 'movie' : 'series'}:${90_000 + canonicalMediaId}`,
      sourceGeneration: 'eligibility-test',
      firstObservedAt: new Date('2026-10-12T12:00:00.000Z'),
      servarrManaged: true,
      servarrHasFile: true,
      isCurrent: options.current ?? true,
    })
  );

const addSeasonFile = async ({
  canonicalMediaId,
  presence,
  seasonNumber,
  sharedWithSeasonNumber,
}: {
  canonicalMediaId: number;
  presence: LibraryPresence;
  seasonNumber: number;
  sharedWithSeasonNumber?: number;
}) => {
  const season = await getRepository(CanonicalSeason).save(
    new CanonicalSeason({ seriesId: canonicalMediaId, seasonNumber })
  );
  const episode = await getRepository(CanonicalEpisode).save(
    new CanonicalEpisode({
      seasonId: season.id,
      episodeNumber: 1,
      isSpecial: false,
    })
  );
  const file = await getRepository(LibraryFile).save(
    new LibraryFile({
      libraryPresenceId: presence.id,
      sourceSystem: 'sonarr',
      sourceScope: presence.sourceScope,
      sourceFileId: `file:${canonicalMediaId}:${seasonNumber}`,
      sourceGeneration: 'eligibility-test',
      firstObservedAt: new Date('2026-10-12T12:00:00.000Z'),
      isCurrent: true,
    })
  );
  await getRepository(LibraryFileEpisode).save(
    new LibraryFileEpisode({
      libraryFileId: file.id,
      canonicalEpisodeId: episode.id,
    })
  );
  if (sharedWithSeasonNumber !== undefined) {
    const sharedSeason = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({
        seriesId: canonicalMediaId,
        seasonNumber: sharedWithSeasonNumber,
      })
    );
    const sharedEpisode = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({
        seasonId: sharedSeason.id,
        episodeNumber: 1,
        isSpecial: false,
      })
    );
    await getRepository(LibraryFileEpisode).save(
      new LibraryFileEpisode({
        libraryFileId: file.id,
        canonicalEpisodeId: sharedEpisode.id,
      })
    );
  }
};

const normalizedResolution = (
  result: PromiseSettledResult<ResolvedRemovalTarget>
) =>
  result.status === 'fulfilled'
    ? {
        status: result.status,
        canonicalMediaId: result.value.canonicalMediaId,
        targetType: result.value.targetType,
        seasonNumber: result.value.seasonNumber,
        sourceSystem: result.value.sourceSystem,
        sourceScope: result.value.sourceScope,
        serviceId: result.value.service.id,
        externalServiceId: result.value.externalServiceId,
        libraryPresenceId: result.value.libraryPresenceId,
      }
    : {
        status: result.status,
        code:
          result.reason instanceof MediaRemovalError
            ? result.reason.code
            : 'UNKNOWN',
        message:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      };

describe('batched Library bulk eligibility target resolution', () => {
  it('matches the authoritative single-target resolver across mixed safety facts', async () => {
    const movie = await createCanonical({
      mediaType: LibraryMediaType.MOVIE,
    });
    await createPresence(movie.id, 'radarr');

    const series = await createCanonical({
      mediaType: LibraryMediaType.SERIES,
    });
    await createPresence(series.id, 'sonarr');

    const seasonSeries = await createCanonical({
      mediaType: LibraryMediaType.SERIES,
    });
    const seasonPresence = await createPresence(seasonSeries.id, 'sonarr');
    await addSeasonFile({
      canonicalMediaId: seasonSeries.id,
      presence: seasonPresence,
      seasonNumber: 1,
      sharedWithSeasonNumber: 2,
    });

    const nonCurrent = await createCanonical({
      mediaType: LibraryMediaType.MOVIE,
    });
    await createPresence(nonCurrent.id, 'radarr', { current: false });

    const ambiguous = await createCanonical({
      mediaType: LibraryMediaType.SERIES,
    });
    await createPresence(ambiguous.id, 'sonarr');
    await createPresence(ambiguous.id, 'sonarr', {
      sourceScope: 'service:3',
      sourceItemId: `series:${190_000 + ambiguous.id}`,
    });

    const unconfigured = await createCanonical({
      mediaType: LibraryMediaType.MOVIE,
    });
    await createPresence(unconfigured.id, 'radarr', {
      sourceScope: 'service:999',
    });

    const serviceMismatch = await createCanonical({
      mediaType: LibraryMediaType.MOVIE,
      serviceId: 999,
    });
    await createPresence(serviceMismatch.id, 'radarr');

    const identityMismatch = await createCanonical({
      mediaType: LibraryMediaType.MOVIE,
      seerrMediaType: MediaType.TV,
    });
    await createPresence(identityMismatch.id, 'radarr');

    const seasonWithoutFile = await createCanonical({
      mediaType: LibraryMediaType.SERIES,
    });
    await createPresence(seasonWithoutFile.id, 'sonarr');
    await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId: seasonWithoutFile.id, seasonNumber: 1 })
    );

    const targets: RemovalTarget[] = [
      { canonicalMediaId: movie.id, targetType: RemovalTargetType.MOVIE },
      { canonicalMediaId: series.id, targetType: RemovalTargetType.SERIES },
      {
        canonicalMediaId: seasonSeries.id,
        targetType: RemovalTargetType.SEASON,
        seasonNumber: 1,
      },
      {
        canonicalMediaId: nonCurrent.id,
        targetType: RemovalTargetType.MOVIE,
      },
      {
        canonicalMediaId: ambiguous.id,
        targetType: RemovalTargetType.SERIES,
      },
      {
        canonicalMediaId: unconfigured.id,
        targetType: RemovalTargetType.MOVIE,
      },
      {
        canonicalMediaId: serviceMismatch.id,
        targetType: RemovalTargetType.MOVIE,
      },
      {
        canonicalMediaId: identityMismatch.id,
        targetType: RemovalTargetType.MOVIE,
      },
      {
        canonicalMediaId: seasonWithoutFile.id,
        targetType: RemovalTargetType.SEASON,
        seasonNumber: 1,
      },
    ].map((target) => ({
      ...target,
      removalSource: LibraryRemovalSource.MANUAL,
    }));

    const single = await Promise.allSettled(
      targets.map((target) => resolveCurrentRemovalTarget(target))
    );
    const batched = await resolveCurrentRemovalTargetsForEligibility(targets);

    assert.deepEqual(
      batched.map(normalizedResolution),
      single.map(normalizedResolution)
    );
    assert.equal(batched[2].status, 'fulfilled');
  });

  it('loads durable execution claims as a set and keeps them authoritative', async () => {
    const movie = await createCanonical({
      mediaType: LibraryMediaType.MOVIE,
    });
    await createPresence(movie.id, 'radarr');
    const executionId = '11111111-1111-4111-8111-111111111111';
    await getRepository(RemovalExecution).save(
      new RemovalExecution({
        id: executionId,
        canonicalMediaId: movie.id,
        targetType: RemovalTargetType.MOVIE,
        initiator: RemovalExecutionInitiator.BULK,
        state: RemovalExecutionState.CLAIMED,
        fence: 1,
      })
    );
    await getRepository(RemovalExecutionClaim).save(
      new RemovalExecutionClaim({
        canonicalMediaId: movie.id,
        executionId,
        fence: 1,
        ownerToken: 'eligibility-owner',
        phase: RemovalExecutionPhase.PRE_PROVIDER,
        leaseUntil: new Date('2099-10-12T12:00:00.000Z'),
      })
    );

    const preview = await libraryBulkActions.previewEligibility([
      { canonicalMediaId: movie.id, targetType: 'movie' },
    ]);

    assert.deepEqual(preview.results, [
      {
        target: { canonicalMediaId: movie.id, targetType: 'movie' },
        eligibility: 'conflict',
        reason: 'execution_in_progress',
      },
    ]);
  });
});
