import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import type {
  WatchlistRouletteFailureCode,
  WatchlistRouletteRunSummary,
} from '@server/constants/watchlistRoulette';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import {
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  InvalidMediaRequestError,
  MediaRequest,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import type { MediaRequestBody } from '@server/interfaces/api/requestInterfaces';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import { Permission } from '@server/lib/permissions';
import { InvalidRequestSeasonsError } from '@server/lib/requestSeasonValidation';
import { getSettings } from '@server/lib/settings';
import {
  getAggregatedWatchlistIdentities,
  type WatchlistIdentity,
} from '@server/lib/watchlist';
import logger from '@server/logger';
import { randomInt } from 'crypto';

type RequestResult = Pick<MediaRequest, 'id' | 'status'>;

export interface WatchlistRouletteDependencies {
  now: () => Date;
  randomIndex: (upperExclusive: number) => number;
  getCandidates: (mediaType: MediaType) => Promise<WatchlistIdentity[]>;
  refreshAcquisitions: () => Promise<{ authoritative: boolean }>;
  findRequestOwner: (userId: number) => Promise<User | null>;
  isCandidateEligible: (candidate: WatchlistIdentity) => Promise<boolean>;
  createRequest: (
    candidate: WatchlistIdentity,
    requestOwner: User
  ) => Promise<RequestResult>;
  persistSummary: (
    mediaType: MediaType,
    summary: WatchlistRouletteRunSummary
  ) => Promise<void>;
  hasDefaultProvider: (mediaType: MediaType) => boolean;
  getConfiguration: () => ReturnType<typeof getSettings>['watchlistRoulette'];
}

const defaultFindRequestOwner = async (
  userId: number
): Promise<User | null> => {
  const user = await getRepository(User).findOne({ where: { id: userId } });
  return user?.hasPermission(Permission.ADMIN) ? user : null;
};

export const validateWatchlistRouletteRequestOwner = async (
  userId: number | null
): Promise<User | null> => {
  if (!Number.isSafeInteger(userId) || Number(userId) <= 0) return null;
  return defaultFindRequestOwner(Number(userId));
};

export const isLoadedMediaEligibleForWatchlistRoulette = (
  media: Media,
  mediaType: MediaType
): boolean => {
  if ((media.downloadStatus?.length ?? 0) > 0) return false;
  if (media.status === MediaStatus.BLOCKLISTED) return false;

  if (mediaType === MediaType.MOVIE) {
    if (![MediaStatus.UNKNOWN, MediaStatus.DELETED].includes(media.status)) {
      return false;
    }
    return !(media.requests ?? []).some(
      (request) =>
        !request.is4k &&
        ![MediaRequestStatus.DECLINED, MediaRequestStatus.COMPLETED].includes(
          request.status
        )
    );
  }

  if (
    ![
      MediaStatus.UNKNOWN,
      MediaStatus.DELETED,
      MediaStatus.PARTIALLY_AVAILABLE,
    ].includes(media.status)
  ) {
    return false;
  }
  const seasonOne = media.seasons?.find((season) => season.seasonNumber === 1);
  if (
    seasonOne &&
    ![MediaStatus.UNKNOWN, MediaStatus.DELETED].includes(seasonOne.status)
  ) {
    return false;
  }
  return !(media.requests ?? []).some(
    (request) =>
      !request.is4k &&
      ![MediaRequestStatus.DECLINED, MediaRequestStatus.COMPLETED].includes(
        request.status
      ) &&
      request.seasons.some((season) => season.seasonNumber === 1)
  );
};

export const isWatchlistRouletteCandidateEligible = async (
  candidate: WatchlistIdentity
): Promise<boolean> => {
  if (
    ![MediaType.MOVIE, MediaType.TV].includes(candidate.mediaType) ||
    !Number.isSafeInteger(candidate.tmdbId) ||
    candidate.tmdbId <= 0
  ) {
    return false;
  }

  const media = await getRepository(Media).findOne({
    where: {
      mediaType: candidate.mediaType,
      tmdbId: candidate.tmdbId,
    },
    relations: ['requests', 'requests.seasons'],
  });
  if (!media) return true;
  return isLoadedMediaEligibleForWatchlistRoulette(media, candidate.mediaType);
};

const persistSummary = async (
  mediaType: MediaType,
  summary: WatchlistRouletteRunSummary
): Promise<void> => {
  const settings = getSettings();
  settings.watchlistRoulette = {
    ...settings.watchlistRoulette,
    ...(mediaType === MediaType.MOVIE
      ? { lastMovieRun: summary }
      : { lastSeriesRun: summary }),
  };
  await settings.save();
};

export const watchlistRouletteRequestBody = (
  candidate: WatchlistIdentity
): MediaRequestBody => ({
  mediaType: candidate.mediaType,
  mediaId: candidate.tmdbId,
  is4k: false,
  ...(candidate.mediaType === MediaType.TV ? { seasons: [1] } : {}),
});

export const createWatchlistRouletteRequest = (
  candidate: WatchlistIdentity,
  requestOwner: User
): Promise<MediaRequest> =>
  MediaRequest.request(watchlistRouletteRequestBody(candidate), requestOwner, {
    isAutoRequest: true,
  });

const defaultDependencies: WatchlistRouletteDependencies = {
  now: () => new Date(),
  randomIndex: (upperExclusive) => randomInt(upperExclusive),
  getCandidates: getAggregatedWatchlistIdentities,
  refreshAcquisitions: () => acquisitionMonitor.refresh('background'),
  findRequestOwner: defaultFindRequestOwner,
  isCandidateEligible: isWatchlistRouletteCandidateEligible,
  createRequest: createWatchlistRouletteRequest,
  persistSummary,
  getConfiguration: () => getSettings().watchlistRoulette,
  hasDefaultProvider: (mediaType) => {
    const settings = getSettings();
    const providers =
      mediaType === MediaType.MOVIE ? settings.radarr : settings.sonarr;
    return providers.some((provider) => provider.isDefault && !provider.is4k);
  },
};

export const shuffleWatchlistIdentities = (
  candidates: WatchlistIdentity[],
  randomIndex: (upperExclusive: number) => number = (upperExclusive) =>
    randomInt(upperExclusive)
): WatchlistIdentity[] => {
  const shuffled = [...candidates];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = randomIndex(index + 1);
    if (
      !Number.isSafeInteger(swapIndex) ||
      swapIndex < 0 ||
      swapIndex > index
    ) {
      throw new Error('Random index provider returned an invalid index.');
    }
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
};

export const uniqueWatchlistIdentities = (
  candidates: WatchlistIdentity[],
  mediaType: MediaType
): WatchlistIdentity[] => {
  const identities = new Map<string, WatchlistIdentity>();
  for (const candidate of candidates) {
    if (
      candidate.mediaType !== mediaType ||
      !Number.isSafeInteger(candidate.tmdbId) ||
      candidate.tmdbId <= 0
    ) {
      continue;
    }
    identities.set(`${candidate.mediaType}:${candidate.tmdbId}`, candidate);
  }
  return [...identities.values()];
};

const expectedSkipErrors = [
  BlocklistedMediaError,
  DuplicateMediaRequestError,
  InvalidMediaRequestError,
  InvalidRequestSeasonsError,
  NoSeasonsAvailableError,
  QuotaRestrictedError,
  RequestPermissionError,
];

const isExpectedSkipError = (error: unknown): boolean =>
  error instanceof Error &&
  expectedSkipErrors.some((ErrorType) => error instanceof ErrorType);

export class WatchlistRouletteService {
  private runPromise?: Promise<WatchlistRouletteRunSummary>;
  private lastResult?: WatchlistRouletteRunSummary;

  constructor(
    private readonly mediaType: MediaType,
    private readonly dependencies: WatchlistRouletteDependencies = defaultDependencies
  ) {}

  public running(): boolean {
    return Boolean(this.runPromise);
  }

  public status(): WatchlistRouletteRunSummary | undefined {
    return this.lastResult;
  }

  public run(): Promise<WatchlistRouletteRunSummary> {
    if (this.runPromise) return this.runPromise;
    const promise = this.execute().finally(() => {
      if (this.runPromise === promise) this.runPromise = undefined;
    });
    this.runPromise = promise;
    return promise;
  }

  private async complete(
    startedAt: Date,
    result: Omit<WatchlistRouletteRunSummary, 'startedAt' | 'completedAt'>
  ): Promise<WatchlistRouletteRunSummary> {
    const summary: WatchlistRouletteRunSummary = {
      startedAt: startedAt.toISOString(),
      completedAt: this.dependencies.now().toISOString(),
      ...result,
    };
    this.lastResult = summary;
    await this.dependencies.persistSummary(this.mediaType, summary);
    return summary;
  }

  private failedRun(
    startedAt: Date,
    failureCode: WatchlistRouletteFailureCode
  ): Promise<WatchlistRouletteRunSummary> {
    return this.complete(startedAt, {
      status: 'failed',
      requested: 0,
      skipped: 0,
      failed: 0,
      examined: 0,
      requestIds: [],
      failureCode,
    });
  }

  private async execute(): Promise<WatchlistRouletteRunSummary> {
    const startedAt = this.dependencies.now();
    try {
      const settings = this.dependencies.getConfiguration();
      const requestOwnerId = settings.requestOwnerUserId;
      const requestOwner = requestOwnerId
        ? await this.dependencies.findRequestOwner(requestOwnerId)
        : null;
      if (!requestOwner?.hasPermission(Permission.ADMIN)) {
        return this.failedRun(startedAt, 'request-owner-unavailable');
      }
      if (!this.dependencies.hasDefaultProvider(this.mediaType)) {
        return this.failedRun(startedAt, 'provider-not-configured');
      }

      const acquisition = await this.dependencies.refreshAcquisitions();
      if (!acquisition.authoritative) {
        return this.failedRun(startedAt, 'acquisition-state-unavailable');
      }

      const requestedLimit =
        this.mediaType === MediaType.MOVIE
          ? settings.movieItemsPerRun
          : settings.seriesItemsPerRun;
      const candidates = shuffleWatchlistIdentities(
        uniqueWatchlistIdentities(
          await this.dependencies.getCandidates(this.mediaType),
          this.mediaType
        ),
        this.dependencies.randomIndex
      );
      const requestIds: number[] = [];
      let skipped = 0;
      let failed = 0;
      let examined = 0;

      for (const candidate of candidates) {
        if (requestIds.length >= requestedLimit) break;
        examined += 1;
        if (!(await this.dependencies.isCandidateEligible(candidate))) {
          skipped += 1;
          continue;
        }
        try {
          const request = await this.dependencies.createRequest(
            candidate,
            requestOwner
          );
          if (request.status !== MediaRequestStatus.APPROVED) {
            throw new Error(
              'Watchlist Roulette request was not auto-approved.'
            );
          }
          requestIds.push(request.id);
          logger.info('Watchlist Roulette created an approved request', {
            label: 'Watchlist Roulette',
            mediaType: candidate.mediaType,
            tmdbId: candidate.tmdbId,
            requestId: request.id,
            requestOwnerUserId: requestOwner.id,
          });
        } catch (error) {
          if (isExpectedSkipError(error)) {
            skipped += 1;
            logger.debug('Watchlist Roulette skipped an ineligible candidate', {
              label: 'Watchlist Roulette',
              mediaType: candidate.mediaType,
              tmdbId: candidate.tmdbId,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
          } else {
            failed += 1;
            logger.warn('Watchlist Roulette request attempt failed', {
              label: 'Watchlist Roulette',
              mediaType: candidate.mediaType,
              tmdbId: candidate.tmdbId,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
          }
        }
      }

      return this.complete(startedAt, {
        status: 'succeeded',
        requested: requestIds.length,
        skipped,
        failed,
        examined,
        requestIds,
      });
    } catch (error) {
      logger.error('Watchlist Roulette run failed', {
        label: 'Watchlist Roulette',
        mediaType: this.mediaType,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      return this.failedRun(startedAt, 'unexpected-error');
    }
  }
}

export const movieWatchlistRoulette = new WatchlistRouletteService(
  MediaType.MOVIE
);
export const seriesWatchlistRoulette = new WatchlistRouletteService(
  MediaType.TV
);
