import { MediaRequestStatus, MediaType } from '@server/constants/media';
import type { WatchlistResponse } from '@server/interfaces/api/discoverInterfaces';
import type {
  LibraryBulkActionEligibilityReason,
  LibraryItem,
  LibraryResultsResponse,
  LibrarySeriesDetailResponse,
} from '@server/interfaces/api/libraryInterfaces';

export const R11_PAGE_SIZES = [10, 25, 50, 100] as const;
export const R11_BULK_SIZES = [10, 50, 100] as const;
export const R11_VIEWPORT_WIDTHS = [390, 640, 900, 1440] as const;
export const R11_BROWSER_REPETITIONS = 3;
export const R11_BACKEND_REPETITIONS = 7;

const users = Array.from({ length: 6 }, (_, index) => ({
  id: index + 1,
  displayName: `Viewer ${index + 1}`,
  avatar: null,
}));

export const createR11LibraryItems = (count: number): LibraryItem[] =>
  Array.from({ length: count }, (_, index) => {
    const id = index + 1;
    const series = index % 2 === 1;
    const mediaType = series ? ('series' as const) : ('movie' as const);
    const requesters = users.slice(0, 3).map((user, requesterIndex) => ({
      ...user,
      requests: [
        {
          id: id * 100 + requesterIndex,
          type: series ? MediaType.TV : MediaType.MOVIE,
          status:
            requesterIndex === 0
              ? MediaRequestStatus.COMPLETED
              : MediaRequestStatus.APPROVED,
          is4k: requesterIndex === 2,
          isAutoRequest: requesterIndex === 1,
          createdAt: `2026-0${requesterIndex + 1}-10T12:00:00.000Z`,
          updatedAt: `2026-0${requesterIndex + 1}-11T12:00:00.000Z`,
          seasons: series
            ? [1, 2, 3].map((seasonNumber) => ({
                id: id * 1000 + requesterIndex * 10 + seasonNumber,
                seasonNumber,
                status:
                  seasonNumber < 3
                    ? MediaRequestStatus.COMPLETED
                    : MediaRequestStatus.APPROVED,
                createdAt: `2026-0${requesterIndex + 1}-1${seasonNumber}T12:00:00.000Z`,
                updatedAt: `2026-0${requesterIndex + 1}-2${seasonNumber}T12:00:00.000Z`,
              }))
            : [],
        },
      ],
    }));

    return {
      canonicalMediaId: id,
      tmdbId: 100_000 + id,
      mediaType,
      libraryState: 'current',
      title: `${series ? 'Series' : 'Movie'} ${id} with representative long title text`,
      year: 1990 + (id % 35),
      posterPath: null,
      backdropPath: null,
      addedAt: '2026-01-10T12:00:00.000Z',
      removedAt: null,
      removalSource: null,
      logicalSizeBytes: String((id + 1) * 5 * 1024 ** 3),
      resolution: id % 3 === 0 ? 2160 : 1080,
      watchlistUsers: users,
      watchedUsers: users.slice(0, 4).map((user, viewerIndex) => ({
        key: `jellyfin:${id}:${viewerIndex + 1}`,
        userId: user.id,
        displayName: user.displayName,
        avatar: null,
        watchedEpisodeCount: series ? 2 + viewerIndex : 1,
        availableEpisodeCount: series ? 10 : 1,
        watchedPercentage: series
          ? viewerIndex === 0
            ? 100
            : 20 + viewerIndex * 20
          : 100,
        lastViewedAt: `2026-09-${String(10 + viewerIndex).padStart(2, '0')}T12:34:00.000Z`,
      })),
      watchedUserCount: 4,
      hasWatchedDetail: true,
      lastActiveAt: '2026-10-10T23:42:00.000Z',
      lastActiveUsers: users,
      requesters,
      storageRoots: [
        { id: 1, label: 'Primary NAS', color: '#22C55E' },
        { id: 2, label: 'Archive NAS', color: '#60A5FA' },
      ],
      fresh: id % 5 === 0,
      seasonSummaries: series
        ? Array.from({ length: 6 }, (_, seasonIndex) => ({
            key: `series-${id}-season-${seasonIndex + 1}`,
            seasonNumber: seasonIndex + 1,
            isSpecial: false,
            state:
              seasonIndex < 3
                ? ('current' as const)
                : seasonIndex === 3
                  ? ('archive' as const)
                  : ('known_missing' as const),
            availableEpisodeCount: seasonIndex < 3 ? 8 : 0,
            knownEpisodeCount: 8,
            resolution: seasonIndex < 3 ? 1080 : null,
            requestable: seasonIndex >= 3,
          }))
        : [],
      externalLinks: [
        {
          service: series ? 'sonarr' : 'radarr',
          label: series ? 'Sonarr' : 'Radarr',
          url: `https://${series ? 'sonarr' : 'radarr'}.mock.invalid/title/${id}`,
        },
        {
          service: series ? 'sonarr' : 'radarr',
          label: `${series ? 'Sonarr' : 'Radarr'} 4K`,
          url: `https://${series ? 'sonarr' : 'radarr'}-4k.mock.invalid/title/${id}`,
        },
      ],
      tmdbRating: { voteAverage: 6.5 + (id % 25) / 10, voteCount: 100 + id },
      collection:
        !series && id % 5 === 0
          ? {
              id: 50_000 + id,
              name: `Collection ${id} with a long representative name`,
              posterPath: null,
              backdropPath: null,
            }
          : null,
      removalSchedules:
        id % 7 === 0
          ? [
              {
                id: 70_000 + id,
                canonicalMediaId: id,
                targetType: mediaType,
                seasonNumber: null,
                origin: 'manual',
                status: 'active',
                scheduledAt: '2026-10-01T12:00:00.000Z',
                removeAt: '2026-12-01T12:00:00.000Z',
                revision: 1,
              },
            ]
          : [],
    };
  });

