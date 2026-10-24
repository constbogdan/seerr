import TheMovieDb from '@server/api/themoviedb';
import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
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
import type { User } from '@server/entity/User';
import type { LibrarySeriesDetailResponse } from '@server/interfaces/api/libraryInterfaces';
import acquisitionMonitor from '@server/lib/acquisitionMonitor';
import library from '@server/lib/library';
import { currentLibraryPresenceSql } from '@server/lib/libraryActivity';
import { Permission } from '@server/lib/permissions';
import { InvalidRequestSeasonsError } from '@server/lib/requestSeasonValidation';
import { getSettings } from '@server/lib/settings';
import { validateWatchlistRouletteRequestOwner } from '@server/lib/watchlistRoulette';
import logger from '@server/logger';
import { In } from 'typeorm';

export const NEXT_SEASON_PROGRESS_PERCENT = 70;
export const NEXT_SEASON_SERIES_LIMIT = 50;
export const NEXT_SEASON_METADATA_LIMIT = 10;
export const NEXT_SEASON_REQUEST_LIMIT = 5;
export const NEXT_SEASON_DEADLINE_MS = 45_000;
export const NEXT_SEASON_VIEWING_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface NextSeasonSeriesCandidate {
  canonicalMediaId: number;
  tmdbId: number | null;
  title: string;
}

export interface NextSeasonTrigger {
  seasonNumber: number;
  nextSeasonNumber: number;
  qualifyingViewers: number;
}

interface NextSeasonQualifyingViewer {
  key: string;
  displayName: string;
  lastViewedAt: string;
}

export interface NextSeasonProgressEvaluation {
  triggers: NextSeasonTrigger[];
  missingEpisodeCountSeasons: number[];
}

export type NextSeasonSkipReason =
  | 'missing-identity'
  | 'missing-progress'
  | 'missing-episode-count'
  | 'below-threshold'
  | 'missing-next-season'
  | 'unreleased-next-season'
  | 'partial-requests-disabled'
  | 'already-available'
  | 'partially-available'
  | 'already-requested'
  | 'failed-request'
  | 'active-acquisition'
  | 'blocklisted'
  | 'no-request-owner'
  | 'no-longer-active'
  | 'request-ineligible'
  | 'eligibility-failure'
  | 'metadata-failure'
  | 'progress-failure'
  | 'request-owner-failure'
  | 'acquisition-unavailable';

export type NextSeasonCandidateOutcome =
  | 'would-request'
  | 'requested'
  | 'skipped'
  | 'failed';

export interface NextSeasonCandidateResult {
  canonicalMediaId: number;
  tmdbId: number | null;
  seasonNumber: number | null;
  outcome: NextSeasonCandidateOutcome;
  reason?: NextSeasonSkipReason;
  title?: string;
  qualifyingViewer?: string;
  qualifyingLastViewedAt?: string;
}

export interface NextSeasonRunSummary {
  status: 'succeeded' | 'failed' | 'already-running';
  dryRun: boolean;
  startedAt: string;
  completedAt: string;
  seriesExamined: number;
  qualifyingProgress: number;
  metadataLookups: number;
  alreadyAvailable: number;
  alreadyRequested: number;
  activeAcquisitions: number;
  skipped: number;
  failed: number;
  requested: number;
  requestIds: number[];
  candidates: NextSeasonCandidateResult[];
  limitReason?:
    | 'series-limit'
    | 'metadata-limit'
    | 'request-limit'
    | 'deadline'
    | 'cancelled'
    | 'configuration';
}

export type SeasonInspection =
  | { state: 'eligible' }
  | {
      state:
        | 'already-available'
        | 'partially-available'
        | 'already-requested'
        | 'failed-request'
        | 'active-acquisition'
        | 'blocklisted'
        | 'partial-requests-disabled';
    };

export interface NextSeasonDependencies {
  loadActiveSeries: (
    limit: number,
    afterCanonicalMediaId: number
  ) => Promise<NextSeasonSeriesCandidate[]>;
  loadSeriesProgress: (
    canonicalMediaId: number
  ) => Promise<LibrarySeriesDetailResponse | null>;
  loadTvMetadata: (tmdbId: number) => Promise<TmdbTvDetails>;
  refreshAcquisitions: () => Promise<{ authoritative: boolean }>;
  inspectSeason: (
    tmdbId: number,
    seasonNumber: number
  ) => Promise<SeasonInspection>;
  isSeriesActive: (canonicalMediaId: number) => Promise<boolean>;
  isSeasonPresent: (
    canonicalMediaId: number,
    seasonNumber: number
  ) => Promise<boolean>;
  findRequestOwner: (userId: number | null) => Promise<User | null>;
  submitSeason: (
    tmdbId: number,
    seasonNumber: number,
    requestOwner: User
  ) => Promise<{ id: number }>;
  requestOwnerUserId: () => number | null;
  now: () => Date;
}

