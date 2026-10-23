import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbCollection,
  TmdbMovieResult,
} from '@server/api/themoviedb/interfaces';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaType } from '@server/constants/media';
import type { WatchlistRouletteLimitReason } from '@server/constants/watchlistRoulette';
import { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import Media from '@server/entity/Media';
import { parseTmdbCollectionMembership } from '@server/lib/libraryCollectionMembership';
import type { WatchlistIdentity } from '@server/lib/watchlist';
import {
  classifyMovieLibraryStatusByTmdbIds,
  type MovieLibraryStatus,
} from '@server/lib/watchlistLibraryStatus';
import logger from '@server/logger';
import { performance } from 'node:perf_hooks';

export const WATCHLIST_ROULETTE_MAX_COLLECTION_CANDIDATES = 25;
export const WATCHLIST_ROULETTE_MAX_TMDB_RESOLUTIONS = 50;
export const WATCHLIST_ROULETTE_METADATA_DEADLINE_MS = 60_000;
export const WATCHLIST_ROULETTE_MAX_METADATA_WARNINGS = 5;

export type MovieCollectionMembership =
  | { kind: 'standalone' }
  | { kind: 'collection'; collectionId: number }
  | { kind: 'unresolved' };

export interface NormalizedCollectionMovie {
  tmdbId: number;
  releaseDate: string | null;
}

export interface WatchlistRouletteCollectionRunState {
  examinedCollectionIds: Set<number>;
  candidatesResolved: number;
  tmdbResolutions: number;
  metadataElapsedMs: number;
  metadataWarnings: number;
}

export type WatchlistRouletteMovieResolution =
  | { outcome: 'resolved'; candidate: WatchlistIdentity }
  | { outcome: 'skip' }
  | { outcome: 'limit'; limitReason: WatchlistRouletteLimitReason };

export interface WatchlistRouletteCollectionDependencies {
  getLocalMembership: (tmdbId: number) => Promise<MovieCollectionMembership>;
  getMovieForScan: (tmdbId: number) => Promise<TmdbMovieResult>;
  getCollection: (collectionId: number) => Promise<TmdbCollection>;
  classifyLibraryStatus: (
    tmdbIds: number[]
  ) => Promise<Map<number, MovieLibraryStatus>>;
  nowMs: () => number;
}

export const createWatchlistRouletteCollectionRunState =
  (): WatchlistRouletteCollectionRunState => ({
    examinedCollectionIds: new Set<number>(),
    candidatesResolved: 0,
    tmdbResolutions: 0,
    metadataElapsedMs: 0,
    metadataWarnings: 0,
  });

const hydratedMembership = (
  canonical: CanonicalMedia | null
): MovieCollectionMembership => {
  if (!canonical?.collectionMembershipHydratedAt) return { kind: 'unresolved' };
  if (canonical.tmdbCollectionId === null) return { kind: 'standalone' };
  if (
    Number.isSafeInteger(canonical.tmdbCollectionId) &&
    Number(canonical.tmdbCollectionId) > 0
  ) {
    return {
      kind: 'collection',
      collectionId: Number(canonical.tmdbCollectionId),
    };
  }
  return { kind: 'unresolved' };
};

export const getLocalMovieCollectionMembership = async (
  tmdbId: number
): Promise<MovieCollectionMembership> => {
  const identity = await getRepository(CanonicalMediaIdentity).findOne({
    where: {
      provider: 'tmdb',
      sourceScope: '',
      mediaType: LibraryMediaType.MOVIE,
      value: String(tmdbId),
    },
    relations: ['canonicalMedia'],
  });
  if (identity) return hydratedMembership(identity.canonicalMedia);

  const fallback = await getRepository(CanonicalMedia)
    .createQueryBuilder('canonical')
    .innerJoin(Media, 'media', 'media.id = canonical.currentMediaId')
    .where('canonical.mediaType = :canonicalMediaType', {
      canonicalMediaType: LibraryMediaType.MOVIE,
    })
    .andWhere('media.mediaType = :mediaType', {
      mediaType: MediaType.MOVIE,
    })
    .andWhere('media.tmdbId = :tmdbId', { tmdbId })
    .getOne();
  return hydratedMembership(fallback);
};

const membershipFromProvider = (
  candidateTmdbId: number,
  movie: TmdbMovieResult
): MovieCollectionMembership => {
  if (movie?.id !== candidateTmdbId) return { kind: 'unresolved' };
  if (!Object.prototype.hasOwnProperty.call(movie, 'belongs_to_collection')) {
    return { kind: 'unresolved' };
  }
  const parsed = parseTmdbCollectionMembership(
    movie.belongs_to_collection,
    new Date(0)
  );
  if (!parsed) return { kind: 'unresolved' };
  return parsed.tmdbCollectionId === null
    ? { kind: 'standalone' }
    : { kind: 'collection', collectionId: parsed.tmdbCollectionId };
};

const strictReleaseDate = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
    ? value
    : null;
};