export const createR11SeriesDetail = (
  canonicalMediaId: number
): LibrarySeriesDetailResponse => ({
  canonicalMediaId,
  seasons: Array.from({ length: 6 }, (_, seasonIndex) => ({
    seasonNumber: seasonIndex + 1,
    isSpecial: false,
    availableEpisodeCount: 8,
    resolution: seasonIndex < 3 ? 1080 : null,
    sizeBytes: String((seasonIndex + 1) * 8 * 1024 ** 3),
    removedAt: null,
    removalSource: null,
    users: users.slice(0, 4).map((user, viewerIndex) => ({
      key: `jellyfin:${canonicalMediaId}:${seasonIndex + 1}:${viewerIndex + 1}`,
      userId: user.id,
      displayName: user.displayName,
      avatar: null,
      watchedEpisodeCount: Math.min(8, 2 + viewerIndex),
      watchedPercentage: Math.min(100, 25 + viewerIndex * 25),
      lastViewedAt: `2026-09-${String(10 + viewerIndex).padStart(2, '0')}T12:34:00.000Z`,
    })),
  })),
  removalSchedules: [],
});

export const createR11LibraryResponse = (
  count: number
): LibraryResultsResponse => ({
  pageInfo: { pages: 1, page: 1, results: count, pageSize: count },
  results: createR11LibraryItems(count),
  storageLocations: [
    { id: 1, label: 'Primary NAS' },
    { id: 2, label: 'Archive NAS' },
  ],
  sourceStatus: {
    library: 'current',
    currentViewing: 'current',
    historicalViewing: 'current',
    historicalImport: {
      state: 'accepted',
      observedRange: {
        startedAt: '2020-01-01T00:00:00.000Z',
        endedAt: '2026-10-04T00:00:00.000Z',
        completeness: 'not-asserted',
      },
      contentHash: 'r11-deterministic-history',
    },
  },
});

export const createR11WatchlistPage = (page: number): WatchlistResponse => ({
  page,
  totalPages: 3,
  totalResults: 60,
  source: 'local',
  supportsPresentation: true,
  supportsWatchState: true,
  hasUnclassifiedItems: false,
  results: Array.from({ length: 20 }, (_, index) => {
    const id = (page - 1) * 20 + index + 1;
    return {
      id,
      ratingKey: `r11-${id}`,
      tmdbId: 200_000 + id,
      mediaType: id % 2 === 0 ? ('tv' as const) : ('movie' as const),
      title: `Watchlist title ${id}`,
      genreIds: [18],
      watchState:
        id % 3 === 0 ? ('watched' as const) : ('not_watched' as const),
      lastPlayedAt: '2026-10-10T12:00:00.000Z',
      watchStateSyncedAt: '2026-10-11T12:00:00.000Z',
      requestedBy: {
        ...users[id % users.length],
        avatar: '',
      },
    };
  }),
});

export type R11BulkFixtureKind =
  | 'movie-unscheduled'
  | 'series-unscheduled'
  | 'season-unscheduled'
  | 'movie-scheduled'
  | 'series-leased'
  | 'season-whole-series-scheduled'
  | 'movie-not-current'
  | 'series-ambiguous'
  | 'season-configuration'
  | 'season-unscheduled-secondary';

export interface R11BulkFixtureCase {
  kind: R11BulkFixtureKind;
  targetType: 'movie' | 'series' | 'season';
  expectedReason: LibraryBulkActionEligibilityReason;
}

const bulkPattern: readonly R11BulkFixtureCase[] = [
  {
    kind: 'movie-unscheduled',
    targetType: 'movie',
    expectedReason: 'unscheduled',
  },
  {
    kind: 'series-unscheduled',
    targetType: 'series',
    expectedReason: 'unscheduled',
  },
  {
    kind: 'season-unscheduled',
    targetType: 'season',
    expectedReason: 'unscheduled',
  },
  {
    kind: 'movie-scheduled',
    targetType: 'movie',
    expectedReason: 'scheduled',
  },
  {
    kind: 'series-leased',
    targetType: 'series',
    expectedReason: 'processing_lease',
  },
  {
    kind: 'season-whole-series-scheduled',
    targetType: 'season',
    expectedReason: 'whole_series_scheduled',
  },
  {
    kind: 'movie-not-current',
    targetType: 'movie',
    expectedReason: 'not_current',
  },
  {
    kind: 'series-ambiguous',
    targetType: 'series',
    expectedReason: 'ambiguous_source',
  },
  {
    kind: 'season-configuration',
    targetType: 'season',
    expectedReason: 'configuration',
  },
  {
    kind: 'season-unscheduled-secondary',
    targetType: 'season',
    expectedReason: 'unscheduled',
  },
] as const;

export const r11BulkFixtureCase = (index: number): R11BulkFixtureCase =>
  bulkPattern[index % bulkPattern.length];

export const R11_PERFORMANCE_TARGETS = {
  bulkEligibility: {
    maximumQueriesAt100Targets: 12,
    sqliteP95MillisecondsAt100Targets: 75,
  },
  browser: {
    maximumLongTaskMillisecondsAt100Cards: 100,
    maximumTotalLongTaskMillisecondsAt100Cards: 250,
    maximumDocumentTooltipListenersClosed: 1,
    maximumHorizontalOverflowPixels: 0,
  },
  tmdb: {
    maximumConcurrentDuplicateRequests: 1,
    maximumBackgroundConcurrency: 4,
  },
} as const;