const activeSeriesQuery = () =>
  getRepository(CanonicalMedia)
    .createQueryBuilder('canonical')
    .leftJoinAndSelect('canonical.currentMedia', 'currentMedia')
    .where('canonical.mediaType = :mediaType', {
      mediaType: LibraryMediaType.SERIES,
    })
    .andWhere(
      `EXISTS (SELECT 1 FROM "library_presence" next_season_presence WHERE ` +
        `next_season_presence."canonicalMediaId" = canonical.id AND ` +
        `${currentLibraryPresenceSql('next_season_presence', ':active')})`,
      { active: true }
    );

export const loadActiveNextSeasonSeries = async (
  limit: number,
  afterCanonicalMediaId: number
): Promise<NextSeasonSeriesCandidate[]> => {
  const after = await activeSeriesQuery()
    .andWhere('canonical.id > :afterCanonicalMediaId', {
      afterCanonicalMediaId,
    })
    .orderBy('canonical.id', 'ASC')
    .take(limit)
    .getMany();
  const remaining = limit - after.length;
  const wrapped =
    remaining > 0 && afterCanonicalMediaId > 0
      ? await activeSeriesQuery()
          .andWhere('canonical.id <= :afterCanonicalMediaId', {
            afterCanonicalMediaId,
          })
          .orderBy('canonical.id', 'ASC')
          .take(remaining)
          .getMany()
      : [];
  const media = [...after, ...wrapped];
  if (media.length === 0) return [];
  const identities = await getRepository(CanonicalMediaIdentity).find({
    where: {
      canonicalMediaId: In(media.map((item) => item.id)),
      provider: 'tmdb',
      sourceScope: '',
      mediaType: LibraryMediaType.SERIES,
    },
  });
  const identityByCanonicalId = new Map(
    identities.map((identity) => [
      identity.canonicalMediaId,
      Number(identity.value),
    ])
  );
  return media.map((item) => {
    const identity = identityByCanonicalId.get(item.id);
    const fallback = item.currentMedia?.tmdbId;
    const tmdbId =
      Number.isSafeInteger(identity) && Number(identity) > 0
        ? Number(identity)
        : Number.isSafeInteger(fallback) && Number(fallback) > 0
          ? Number(fallback)
          : null;
    return {
      canonicalMediaId: item.id,
      tmdbId,
      title: item.titleSnapshot?.trim() || `Series ${item.id}`,
    };
  });
};

const defaultInspectSeason = async (
  tmdbId: number,
  seasonNumber: number
): Promise<SeasonInspection> => {
  if (!getSettings().main.partialRequestsEnabled) {
    return { state: 'partial-requests-disabled' };
  }
  const media = await getRepository(Media).findOne({
    where: { tmdbId, mediaType: MediaType.TV },
    relations: { requests: true },
  });
  if (!media) return { state: 'eligible' };
  if (media.status === MediaStatus.BLOCKLISTED) {
    return { state: 'blocklisted' };
  }
  const season = media.seasons?.find(
    (item) => item.seasonNumber === seasonNumber
  );
  if (season?.status === MediaStatus.AVAILABLE) {
    return { state: 'already-available' };
  }
  if (season?.status === MediaStatus.PARTIALLY_AVAILABLE) {
    return { state: 'partially-available' };
  }
  if (
    season?.status === MediaStatus.PROCESSING ||
    season?.status === MediaStatus.PENDING
  ) {
    return { state: 'active-acquisition' };
  }
  const matchingRequests = (media.requests ?? []).filter((request) =>
    request.seasons.some((item) => item.seasonNumber === seasonNumber)
  );
  if (
    matchingRequests.some(
      (request) => request.status === MediaRequestStatus.FAILED
    )
  ) {
    return { state: 'failed-request' };
  }
  if (
    matchingRequests.some((request) =>
      [MediaRequestStatus.PENDING, MediaRequestStatus.APPROVED].includes(
        request.status
      )
    )
  ) {
    return { state: 'already-requested' };
  }
  if (
    (media.downloadStatus ?? []).some(
      (item) =>
        item.episode === undefined || item.episode.seasonNumber === seasonNumber
    )
  ) {
    return { state: 'active-acquisition' };
  }
  return { state: 'eligible' };
};