const collectionMembershipConflicts = (
  part: TmdbMovieResult,
  collectionId: number
): boolean => {
  if (!Object.prototype.hasOwnProperty.call(part, 'belongs_to_collection')) {
    return false;
  }
  const membership = parseTmdbCollectionMembership(
    part.belongs_to_collection,
    new Date(0)
  );
  return membership?.tmdbCollectionId !== collectionId;
};

export const normalizeCollectionMovies = (
  collection: TmdbCollection,
  expectedCollectionId: number,
  selectedTmdbId: number
): NormalizedCollectionMovie[] | undefined => {
  if (
    !collection ||
    collection.id !== expectedCollectionId ||
    !Array.isArray(collection.parts)
  ) {
    return undefined;
  }

  const byTmdbId = new Map<number, NormalizedCollectionMovie>();
  for (const part of collection.parts) {
    if (
      !part ||
      !Number.isSafeInteger(part.id) ||
      part.id <= 0 ||
      collectionMembershipConflicts(part, expectedCollectionId)
    ) {
      if (part && collectionMembershipConflicts(part, expectedCollectionId)) {
        return undefined;
      }
      continue;
    }
    const normalized: NormalizedCollectionMovie = {
      tmdbId: part.id,
      releaseDate: strictReleaseDate(part.release_date),
    };
    const existing = byTmdbId.get(part.id);
    if (
      !existing ||
      (normalized.releaseDate !== null &&
        (existing.releaseDate === null ||
          normalized.releaseDate < existing.releaseDate))
    ) {
      byTmdbId.set(part.id, normalized);
    }
  }

  if (!byTmdbId.has(selectedTmdbId)) return undefined;
  return [...byTmdbId.values()].sort((left, right) => {
    if (left.releaseDate === null)
      return right.releaseDate === null ? left.tmdbId - right.tmdbId : 1;
    if (right.releaseDate === null) return -1;
    return (
      left.releaseDate.localeCompare(right.releaseDate) ||
      left.tmdbId - right.tmdbId
    );
  });
};

type TimedResult<T> =
  | { outcome: 'value'; value: T }
  | { outcome: 'error' }
  | { outcome: 'limit'; limitReason: WatchlistRouletteLimitReason };

type MetadataFailureOperation =
  | 'local-membership'
  | 'tmdb-movie-membership'
  | 'tmdb-collection'
  | 'library-classification';

const defaultDependencies = (): WatchlistRouletteCollectionDependencies => {
  const tmdb = new TheMovieDb();
  return {
    getLocalMembership: getLocalMovieCollectionMembership,
    getMovieForScan: (tmdbId) => tmdb.getMovieForScan({ movieId: tmdbId }),
    getCollection: (collectionId) => tmdb.getCollection({ collectionId }),
    classifyLibraryStatus: classifyMovieLibraryStatusByTmdbIds,
    nowMs: () => performance.now(),
  };
};

export class WatchlistRouletteCollectionResolver {
  private readonly dependencies: WatchlistRouletteCollectionDependencies;

  constructor(
    dependencies: Partial<WatchlistRouletteCollectionDependencies> = {}
  ) {
    this.dependencies = { ...defaultDependencies(), ...dependencies };
  }

  private warnMetadataFailure(
    state: WatchlistRouletteCollectionRunState,
    operation: MetadataFailureOperation,
    tmdbId: number,
    collectionId?: number
  ): void {
    if (state.metadataWarnings >= WATCHLIST_ROULETTE_MAX_METADATA_WARNINGS) {
      return;
    }
    state.metadataWarnings += 1;
    logger.warn('Watchlist Roulette metadata resolution failed closed', {
      label: 'Watchlist Roulette',
      operation,
      tmdbId,
      ...(collectionId !== undefined && { collectionId }),
    });
  }

  private currentLimit(
    state: WatchlistRouletteCollectionRunState
  ): WatchlistRouletteLimitReason | undefined {
    if (
      state.candidatesResolved >=
        WATCHLIST_ROULETTE_MAX_COLLECTION_CANDIDATES ||
      state.tmdbResolutions >= WATCHLIST_ROULETTE_MAX_TMDB_RESOLUTIONS
    ) {
      return 'metadata-budget';
    }
    if (state.metadataElapsedMs >= WATCHLIST_ROULETTE_METADATA_DEADLINE_MS) {
      return 'metadata-deadline';
    }
    return undefined;
  }

