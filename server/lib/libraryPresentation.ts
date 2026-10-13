import { randomUUID } from 'node:crypto';

import { getMetadataProvider } from '@server/api/metadata';
import TheMovieDb from '@server/api/themoviedb';
import { ANIME_KEYWORD_ID } from '@server/api/themoviedb/constants';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import type {
  LibraryPresentationBatchStatus,
  LibraryPresentationStatus,
} from '@server/interfaces/api/libraryInterfaces';
import { BoundedRequestCoordinator } from '@server/lib/boundedRequestCoordinator';
import cacheManager, { type CacheStore } from '@server/lib/cache';
import logger from '@server/logger';

export interface LibraryPresentation {
  title: string;
  year: number | null;
  posterPath: string | null;
  backdropPath: string | null;
  voteAverage?: number | null;
  voteCount?: number | null;
  collection?: {
    id: number;
    name: string;
    posterPath: string | null;
    backdropPath: string | null;
  } | null;
}

export interface LibraryPresentationIdentity {
  mediaType: LibraryMediaType;
  tmdbId: number;
}

interface PresentationBatch {
  keys: string[];
  expiresAt: number;
}

interface PresentationFailure {
  retryAt: number;
}

interface LibraryPresentationCoordinatorOptions {
  fetchPresentation?: typeof fetchLibraryPresentation;
  cache?: CacheStore;
  queue?: BoundedRequestCoordinator;
  now?: () => number;
  uuid?: () => string;
  failureRetryMs?: number;
  batchTtlMs?: number;
  maxBatches?: number;
}

const PRESENTATION_TTL_SECONDS = 21_600;
const PRESENTATION_FAILURE_RETRY_MS = 30_000;
const PRESENTATION_BATCH_TTL_MS = 120_000;
const PRESENTATION_MAX_BATCHES = 500;

const providerYear = (value?: string | null): number | null => {
  const year = value ? Number(value.slice(0, 4)) : NaN;
  return Number.isSafeInteger(year) && year > 0 ? year : null;
};

export const fetchLibraryPresentation = async (
  mediaType: LibraryMediaType,
  tmdbId: number,
  locale: string
): Promise<LibraryPresentation> => {
  const tmdb = new TheMovieDb();
  if (mediaType === LibraryMediaType.MOVIE) {
    const movie = await tmdb.getMovie({ movieId: tmdbId, language: locale });
    return {
      title: movie.title,
      year: providerYear(movie.release_date),
      posterPath: movie.poster_path ?? null,
      backdropPath: movie.backdrop_path ?? null,
      voteAverage: movie.vote_average ?? null,
      voteCount: movie.vote_count ?? null,
      collection: movie.belongs_to_collection
        ? {
            id: movie.belongs_to_collection.id,
            name: movie.belongs_to_collection.name,
            posterPath: movie.belongs_to_collection.poster_path ?? null,
            backdropPath: movie.belongs_to_collection.backdrop_path ?? null,
          }
        : null,
    };
  }
  const tmdbTv = await tmdb.getTvShow({ tvId: tmdbId, language: locale });
  const provider = tmdbTv.keywords.results.some(
    ({ id }) => id === ANIME_KEYWORD_ID
  )
    ? await getMetadataProvider('anime')
    : await getMetadataProvider('tv');
  const series = await provider.getTvShow({ tvId: tmdbId, language: locale });
  return {
    title: series.name,
    year: providerYear(series.first_air_date),
    posterPath: series.poster_path ?? null,
    backdropPath: series.backdrop_path ?? null,
    voteAverage: series.vote_average ?? null,
    voteCount: series.vote_count ?? null,
  };
};

const presentationKey = (
  { mediaType, tmdbId }: LibraryPresentationIdentity,
  locale: string
) => `${mediaType}:${tmdbId}:${locale || 'en'}`;

export class LibraryPresentationCoordinator {
  private readonly fetchPresentation: typeof fetchLibraryPresentation;
  private readonly cache: CacheStore;
  private readonly queue: BoundedRequestCoordinator;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly failureRetryMs: number;
  private readonly batchTtlMs: number;
  private readonly maxBatches: number;
  private readonly pending = new Set<string>();
  private readonly failures = new Map<string, PresentationFailure>();
  private readonly batches = new Map<string, PresentationBatch>();
  private revision = 0;
  private stopped = false;

  constructor(options: LibraryPresentationCoordinatorOptions = {}) {
    this.fetchPresentation =
      options.fetchPresentation ?? fetchLibraryPresentation;
    this.cache =
      options.cache ?? cacheManager.getCache('librarypresentation').data;
    this.queue =
      options.queue ??
      new BoundedRequestCoordinator({ maxConcurrency: 4, maxPending: 100 });
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.failureRetryMs =
      options.failureRetryMs ?? PRESENTATION_FAILURE_RETRY_MS;
    this.batchTtlMs = options.batchTtlMs ?? PRESENTATION_BATCH_TTL_MS;
    this.maxBatches = options.maxBatches ?? PRESENTATION_MAX_BATCHES;
  }