const defaultDependencies: NextSeasonDependencies = {
  loadActiveSeries: loadActiveNextSeasonSeries,
  loadSeriesProgress: (canonicalMediaId) =>
    library.seriesDetail(canonicalMediaId),
  loadTvMetadata: (tmdbId) => new TheMovieDb().getTvShow({ tvId: tmdbId }),
  refreshAcquisitions: () => acquisitionMonitor.refresh('background'),
  inspectSeason: defaultInspectSeason,
  isSeriesActive: async (canonicalMediaId) =>
    (await getRepository(CanonicalMedia)
      .createQueryBuilder('canonical')
      .where('canonical.id = :canonicalMediaId', { canonicalMediaId })
      .andWhere(
        `EXISTS (SELECT 1 FROM "library_presence" next_season_presence WHERE ` +
          `next_season_presence."canonicalMediaId" = canonical.id AND ` +
          `${currentLibraryPresenceSql('next_season_presence', ':active')})`,
        { active: true }
      )
      .getCount()) > 0,
  isSeasonPresent: async (canonicalMediaId, seasonNumber) => {
    const detail = await library.seriesDetail(canonicalMediaId);
    return (
      detail?.seasons.some(
        (season) =>
          !season.isSpecial &&
          season.seasonNumber === seasonNumber &&
          season.availableEpisodeCount > 0
      ) ?? false
    );
  },
  findRequestOwner: (userId) => validateWatchlistRouletteRequestOwner(userId),
  submitSeason: (tmdbId, seasonNumber, requestOwner) =>
    MediaRequest.request(
      {
        mediaType: MediaType.TV,
        mediaId: tmdbId,
        seasons: [seasonNumber],
      },
      requestOwner,
      {
        isAutoRequest: true,
        allowNonOverlappingAutoRequestSeasons: true,
      }
    ),
  requestOwnerUserId: () => getSettings().watchlistRoulette.requestOwnerUserId,
  now: () => new Date(),
};

const viewerKey = (user: { key: string; userId: number | null }): string =>
  user.userId ? `user:${user.userId}` : user.key;

export const isNextSeasonProgressEligible = (
  watchedEpisodeCount: number,
  totalEpisodeCount: number
): boolean =>
  Number.isSafeInteger(watchedEpisodeCount) &&
  watchedEpisodeCount >= 0 &&
  Number.isSafeInteger(totalEpisodeCount) &&
  totalEpisodeCount > 0 &&
  watchedEpisodeCount <= totalEpisodeCount &&
  watchedEpisodeCount * 100 >= totalEpisodeCount * NEXT_SEASON_PROGRESS_PERCENT;

export const isNextSeasonViewingActivityEligible = (
  lastViewedAt: string | null,
  now: Date
): boolean => {
  if (!lastViewedAt || !Number.isFinite(now.getTime())) return false;
  const viewedAt = new Date(lastViewedAt).getTime();
  if (!Number.isFinite(viewedAt) || viewedAt > now.getTime()) return false;
  return now.getTime() - viewedAt <= NEXT_SEASON_VIEWING_WINDOW_MS;
};

const qualifyingViewersForSeason = (
  detail: LibrarySeriesDetailResponse,
  seasonNumber: number,
  totalEpisodeCount: number,
  now: Date
): NextSeasonQualifyingViewer[] =>
  detail.seasons
    .find((season) => season.seasonNumber === seasonNumber)
    ?.users.filter(
      (user) =>
        isNextSeasonProgressEligible(
          user.watchedEpisodeCount,
          totalEpisodeCount
        ) && isNextSeasonViewingActivityEligible(user.lastViewedAt, now)
    )
    .map((user) => ({
      key: viewerKey(user),
      displayName: user.displayName,
      lastViewedAt: user.lastViewedAt as string,
    }))
    .sort(
      (left, right) =>
        left.displayName.localeCompare(right.displayName) ||
        left.key.localeCompare(right.key)
    ) ?? [];