  private operationLimit(
    state: WatchlistRouletteCollectionRunState,
    tmdbResolution: boolean
  ): WatchlistRouletteLimitReason | undefined {
    if (
      tmdbResolution &&
      state.tmdbResolutions >= WATCHLIST_ROULETTE_MAX_TMDB_RESOLUTIONS
    ) {
      return 'metadata-budget';
    }
    if (state.metadataElapsedMs >= WATCHLIST_ROULETTE_METADATA_DEADLINE_MS) {
      return 'metadata-deadline';
    }
    return undefined;
  }

  private async timed<T>(
    state: WatchlistRouletteCollectionRunState,
    operation: () => Promise<T>,
    tmdbResolution = false
  ): Promise<TimedResult<T>> {
    const existingLimit = this.operationLimit(state, tmdbResolution);
    if (existingLimit) return { outcome: 'limit', limitReason: existingLimit };
    if (tmdbResolution) state.tmdbResolutions += 1;
    const startedAt = this.dependencies.nowMs();
    try {
      const value = await operation();
      state.metadataElapsedMs += Math.max(
        0,
        this.dependencies.nowMs() - startedAt
      );
      if (state.metadataElapsedMs >= WATCHLIST_ROULETTE_METADATA_DEADLINE_MS) {
        return { outcome: 'limit', limitReason: 'metadata-deadline' };
      }
      return { outcome: 'value', value };
    } catch {
      state.metadataElapsedMs += Math.max(
        0,
        this.dependencies.nowMs() - startedAt
      );
      if (state.metadataElapsedMs >= WATCHLIST_ROULETTE_METADATA_DEADLINE_MS) {
        return { outcome: 'limit', limitReason: 'metadata-deadline' };
      }
      return { outcome: 'error' };
    }
  }

  public async resolve(
    candidate: WatchlistIdentity,
    state: WatchlistRouletteCollectionRunState
  ): Promise<WatchlistRouletteMovieResolution> {
    const existingLimit = this.currentLimit(state);
    if (existingLimit) return { outcome: 'limit', limitReason: existingLimit };
    state.candidatesResolved += 1;

    const local = await this.timed(state, () =>
      this.dependencies.getLocalMembership(candidate.tmdbId)
    );
    if (local.outcome !== 'value') {
      if (local.outcome === 'limit') return local;
      this.warnMetadataFailure(state, 'local-membership', candidate.tmdbId);
      return { outcome: 'skip' };
    }
    let membership = local.value;

    if (membership.kind === 'unresolved') {
      const provider = await this.timed(
        state,
        () => this.dependencies.getMovieForScan(candidate.tmdbId),
        true
      );
      if (provider.outcome !== 'value') {
        if (provider.outcome === 'limit') return provider;
        this.warnMetadataFailure(
          state,
          'tmdb-movie-membership',
          candidate.tmdbId
        );
        return { outcome: 'skip' };
      }
      membership = membershipFromProvider(candidate.tmdbId, provider.value);
      if (membership.kind === 'unresolved') return { outcome: 'skip' };
    }

    if (membership.kind === 'standalone') {
      return { outcome: 'resolved', candidate };
    }

    if (state.examinedCollectionIds.has(membership.collectionId)) {
      return { outcome: 'skip' };
    }
    state.examinedCollectionIds.add(membership.collectionId);

    const collection = await this.timed(
      state,
      () => this.dependencies.getCollection(membership.collectionId),
      true
    );
    if (collection.outcome !== 'value') {
      if (collection.outcome === 'limit') return collection;
      this.warnMetadataFailure(
        state,
        'tmdb-collection',
        candidate.tmdbId,
        membership.collectionId
      );
      return { outcome: 'skip' };
    }
    const movies = normalizeCollectionMovies(
      collection.value,
      membership.collectionId,
      candidate.tmdbId
    );
    if (!movies?.length) return { outcome: 'skip' };

    const statuses = await this.timed(state, () =>
      this.dependencies.classifyLibraryStatus(
        movies.map((movie) => movie.tmdbId)
      )
    );
    if (statuses.outcome !== 'value') {
      if (statuses.outcome === 'limit') return statuses;
      this.warnMetadataFailure(
        state,
        'library-classification',
        candidate.tmdbId,
        membership.collectionId
      );
      return { outcome: 'skip' };
    }
    if (movies.some((movie) => !statuses.value.has(movie.tmdbId))) {
      return { outcome: 'skip' };
    }
    const earliestAbsent = movies.find(
      (movie) => statuses.value.get(movie.tmdbId) === 'absent'
    );
    return earliestAbsent
      ? {
          outcome: 'resolved',
          candidate: {
            mediaType: MediaType.MOVIE,
            tmdbId: earliestAbsent.tmdbId,
          },
        }
      : { outcome: 'skip' };
  }
}