  public prepare(
    identities: LibraryPresentationIdentity[],
    locale: string
  ): {
    presentations: Map<string, LibraryPresentation>;
    status: LibraryPresentationBatchStatus;
  } {
    const normalizedLocale = locale || 'en';
    const unique = [
      ...new Map(
        identities.map((identity) => [
          presentationKey(identity, normalizedLocale),
          identity,
        ])
      ).entries(),
    ];
    const presentations = new Map<string, LibraryPresentation>();
    const pendingKeys: string[] = [];
    let failedCount = 0;
    const current = this.now();

    for (const [key, identity] of unique) {
      const cached = this.cache.get<LibraryPresentation>(key);
      if (cached) {
        presentations.set(`${identity.mediaType}:${identity.tmdbId}`, cached);
        continue;
      }
      const failure = this.failures.get(key);
      if (this.stopped || (failure && failure.retryAt > current)) {
        failedCount += 1;
        continue;
      }
      if (failure) this.failures.delete(key);
      pendingKeys.push(key);
      this.enqueue(key, identity, normalizedLocale);
    }

    const status = this.createStatus(pendingKeys, failedCount);
    return { presentations, status };
  }

  public status(batchId: string): LibraryPresentationStatus {
    this.pruneBatches();
    const batch = this.batches.get(batchId);
    if (!batch) {
      return {
        state: 'expired',
        revision: this.revision,
        pendingCount: 0,
      };
    }
    let pendingCount = 0;
    let failedCount = 0;
    const current = this.now();
    for (const key of batch.keys) {
      if (this.cache.get<LibraryPresentation>(key)) continue;
      if (this.pending.has(key)) pendingCount += 1;
      else if ((this.failures.get(key)?.retryAt ?? 0) > current)
        failedCount += 1;
      else failedCount += 1;
    }
    const state =
      pendingCount > 0 ? 'pending' : failedCount > 0 ? 'partial' : 'complete';
    if (state !== 'pending') this.batches.delete(batchId);
    return { state, revision: this.revision, pendingCount };
  }

  public shutdown(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.queue.close('Library presentation enrichment is shutting down');
    this.batches.clear();
  }

  public stats() {
    return {
      ...this.queue.stats(),
      enrichmentPending: this.pending.size,
      batches: this.batches.size,
      failures: this.failures.size,
      revision: this.revision,
      stopped: this.stopped,
    };
  }

  private enqueue(
    key: string,
    identity: LibraryPresentationIdentity,
    locale: string
  ): void {
    if (this.stopped || this.pending.has(key)) return;
    this.pending.add(key);
    void this.queue
      .schedule(() =>
        this.fetchPresentation(identity.mediaType, identity.tmdbId, locale)
      )
      .then((presentation) => {
        if (this.stopped) return;
        this.cache.set(key, presentation, PRESENTATION_TTL_SECONDS);
        this.failures.delete(key);
        this.revision += 1;
      })
      .catch((error) => {
        if (this.stopped) return;
        this.failures.set(key, {
          retryAt: this.now() + this.failureRetryMs,
        });
        logger.warn('Library presentation enrichment unavailable', {
          label: 'Library',
          mediaType: identity.mediaType,
          tmdbId: identity.tmdbId,
          message: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => this.pending.delete(key));
  }

  private createStatus(
    pendingKeys: string[],
    failedCount: number
  ): LibraryPresentationBatchStatus {
    if (pendingKeys.length === 0) {
      return {
        state: failedCount > 0 ? 'partial' : 'complete',
        revision: this.revision,
        pendingCount: 0,
      };
    }
    this.pruneBatches();
    while (this.batches.size >= this.maxBatches) {
      const oldest = this.batches.keys().next().value;
      if (!oldest) break;
      this.batches.delete(oldest);
    }
    const batchId = this.uuid();
    this.batches.set(batchId, {
      keys: pendingKeys,
      expiresAt: this.now() + this.batchTtlMs,
    });
    return {
      state: 'pending',
      batchId,
      revision: this.revision,
      pendingCount: pendingKeys.length,
    };
  }

  private pruneBatches(): void {
    const current = this.now();
    for (const [id, batch] of this.batches) {
      if (batch.expiresAt <= current) this.batches.delete(id);
    }
  }
}

const libraryPresentation = new LibraryPresentationCoordinator();
export default libraryPresentation;