export const evaluateNextSeasonProgress = (
  detail: LibrarySeriesDetailResponse,
  totalEpisodesBySeason: ReadonlyMap<number, number>,
  now: Date
): NextSeasonProgressEvaluation => {
  const triggers = new Map<
    number,
    NextSeasonTrigger & { viewerKeys: Set<string> }
  >();
  const missingEpisodeCountSeasons = new Set<number>();
  for (const season of detail.seasons) {
    if (
      season.isSpecial ||
      season.seasonNumber <= 0 ||
      season.availableEpisodeCount <= 0
    ) {
      continue;
    }
    const totalEpisodeCount = totalEpisodesBySeason.get(season.seasonNumber);
    if (
      !Number.isSafeInteger(totalEpisodeCount) ||
      Number(totalEpisodeCount) <= 0 ||
      season.availableEpisodeCount > Number(totalEpisodeCount) ||
      season.users.some(
        (user) =>
          user.watchedEpisodeCount > Number(totalEpisodeCount) ||
          user.watchedEpisodeCount > season.availableEpisodeCount
      )
    ) {
      if (season.users.some((user) => user.watchedEpisodeCount > 0)) {
        missingEpisodeCountSeasons.add(season.seasonNumber);
      }
      continue;
    }
    for (const user of season.users) {
      if (
        !isNextSeasonProgressEligible(
          user.watchedEpisodeCount,
          Number(totalEpisodeCount)
        ) ||
        !isNextSeasonViewingActivityEligible(user.lastViewedAt, now)
      ) {
        continue;
      }
      const nextSeasonNumber = season.seasonNumber + 1;
      const existing = triggers.get(nextSeasonNumber) ?? {
        seasonNumber: season.seasonNumber,
        nextSeasonNumber,
        qualifyingViewers: 0,
        viewerKeys: new Set<string>(),
      };
      existing.viewerKeys.add(viewerKey(user));
      existing.qualifyingViewers = existing.viewerKeys.size;
      triggers.set(nextSeasonNumber, existing);
    }
  }
  return {
    triggers: [...triggers.values()]
      .map(({ seasonNumber, nextSeasonNumber, qualifyingViewers }) => ({
        seasonNumber,
        nextSeasonNumber,
        qualifyingViewers,
      }))
      .sort((left, right) => left.nextSeasonNumber - right.nextSeasonNumber),
    missingEpisodeCountSeasons: [...missingEpisodeCountSeasons].sort(
      (left, right) => left - right
    ),
  };
};

export const deriveNextSeasonTriggers = (
  detail: LibrarySeriesDetailResponse,
  totalEpisodesBySeason: ReadonlyMap<number, number>,
  now: Date
): NextSeasonTrigger[] =>
  evaluateNextSeasonProgress(detail, totalEpisodesBySeason, now).triggers;

const knownRequestIneligibility = (error: unknown): boolean =>
  error instanceof DuplicateMediaRequestError ||
  error instanceof NoSeasonsAvailableError ||
  error instanceof BlocklistedMediaError ||
  error instanceof QuotaRestrictedError ||
  error instanceof RequestPermissionError ||
  error instanceof InvalidMediaRequestError ||
  error instanceof InvalidRequestSeasonsError;

const recordSeasonInspectionSkip = (
  summary: NextSeasonRunSummary,
  inspection: Exclude<SeasonInspection, { state: 'eligible' }>
): void => {
  summary.skipped += 1;
  if (inspection.state === 'already-available') {
    summary.alreadyAvailable += 1;
  } else if (
    inspection.state === 'already-requested' ||
    inspection.state === 'failed-request'
  ) {
    summary.alreadyRequested += 1;
  } else if (inspection.state === 'active-acquisition') {
    summary.activeAcquisitions += 1;
  }
};

const summaryFor = (
  dryRun: boolean,
  startedAt: Date
): NextSeasonRunSummary => ({
  status: 'succeeded',
  dryRun,
  startedAt: startedAt.toISOString(),
  completedAt: startedAt.toISOString(),
  seriesExamined: 0,
  qualifyingProgress: 0,
  metadataLookups: 0,
  alreadyAvailable: 0,
  alreadyRequested: 0,
  activeAcquisitions: 0,
  skipped: 0,
  failed: 0,
  requested: 0,
  requestIds: [],
  candidates: [],
});

export class NextSeasonService {
  private activeRun?: Promise<NextSeasonRunSummary>;
  private activeUpcoming?: Promise<NextSeasonRunSummary>;
  private lastResult?: NextSeasonRunSummary;
  private cursor = 0;
  private cancelRequested = false;

  constructor(
    private readonly dependencies: NextSeasonDependencies = defaultDependencies
  ) {}

  public running(): boolean {
    return this.activeRun !== undefined;
  }

  public status(): NextSeasonRunSummary | undefined {
    return this.lastResult;
  }

  public cancel(): void {
    this.cancelRequested = true;
  }

  public run(
    options: { dryRun?: boolean } = {}
  ): Promise<NextSeasonRunSummary> {
    const dryRun = options.dryRun === true;
    if (dryRun) return this.upcoming();
    if (this.activeRun) {
      const now = this.dependencies.now().toISOString();
      return Promise.resolve({
        ...summaryFor(dryRun, new Date(now)),
        status: 'already-running',
        completedAt: now,
      });
    }
    this.cancelRequested = false;
    const execution = this.execute(dryRun).finally(() => {
      if (this.activeRun === execution) this.activeRun = undefined;
    });
    this.activeRun = execution;
    return execution;
  }

  public upcoming(): Promise<NextSeasonRunSummary> {
    if (this.activeUpcoming) return this.activeUpcoming;
    const execution = this.execute(true).finally(() => {
      if (this.activeUpcoming === execution) this.activeUpcoming = undefined;
    });
    this.activeUpcoming = execution;
    return execution;
  }

  private async loadSeriesForEvaluation(
    complete: boolean
  ): Promise<NextSeasonSeriesCandidate[]> {
    if (!complete) {
      return this.dependencies.loadActiveSeries(
        NEXT_SEASON_SERIES_LIMIT,
        this.cursor
      );
    }

    const series: NextSeasonSeriesCandidate[] = [];
    const seen = new Set<number>();
    let afterCanonicalMediaId = 0;
    while (true) {
      const page = await this.dependencies.loadActiveSeries(
        NEXT_SEASON_SERIES_LIMIT,
        afterCanonicalMediaId
      );
      if (page.length === 0) break;
      let repeated = false;
      for (const candidate of page) {
        if (seen.has(candidate.canonicalMediaId)) {
          repeated = true;
          continue;
        }
        seen.add(candidate.canonicalMediaId);
        series.push(candidate);
        afterCanonicalMediaId = candidate.canonicalMediaId;
      }
      if (page.length < NEXT_SEASON_SERIES_LIMIT || repeated) break;
    }
    return series;
  }

  private async execute(dryRun: boolean): Promise<NextSeasonRunSummary> {
    const startedAt = this.dependencies.now();
    const deadline = startedAt.getTime() + NEXT_SEASON_DEADLINE_MS;
    const summary = summaryFor(dryRun, startedAt);
    const finish = (): NextSeasonRunSummary => {
      summary.completedAt = this.dependencies.now().toISOString();
      if (dryRun) {
        summary.candidates.sort(
          (left, right) =>
            (left.title ?? '').localeCompare(right.title ?? '', 'en') ||
            left.canonicalMediaId - right.canonicalMediaId ||
            (left.seasonNumber ?? -1) - (right.seasonNumber ?? -1) ||
            left.outcome.localeCompare(right.outcome)
        );
      }
      if (!dryRun) this.lastResult = summary;
      logger.info('Next Season evaluation completed', {
        label: 'Next Season',
        dryRun,
        seriesExamined: summary.seriesExamined,
        qualifyingProgress: summary.qualifyingProgress,
        metadataLookups: summary.metadataLookups,
        requested: summary.requested,
        skipped: summary.skipped,
        failed: summary.failed,
        limitReason: summary.limitReason,
      });
      return summary;
    };

    let requestOwner: User | null;
    try {
      requestOwner = await this.dependencies.findRequestOwner(
        this.dependencies.requestOwnerUserId()
      );
    } catch {
      summary.status = 'failed';
      summary.failed = 1;
      summary.limitReason = 'configuration';
      summary.candidates.push({
        canonicalMediaId: 0,
        tmdbId: null,
        seasonNumber: null,
        outcome: 'failed',
        reason: 'request-owner-failure',
      });
      return finish();
    }
    if (!requestOwner?.hasPermission(Permission.ADMIN)) {
      summary.status = 'failed';
      summary.failed = 1;
      summary.limitReason = 'configuration';
      summary.candidates.push({
        canonicalMediaId: 0,
        tmdbId: null,
        seasonNumber: null,
        outcome: 'failed',
        reason: 'no-request-owner',
      });
      return finish();
    }

    try {
      const acquisition = await this.dependencies.refreshAcquisitions();
      if (!acquisition.authoritative) {
        summary.status = 'failed';
        summary.failed = 1;
        summary.candidates.push({
          canonicalMediaId: 0,
          tmdbId: null,
          seasonNumber: null,
          outcome: 'failed',
          reason: 'acquisition-unavailable',
        });
        return finish();
      }
    } catch {
      summary.status = 'failed';
      summary.failed = 1;
      summary.candidates.push({
        canonicalMediaId: 0,
        tmdbId: null,
        seasonNumber: null,
        outcome: 'failed',
        reason: 'acquisition-unavailable',
      });
      return finish();
    }

    let series: NextSeasonSeriesCandidate[];
    try {
      series = await this.loadSeriesForEvaluation(dryRun);
    } catch {
      summary.status = 'failed';
      summary.failed = 1;
      return finish();
    }
    if (!dryRun && series.length === NEXT_SEASON_SERIES_LIMIT) {
      summary.limitReason = 'series-limit';
    }
    const evaluatedTargets = new Set<string>();

    for (const candidate of series) {
      if (!dryRun && this.cancelRequested) {
        summary.limitReason = 'cancelled';
        break;
      }
      if (!dryRun && this.dependencies.now().getTime() >= deadline) {
        summary.limitReason = 'deadline';
        break;
      }
      summary.seriesExamined += 1;
      const completeCandidate = () => {
        if (!dryRun) this.cursor = candidate.canonicalMediaId;
      };
      if (!candidate.tmdbId) {
        summary.skipped += 1;
        summary.candidates.push({
          canonicalMediaId: candidate.canonicalMediaId,
          tmdbId: null,
          seasonNumber: null,
          outcome: 'skipped',
          reason: 'missing-identity',
        });
        completeCandidate();
        continue;
      }

      let detail: LibrarySeriesDetailResponse | null;
      try {
        detail = await this.dependencies.loadSeriesProgress(
          candidate.canonicalMediaId
        );
      } catch {
        summary.failed += 1;
        summary.candidates.push({
          canonicalMediaId: candidate.canonicalMediaId,
          tmdbId: candidate.tmdbId,
          seasonNumber: null,
          outcome: 'failed',
          reason: 'progress-failure',
        });
        completeCandidate();
        continue;
      }
      if (!detail) {
        summary.skipped += 1;
        summary.candidates.push({
          canonicalMediaId: candidate.canonicalMediaId,
          tmdbId: candidate.tmdbId,
          seasonNumber: null,
          outcome: 'skipped',
          reason: 'missing-progress',
        });
        completeCandidate();
        continue;
      }
      const hasRegularProgress = detail.seasons.some(
        (season) =>
          !season.isSpecial &&
          season.seasonNumber > 0 &&
          season.availableEpisodeCount > 0 &&
          season.users.some((user) => user.watchedEpisodeCount > 0)
      );
      if (!hasRegularProgress) {
        summary.skipped += 1;
        summary.candidates.push({
          canonicalMediaId: candidate.canonicalMediaId,
          tmdbId: candidate.tmdbId,
          seasonNumber: null,
          outcome: 'skipped',
          reason: 'below-threshold',
        });
        completeCandidate();
        continue;
      }
      if (!dryRun && summary.metadataLookups >= NEXT_SEASON_METADATA_LIMIT) {
        summary.limitReason = 'metadata-limit';
        break;
      }

      let metadata: TmdbTvDetails;
      try {
        summary.metadataLookups += 1;
        metadata = await this.dependencies.loadTvMetadata(candidate.tmdbId);
      } catch {
        summary.failed += 1;
        summary.candidates.push({
          canonicalMediaId: candidate.canonicalMediaId,
          tmdbId: candidate.tmdbId,
          seasonNumber: null,
          outcome: 'failed',
          reason: 'metadata-failure',
        });
        completeCandidate();
        continue;
      }

      const progress = evaluateNextSeasonProgress(
        detail,
        new Map(
          metadata.seasons
            .filter((season) => season.season_number > 0)
            .map((season) => [season.season_number, season.episode_count])
        ),
        this.dependencies.now()
      );
      for (const sourceSeasonNumber of progress.missingEpisodeCountSeasons) {
        summary.skipped += 1;
        summary.candidates.push({
          canonicalMediaId: candidate.canonicalMediaId,
          tmdbId: candidate.tmdbId,
          seasonNumber: sourceSeasonNumber + 1,
          outcome: 'skipped',
          reason: 'missing-episode-count',
        });
      }
      const triggers = progress.triggers;
      if (
        triggers.length === 0 &&
        progress.missingEpisodeCountSeasons.length === 0
      ) {
        summary.skipped += 1;
        summary.candidates.push({
          canonicalMediaId: candidate.canonicalMediaId,
          tmdbId: candidate.tmdbId,
          seasonNumber: null,
          outcome: 'skipped',
          reason: 'below-threshold',
        });
        completeCandidate();
        continue;
      }
      summary.qualifyingProgress += triggers.reduce(
        (total, trigger) => total + trigger.qualifyingViewers,
        0
      );
      const physicallyPresentSeasons = new Set(
        detail.seasons
          .filter(
            (season) =>
              !season.isSpecial &&
              season.seasonNumber > 0 &&
              season.availableEpisodeCount > 0
          )
          .map((season) => season.seasonNumber)
      );

      let candidateInterrupted = false;
      for (const [triggerIndex, trigger] of triggers.entries()) {
        if (!dryRun && this.cancelRequested) {
          summary.limitReason = 'cancelled';
          candidateInterrupted = true;
          break;
        }
        if (!dryRun && this.dependencies.now().getTime() >= deadline) {
          summary.limitReason = 'deadline';
          candidateInterrupted = true;
          break;
        }
        const targetKey = `${candidate.canonicalMediaId}:${trigger.nextSeasonNumber}`;
        if (evaluatedTargets.has(targetKey)) continue;
        evaluatedTargets.add(targetKey);
        const resultBase = {
          canonicalMediaId: candidate.canonicalMediaId,
          tmdbId: candidate.tmdbId,
          seasonNumber: trigger.nextSeasonNumber,
          title: candidate.title,
          ...(() => {
            const totalEpisodes = metadata.seasons.find(
              (season) => season.season_number === trigger.seasonNumber
            )?.episode_count;
            const viewers = totalEpisodes
              ? qualifyingViewersForSeason(
                  detail,
                  trigger.seasonNumber,
                  totalEpisodes,
                  this.dependencies.now()
                )
              : [];
            if (viewers.length === 0) return {};
            return {
              qualifyingViewer:
                viewers.length === 1
                  ? viewers[0].displayName
                  : `${viewers[0].displayName} +${viewers.length - 1}`,
              qualifyingLastViewedAt: viewers[0].lastViewedAt,
            };
          })(),
        };
        const nextSeason = metadata.seasons.find(
          (season) =>
            season.season_number === trigger.nextSeasonNumber &&
            season.season_number > 0 &&
            season.episode_count > 0
        );
        if (!nextSeason) {
          summary.skipped += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'skipped',
            reason: 'missing-next-season',
          });
          continue;
        }
        const today = this.dependencies.now().toISOString().slice(0, 10);
        if (!nextSeason.air_date || nextSeason.air_date > today) {
          summary.skipped += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'skipped',
            reason: 'unreleased-next-season',
          });
          continue;
        }
        if (physicallyPresentSeasons.has(trigger.nextSeasonNumber)) {
          summary.skipped += 1;
          summary.alreadyAvailable += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'skipped',
            reason: 'already-available',
          });
          continue;
        }
        let inspection: SeasonInspection;
        try {
          inspection = await this.dependencies.inspectSeason(
            candidate.tmdbId,
            trigger.nextSeasonNumber
          );
        } catch {
          summary.failed += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'failed',
            reason: 'eligibility-failure',
          });
          continue;
        }
        if (inspection.state !== 'eligible') {
          recordSeasonInspectionSkip(summary, inspection);
          summary.candidates.push({
            ...resultBase,
            outcome: 'skipped',
            reason: inspection.state,
          });
          continue;
        }
        let isActive: boolean;
        try {
          isActive = await this.dependencies.isSeriesActive(
            candidate.canonicalMediaId
          );
        } catch {
          summary.failed += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'failed',
            reason: 'eligibility-failure',
          });
          continue;
        }
        if (!isActive) {
          summary.skipped += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'skipped',
            reason: 'no-longer-active',
          });
          continue;
        }
        let sourceSeasonPresent: boolean;
        try {
          sourceSeasonPresent = await this.dependencies.isSeasonPresent(
            candidate.canonicalMediaId,
            trigger.seasonNumber
          );
        } catch {
          summary.failed += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'failed',
            reason: 'eligibility-failure',
          });
          continue;
        }
        if (!sourceSeasonPresent) {
          summary.skipped += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'skipped',
            reason: 'no-longer-active',
          });
          continue;
        }
        let seasonPresent: boolean;
        try {
          seasonPresent = await this.dependencies.isSeasonPresent(
            candidate.canonicalMediaId,
            trigger.nextSeasonNumber
          );
        } catch {
          summary.failed += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'failed',
            reason: 'eligibility-failure',
          });
          continue;
        }
        if (seasonPresent) {
          summary.skipped += 1;
          summary.alreadyAvailable += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'skipped',
            reason: 'already-available',
          });
          continue;
        }
        if (dryRun) {
          summary.candidates.push({ ...resultBase, outcome: 'would-request' });
          continue;
        }
        let recheck: SeasonInspection;
        try {
          recheck = await this.dependencies.inspectSeason(
            candidate.tmdbId,
            trigger.nextSeasonNumber
          );
        } catch {
          summary.failed += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'failed',
            reason: 'eligibility-failure',
          });
          continue;
        }
        if (recheck.state !== 'eligible') {
          recordSeasonInspectionSkip(summary, recheck);
          summary.candidates.push({
            ...resultBase,
            outcome: 'skipped',
            reason: recheck.state,
          });
          continue;
        }
        try {
          sourceSeasonPresent = await this.dependencies.isSeasonPresent(
            candidate.canonicalMediaId,
            trigger.seasonNumber
          );
        } catch {
          summary.failed += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'failed',
            reason: 'eligibility-failure',
          });
          continue;
        }
        if (!sourceSeasonPresent) {
          summary.skipped += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'skipped',
            reason: 'no-longer-active',
          });
          continue;
        }
        let currentProgress: LibrarySeriesDetailResponse | null;
        try {
          currentProgress = await this.dependencies.loadSeriesProgress(
            candidate.canonicalMediaId
          );
        } catch {
          summary.failed += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'failed',
            reason: 'progress-failure',
          });
          continue;
        }
        const stillQualifies =
          currentProgress &&
          evaluateNextSeasonProgress(
            currentProgress,
            new Map(
              metadata.seasons
                .filter((season) => season.season_number > 0)
                .map((season) => [season.season_number, season.episode_count])
            ),
            this.dependencies.now()
          ).triggers.some(
            (currentTrigger) =>
              currentTrigger.seasonNumber === trigger.seasonNumber &&
              currentTrigger.nextSeasonNumber === trigger.nextSeasonNumber
          );
        if (!stillQualifies) {
          summary.skipped += 1;
          summary.candidates.push({
            ...resultBase,
            outcome: 'skipped',
            reason: 'below-threshold',
          });
          continue;
        }
        try {
          const request = await this.dependencies.submitSeason(
            candidate.tmdbId,
            trigger.nextSeasonNumber,
            requestOwner
          );
          summary.requested += 1;
          summary.requestIds.push(request.id);
          summary.candidates.push({ ...resultBase, outcome: 'requested' });
          if (summary.requested >= NEXT_SEASON_REQUEST_LIMIT) {
            summary.limitReason = 'request-limit';
            candidateInterrupted = triggerIndex < triggers.length - 1;
            break;
          }
        } catch (error) {
          if (knownRequestIneligibility(error)) {
            summary.skipped += 1;
            summary.candidates.push({
              ...resultBase,
              outcome: 'skipped',
              reason: 'request-ineligible',
            });
          } else {
            summary.failed += 1;
            summary.candidates.push({
              ...resultBase,
              outcome: 'failed',
            });
          }
        }
      }
      if (!candidateInterrupted) completeCandidate();
      if (
        summary.requested >= NEXT_SEASON_REQUEST_LIMIT ||
        summary.limitReason === 'cancelled' ||
        summary.limitReason === 'deadline'
      ) {
        break;
      }
    }
    return finish();
  }
}

const nextSeason = new NextSeasonService();

export default nextSeason;
