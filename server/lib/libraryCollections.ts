import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbCollection,
  TmdbMovieDetails,
} from '@server/api/themoviedb/interfaces';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import Media from '@server/entity/Media';
import type {
  LibraryCollectionCompletenessFilter,
  LibraryCollectionHydrationState,
  LibraryCollectionItem,
  LibraryCollectionSort,
  LibraryCollectionsResponse,
  LibrarySortDirection,
} from '@server/interfaces/api/libraryInterfaces';
import backgroundDatabaseWriteCoordinator from '@server/lib/backgroundDatabaseWriteCoordinator';
import { BoundedRequestCoordinator } from '@server/lib/boundedRequestCoordinator';
import { currentLibraryPresenceSql } from '@server/lib/libraryActivity';
import {
  parseTmdbCollectionMembership,
  persistMovieCollectionMembership,
} from '@server/lib/libraryCollectionMembership';
import { classifyMovieLibraryStatusByTmdbIds } from '@server/lib/watchlistLibraryStatus';
import logger from '@server/logger';
import { LRUCache } from 'lru-cache';
import { In, MoreThan } from 'typeorm';

const COLLECTION_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
const UNAVAILABLE_RETRY_MS = 30 * 1000;
const MISSING_COLLECTION_RETRY_MS = 5 * 60 * 1000;
const MEMBERSHIP_RECOVERY_RETRY_MS = 60 * 1000;
export const COLLECTION_RECOVERY_BATCH_SIZE = 50;
const COLLECTION_METADATA_CONCURRENCY = 4;
const AVAILABILITY_CHUNK_SIZE = 500;

export interface LibraryCollectionsQuery {
  take: number;
  skip: number;
  completeness: LibraryCollectionCompletenessFilter;
  sort: LibraryCollectionSort;
  sortDirection: LibrarySortDirection;
  locale: string;
}

interface CollectionSnapshot {
  fingerprint: string;
  items: LibraryCollectionItem[];
  byId: Map<number, LibraryCollectionItem>;
  refreshedAt: Date;
  generation: number;
}

interface CollectionRuntime {
  snapshot?: CollectionSnapshot;
  active?: Promise<void>;
  desiredFingerprint?: string;
  status: LibraryCollectionHydrationState;
  failedCollections: number;
  lastAttemptAt?: Date;
  lastAttemptGeneration?: number;
  lastAttemptFingerprint?: string;
  generation: number;
  retryTimer?: NodeJS.Timeout;
  retryDelayMs?: number;
}

export interface CollectionCountLookup {
  availableMovies: number | null;
  totalMovies: number | null;
  countStatus: LibraryCollectionHydrationState;
  countStale: boolean;
  countRefreshedAt: string | null;
}

interface CollectionMetadataResult {
  id: number;
  collection?: TmdbCollection;
  failed: boolean;
}

interface MembershipRecoveryState {
  afterCanonicalId: number;
  retryAt: number;
}

export interface LibraryCollectionsDependencies {
  discoverCollectionIds: () => Promise<number[]>;
  fetchCollection: (id: number, locale: string) => Promise<TmdbCollection>;
  fetchMovie: (id: number, locale: string) => Promise<TmdbMovieDetails>;
  fetchMovieMembership: (id: number) => Promise<{
    id: number;
    belongs_to_collection?: unknown;
  }>;
  fetchPhysicalMovieIds: (tmdbIds: number[]) => Promise<Set<number>>;
  fetchAvailability: (tmdbIds: number[]) => Promise<Map<number, boolean>>;
  now: () => Date;
  snapshotTtlMs: number;
  unavailableRetryMs: number;
  missingCollectionRetryMs: number;
  metadataConcurrency: number;
}

const discoverCurrentCollectionIds = async (): Promise<number[]> => {
  const rows = await getRepository(CanonicalMedia)
    .createQueryBuilder('canonical')
    .select('canonical.tmdbCollectionId', 'tmdbCollectionId')
    .distinct(true)
    .innerJoin(
      LibraryPresence,
      'presence',
      `presence.canonicalMediaId = canonical.id AND ${currentLibraryPresenceSql(
        'presence',
        ':isCurrent'
      )}`,
      { isCurrent: true }
    )
    .where('canonical.mediaType = :mediaType', {
      mediaType: LibraryMediaType.MOVIE,
    })
    .andWhere('canonical.collectionMembershipHydratedAt IS NOT NULL')
    .andWhere('canonical.tmdbCollectionId IS NOT NULL')
    .orderBy('canonical.tmdbCollectionId', 'ASC')
    .getRawMany<{ tmdbCollectionId: number | string }>();

  return rows
    .map((row) => Number(row.tmdbCollectionId))
    .filter((id) => Number.isSafeInteger(id) && id > 0);
};

/** Detect committed physical-anchor and association changes around hydration. */
export const currentPhysicalCollectionSignature = async (): Promise<string> => {
  const rows = await getRepository(CanonicalMedia)
    .createQueryBuilder('canonical')
    .select('canonical.id', 'canonicalId')
    .addSelect('canonical.tmdbCollectionId', 'collectionId')
    .distinct(true)
    .innerJoin(
      LibraryPresence,
      'presence',
      `presence.canonicalMediaId = canonical.id AND ${currentLibraryPresenceSql(
        'presence',
        ':isCurrent'
      )}`,
      { isCurrent: true }
    )
    .where('canonical.mediaType = :mediaType', {
      mediaType: LibraryMediaType.MOVIE,
    })
    .andWhere('canonical.tmdbCollectionId IS NOT NULL')
    .orderBy('canonical.id', 'ASC')
    .getRawMany<{
      canonicalId: number | string;
      collectionId: number | string;
    }>();
  return rows.map((row) => `${row.canonicalId}:${row.collectionId}`).join('|');
};

/** Unknown membership for a current Movie prevents an exhaustive index claim. */
export const unresolvedCurrentMovieCollectionMembershipCount =
  async (): Promise<number> =>
    getRepository(CanonicalMedia)
      .createQueryBuilder('canonical')
      .innerJoin(
        LibraryPresence,
        'presence',
        `presence.canonicalMediaId = canonical.id AND ${currentLibraryPresenceSql(
          'presence',
          ':isCurrent'
        )}`,
        { isCurrent: true }
      )
      .where('canonical.mediaType = :mediaType', {
        mediaType: LibraryMediaType.MOVIE,
      })
      .andWhere('canonical.collectionMembershipHydratedAt IS NULL')
      .distinct(true)
      .getCount();

const fetchStrictAvailability = async (
  tmdbIds: number[]
): Promise<Map<number, boolean>> => {
  const distinctIds = [...new Set(tmdbIds)];
  const result = new Map<number, boolean>(
    distinctIds.map((tmdbId) => [tmdbId, false])
  );

  for (
    let offset = 0;
    offset < distinctIds.length;
    offset += AVAILABILITY_CHUNK_SIZE
  ) {
    const ids = distinctIds.slice(offset, offset + AVAILABILITY_CHUNK_SIZE);
    if (ids.length === 0) continue;
    const rows = await getRepository(Media).find({
      select: { tmdbId: true, status: true },
      where: { mediaType: MediaType.MOVIE, tmdbId: In(ids) },
    });
    for (const row of rows) {
      if (row.status === MediaStatus.AVAILABLE) result.set(row.tmdbId, true);
    }
  }

  return result;
};

const fetchPhysicalMovieIds = async (
  tmdbIds: number[]
): Promise<Set<number>> => {
  const distinctIds = [...new Set(tmdbIds)].filter(
    (id) => Number.isSafeInteger(id) && id > 0
  );
  if (distinctIds.length === 0) return new Set();
  // This lookup only decides whether an already-discovered collection member
  // may override an unreleased TMDB status. Collection discovery remains
  // current-physical-only in discoverCurrentCollectionIds above.
  const statusByTmdbId = await classifyMovieLibraryStatusByTmdbIds(distinctIds);
  return new Set(
    [...statusByTmdbId]
      .filter(([, status]) => status !== 'absent')
      .map(([tmdbId]) => tmdbId)
  );
};

const defaultDependencies = (): LibraryCollectionsDependencies => {
  const tmdb = new TheMovieDb();
  return {
    discoverCollectionIds: discoverCurrentCollectionIds,
    fetchCollection: (id, locale) =>
      tmdb.getCollection({ collectionId: id, language: locale }),
    fetchMovie: (id, locale) =>
      tmdb.getMovie({ movieId: id, language: locale }),
    fetchMovieMembership: (id) => tmdb.getMovieCollectionMembership(id),
    fetchPhysicalMovieIds,
    fetchAvailability: fetchStrictAvailability,
    now: () => new Date(),
    snapshotTtlMs: COLLECTION_SNAPSHOT_TTL_MS,
    unavailableRetryMs: UNAVAILABLE_RETRY_MS,
    missingCollectionRetryMs: MISSING_COLLECTION_RETRY_MS,
    metadataConcurrency: COLLECTION_METADATA_CONCURRENCY,
  };
};

const mapBounded = async <T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(Math.max(1, concurrency), values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await mapper(values[index]);
      }
    }
  );
  await Promise.all(workers);
  return results;
};

const collectionFingerprint = (ids: number[]): string => ids.join(',');

const collectionNotFound = (error: unknown): boolean => {
  // The TMDB client wraps Axios errors with cause. Do not infer status from text.
  let current = error;
  for (
    let depth = 0;
    depth < 4 && current && typeof current === 'object';
    depth++
  ) {
    const candidate = current as {
      response?: { status?: number };
      cause?: unknown;
    };
    if (candidate.response?.status === 404) return true;
    current = candidate.cause;
  }
  return false;
};

const collectionItem = (
  collection: TmdbCollection,
  availability: Map<number, boolean>,
  visibleMemberIds: ReadonlySet<number>
): LibraryCollectionItem | null => {
  const visibleParts = collection.parts.filter((part) =>
    visibleMemberIds.has(Number(part.id))
  );
  const memberIds = [
    ...new Set(
      visibleParts
        .map((part) => Number(part.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ];
  if (memberIds.length === 0) return null;
  const posterPath =
    collection.poster_path ??
    visibleParts.find(
      (part) => availability.get(Number(part.id)) && part.poster_path
    )?.poster_path ??
    visibleParts.find((part) => part.poster_path)?.poster_path ??
    null;
  const availableMovies = memberIds.filter((id) => availability.get(id)).length;
  return {
    id: collection.id,
    name: collection.name,
    overview: collection.overview ?? null,
    posterPath,
    backdropPath: collection.backdrop_path ?? null,
    availableMovies,
    totalMovies: memberIds.length,
    completeness:
      availableMovies === memberIds.length ? 'complete' : 'incomplete',
  };
};

const compareNullableNumber = (
  left: number | null,
  right: number | null,
  direction: LibrarySortDirection
): number => {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return direction === 'asc' ? left - right : right - left;
};

const compareCompletenessRatio = (
  left: LibraryCollectionItem,
  right: LibraryCollectionItem,
  direction: LibrarySortDirection
): number => {
  const leftAvailable = left.availableMovies;
  const leftTotal = left.totalMovies;
  const rightAvailable = right.availableMovies;
  const rightTotal = right.totalMovies;
  const leftKnown =
    leftAvailable !== null && leftTotal !== null && leftTotal > 0;
  const rightKnown =
    rightAvailable !== null && rightTotal !== null && rightTotal > 0;

  if (!leftKnown) {
    if (!rightKnown) return 0;
    return 1;
  }
  if (!rightKnown) return -1;

  const comparison = leftAvailable * rightTotal - rightAvailable * leftTotal;
  return direction === 'asc' ? comparison : -comparison;
};

const sortCollections = (
  items: LibraryCollectionItem[],
  sort: LibraryCollectionSort,
  direction: LibrarySortDirection
): LibraryCollectionItem[] => {
  return [...items].sort((left, right) => {
    let comparison = 0;
    if (sort === 'name')
      comparison = left.name.localeCompare(right.name, undefined, {
        sensitivity: 'base',
      });
    else if (sort === 'available')
      comparison = compareNullableNumber(
        left.availableMovies,
        right.availableMovies,
        direction
      );
    else comparison = compareCompletenessRatio(left, right, direction);
    if (sort === 'name' && direction === 'desc') comparison *= -1;
    if (comparison !== 0) return comparison;
    const nameComparison = left.name.localeCompare(right.name, undefined, {
      sensitivity: 'base',
    });
    return nameComparison || left.id - right.id;
  });
};

export class LibraryCollectionsService {
  private readonly dependencies: LibraryCollectionsDependencies;
  private readonly runtimes = new Map<string, CollectionRuntime>();
  private refreshReady: boolean;
  // A missing collection is independent of locale. Bound memory and retry
  // after five minutes; no durable negative records.
  private readonly missingCollections = new LRUCache<number, number>({
    max: 1000,
  });
  private readonly recoveryStates = new LRUCache<
    number,
    MembershipRecoveryState
  >({
    max: 1000,
  });
  private readonly recoveryInFlight = new Map<number, Promise<number>>();
  private readonly recoveryRequests = new BoundedRequestCoordinator({
    maxConcurrency: COLLECTION_METADATA_CONCURRENCY,
    maxPending: COLLECTION_RECOVERY_BATCH_SIZE,
  });

  constructor(
    dependencies: Partial<LibraryCollectionsDependencies> = {},
    refreshReady = true
  ) {
    this.dependencies = { ...defaultDependencies(), ...dependencies };
    this.refreshReady = refreshReady;
  }

  /** Hold last-good data while required physical Movie membership is unresolved. */
  public setRefreshReady(ready: boolean): void {
    if (this.refreshReady === ready) return;
    this.refreshReady = ready;
    for (const [locale, runtime] of this.runtimes) {
      if (!ready) {
        runtime.generation++;
        if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
        runtime.retryTimer = undefined;
        runtime.status = runtime.snapshot ? 'partial' : 'pending';
      } else {
        this.scheduleQuery(locale);
      }
    }
  }

  private runtime(locale: string): CollectionRuntime {
    const existing = this.runtimes.get(locale);
    if (existing) return existing;
    const created: CollectionRuntime = {
      status: 'pending',
      failedCollections: 0,
      generation: 0,
    };
    this.runtimes.set(locale, created);
    return created;
  }

  private async reconcileMembership(
    id: number,
    state: MembershipRecoveryState,
    budget: number
  ): Promise<number> {
    const repository = getRepository(CanonicalMedia);
    const targetsAfter = (afterCanonicalId: number) =>
      repository.find({
        select: { id: true },
        where: {
          mediaType: LibraryMediaType.MOVIE,
          tmdbCollectionId: id,
          id: MoreThan(afterCanonicalId),
        },
        order: { id: 'ASC' },
        take: budget,
      });
    let targets = await targetsAfter(state.afterCanonicalId);
    // Wrap to revisit unchanged, failed or previously ambiguous targets. Cursor
    // progress is by canonical ID, not an offset shifted by successful removals.
    if (targets.length === 0 && state.afterCanonicalId !== 0) {
      state.afterCanonicalId = 0;
      targets = await targetsAfter(0);
    }
    if (targets.length === 0) return 0;
    const rows = await repository
      .createQueryBuilder('canonical')
      .innerJoin(
        CanonicalMediaIdentity,
        'identity',
        'identity.canonicalMediaId = canonical.id AND ' +
          'identity.mediaType = canonical.mediaType AND ' +
          "identity.provider = 'tmdb' AND identity.sourceScope = ''"
      )
      .select('canonical.id', 'canonicalMediaId')
      .addSelect('identity.value', 'tmdbId')
      .where('canonical.mediaType = :mediaType', {
        mediaType: LibraryMediaType.MOVIE,
      })
      .andWhere('canonical.tmdbCollectionId = :id', { id })
      .andWhere('canonical.id IN (:...targetIds)', {
        targetIds: targets.map((target) => target.id),
      })
      .getRawMany<{ canonicalMediaId: number; tmdbId: string }>();
    const identities = new Map<number, Set<number>>();
    for (const row of rows) {
      const ids = identities.get(row.canonicalMediaId) ?? new Set<number>();
      ids.add(Number(row.tmdbId));
      identities.set(row.canonicalMediaId, ids);
    }
    await mapBounded(
      [...identities],
      this.dependencies.metadataConcurrency,
      async ([canonicalMediaId, tmdbIds]) => {
        const [tmdbId] = tmdbIds;
        if (tmdbIds.size !== 1 || !Number.isSafeInteger(tmdbId) || tmdbId <= 0)
          return;
        const observedAt = this.dependencies.now();
        try {
          const movie = await this.recoveryRequests.schedule(() =>
            this.dependencies.fetchMovieMembership(tmdbId)
          );
          if (
            !movie ||
            movie.id !== tmdbId ||
            !Object.prototype.hasOwnProperty.call(
              movie,
              'belongs_to_collection'
            )
          )
            return;
          const collectionMembership = parseTmdbCollectionMembership(
            movie.belongs_to_collection,
            observedAt
          );
          if (!collectionMembership) return;
          // Foundation holds this coordinator across canonical read/save work.
          // Queue only persistence; provider reads and scheduling stay outside.
          await backgroundDatabaseWriteCoordinator.runExclusive(() =>
            persistMovieCollectionMembership(repository, {
              canonicalMediaId,
              expectedCollectionId: id,
              collectionMembership,
            })
          );
        } catch {
          // Failed Movie observations cannot clear membership. The bounded
          // collection retry or existing Library metadata hydration can recover.
          logger.warn('Unable to reconcile Library collection membership', {
            label: 'Library Collections',
            collectionId: id,
          });
        }
      }
    );
    state.afterCanonicalId = targets[targets.length - 1].id;
    return targets.length;
  }

  private async recoverMembership(ids: number[]): Promise<void> {
    let budget = COLLECTION_RECOVERY_BATCH_SIZE;
    // Oldest-attempt-first prevents one retained collection from starving other
    // missing collections. All state is bounded, process-local and query-driven.
    const missing = ids
      .filter((id) => this.missingCollections.has(id))
      .sort(
        (a, b) =>
          (this.recoveryStates.peek(a)?.retryAt ?? 0) -
            (this.recoveryStates.peek(b)?.retryAt ?? 0) || a - b
      );
    for (const id of missing) {
      const active = this.recoveryInFlight.get(id);
      if (active) {
        budget -= await active;
      } else {
        const state = this.recoveryStates.get(id) ?? {
          afterCanonicalId: 0,
          retryAt: 0,
        };
        if (this.dependencies.now().getTime() < state.retryAt) continue;
        state.retryAt =
          this.dependencies.now().getTime() + MEMBERSHIP_RECOVERY_RETRY_MS;
        this.recoveryStates.set(id, state);
        const attempt = this.reconcileMembership(id, state, budget)
          .catch(() => {
            logger.warn('Unable to reconcile Library collection membership', {
              label: 'Library Collections',
              collectionId: id,
            });
            // Conservatively charge the attempt's budget if it fails outside
            // the per-target guard; never spend it twice in this refresh.
            return budget;
          })
          .finally(() => {
            state.retryAt =
              this.dependencies.now().getTime() + MEMBERSHIP_RECOVERY_RETRY_MS;
            if (this.recoveryInFlight.get(id) === attempt)
              this.recoveryInFlight.delete(id);
          });
        this.recoveryInFlight.set(id, attempt);
        budget -= await attempt;
      }
      if (budget <= 0) break;
    }
  }

  private async refresh(
    locale: string,
    ids: number[],
    fingerprint: string,
    runtime: CollectionRuntime,
    generation: number
  ): Promise<void> {
    const startedAt = this.dependencies.now();
    runtime.lastAttemptAt = startedAt;
    try {
      const metadata = await mapBounded(
        ids,
        this.dependencies.metadataConcurrency,
        async (id): Promise<CollectionMetadataResult> => {
          const retryAt = this.missingCollections.get(id);
          if (
            retryAt !== undefined &&
            this.dependencies.now().getTime() < retryAt
          )
            return { id, failed: true };
          this.missingCollections.delete(id);
          try {
            const collection = await this.dependencies.fetchCollection(
              id,
              locale
            );
            this.recoveryStates.delete(id);
            return {
              id,
              collection,
              failed: false,
            };
          } catch (error) {
            if (collectionNotFound(error)) {
              this.missingCollections.set(
                id,
                this.dependencies.now().getTime() +
                  this.dependencies.missingCollectionRetryMs
              );
            }
            logger.warn('Unable to refresh Library collection metadata', {
              label: 'Library Collections',
              collectionId: id,
              errorMessage:
                error instanceof Error ? error.message : String(error),
            });
            return { id, failed: true };
          }
        }
      );
      await this.recoverMembership(ids);
      const currentFingerprint = collectionFingerprint(
        await this.dependencies.discoverCollectionIds()
      );
      if (currentFingerprint !== fingerprint) {
        runtime.desiredFingerprint = currentFingerprint;
        return;
      }
      const successful = metadata.filter(
        (
          entry
        ): entry is CollectionMetadataResult & { collection: TmdbCollection } =>
          !entry.failed && Boolean(entry.collection)
      );
      const failedIds = new Set(
        metadata.filter((entry) => entry.failed).map((entry) => entry.id)
      );

      if (failedIds.size > 0) {
        if (
          runtime.desiredFingerprint !== fingerprint ||
          runtime.generation !== generation
        )
          return;
        runtime.status = runtime.snapshot ? 'partial' : 'unavailable';
        runtime.failedCollections = failedIds.size;
        const missingRetry = [...failedIds].map((id) =>
          this.missingCollections.get(id)
        );
        runtime.retryDelayMs = missingRetry.every(
          (value) => value !== undefined
        )
          ? Math.max(
              this.dependencies.unavailableRetryMs,
              Math.min(...(missingRetry as number[])) -
                this.dependencies.now().getTime()
            )
          : this.dependencies.unavailableRetryMs;
        return;
      }

      const memberIds = [
        ...new Set(
          successful.flatMap((entry) =>
            entry.collection.parts
              .map((part) => Number(part.id))
              .filter((id) => Number.isSafeInteger(id) && id > 0)
          )
        ),
      ];
      const [availability, physicalMovieIds, movieMetadata] = await Promise.all(
        [
          this.dependencies.fetchAvailability(memberIds),
          this.dependencies.fetchPhysicalMovieIds(memberIds),
          mapBounded(
            memberIds,
            this.dependencies.metadataConcurrency,
            async (id) => {
              try {
                return {
                  id,
                  status: (await this.dependencies.fetchMovie(id, locale))
                    .status,
                  failed: false,
                };
              } catch {
                return { id, status: null, failed: true };
              }
            }
          ),
        ]
      );
      if (movieMetadata.some((entry) => entry.failed)) {
        if (
          runtime.desiredFingerprint !== fingerprint ||
          runtime.generation !== generation
        )
          return;
        runtime.status = runtime.snapshot ? 'partial' : 'unavailable';
        runtime.failedCollections = ids.length;
        runtime.retryDelayMs = this.dependencies.unavailableRetryMs;
        return;
      }
      const visibleMemberIds = new Set(
        movieMetadata
          .filter(
            ({ id, status }) =>
              status === 'Released' || physicalMovieIds.has(id)
          )
          .map(({ id }) => id)
      );
      for (const id of physicalMovieIds) visibleMemberIds.add(id);
      const refreshedItems = successful.flatMap((entry) => {
        const item = collectionItem(
          entry.collection,
          availability,
          visibleMemberIds
        );
        return item ? [item] : [];
      });
      const refreshedAt = this.dependencies.now();
      if (
        runtime.desiredFingerprint !== fingerprint ||
        runtime.generation !== generation
      )
        return;
      runtime.snapshot = {
        fingerprint,
        items: refreshedItems,
        byId: new Map(refreshedItems.map((item) => [item.id, item])),
        refreshedAt,
        generation,
      };
      runtime.failedCollections = 0;
      runtime.status = 'complete';
      runtime.retryDelayMs = undefined;
      logger.info('Library collection snapshot refreshed', {
        label: 'Library Collections',
        discoveredCollections: ids.length,
        failedCollections: failedIds.size,
        durationMs: refreshedAt.getTime() - startedAt.getTime(),
      });
    } catch (error) {
      if (
        runtime.desiredFingerprint !== fingerprint ||
        runtime.generation !== generation
      )
        return;
      runtime.status = runtime.snapshot ? 'partial' : 'unavailable';
      runtime.failedCollections = Math.max(
        runtime.failedCollections,
        ids.length
      );
      runtime.retryDelayMs = this.dependencies.unavailableRetryMs;
      logger.warn('Unable to refresh Library collection snapshot', {
        label: 'Library Collections',
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private startRefresh(
    locale: string,
    ids: number[],
    fingerprint: string,
    runtime: CollectionRuntime
  ): void {
    if (runtime.active) return;
    runtime.status = 'pending';
    const generation = runtime.generation;
    runtime.lastAttemptGeneration = generation;
    runtime.lastAttemptFingerprint = fingerprint;
    runtime.active = this.refresh(
      locale,
      ids,
      fingerprint,
      runtime,
      generation
    ).finally(() => {
      runtime.active = undefined;
      if (
        runtime.generation !== generation ||
        runtime.desiredFingerprint !== fingerprint
      ) {
        this.scheduleQuery(locale);
      } else if (
        runtime.status === 'partial' ||
        runtime.status === 'unavailable'
      ) {
        this.scheduleQuery(
          locale,
          runtime.retryDelayMs ?? this.dependencies.unavailableRetryMs
        );
      }
    });
  }

  private scheduleQuery(locale: string, delayMs = 0): void {
    if (!this.refreshReady) return;
    const runtime = this.runtime(locale);
    if (runtime.retryTimer) clearTimeout(runtime.retryTimer);
    runtime.retryTimer = setTimeout(() => {
      runtime.retryTimer = undefined;
      if (!this.refreshReady) return;
      void this.query({
        take: 1,
        skip: 0,
        completeness: 'all',
        sort: 'name',
        sortDirection: 'asc',
        locale,
      }).catch((error) => {
        logger.warn('Unable to schedule Library collection snapshot refresh', {
          label: 'Library Collections',
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        this.scheduleQuery(locale, this.dependencies.unavailableRetryMs);
      });
    }, delayMs);
    runtime.retryTimer.unref?.();
  }

  /** Called after a committed collection-related change, not by card reads. */
  public invalidate(): void {
    for (const [locale, runtime] of this.runtimes) {
      runtime.generation++;
      if (this.refreshReady) this.scheduleQuery(locale);
    }
  }

  /** A cold direct detail visit may initialize its locale without waiting for a build. */
  public lookupById(
    id: number,
    locale: string,
    allowInitialization = true
  ): CollectionCountLookup {
    const runtime = this.runtime(locale);
    const snapshot = runtime.snapshot;
    const expired =
      snapshot !== undefined &&
      this.dependencies.now().getTime() - snapshot.refreshedAt.getTime() >=
        this.dependencies.snapshotTtlMs;
    if (
      allowInitialization &&
      (!snapshot || expired || snapshot.generation !== runtime.generation)
    )
      if (this.refreshReady && !runtime.active && !runtime.retryTimer)
        this.scheduleQuery(locale);
    const item = snapshot?.byId.get(id);
    return {
      availableMovies: item?.availableMovies ?? null,
      totalMovies: item?.totalMovies ?? null,
      countStatus:
        !snapshot && !allowInitialization
          ? 'unavailable'
          : runtime.active
            ? 'pending'
            : runtime.status,
      countStale:
        Boolean(snapshot) &&
        (expired ||
          Boolean(runtime.active) ||
          runtime.status === 'partial' ||
          snapshot?.generation !== runtime.generation),
      countRefreshedAt: snapshot?.refreshedAt.toISOString() ?? null,
    };
  }

  public warm(locale: string): void {
    if (!this.refreshReady) return;
    const runtime = this.runtime(locale);
    if (!runtime.snapshot && !runtime.active && !runtime.retryTimer)
      this.scheduleQuery(locale);
  }

  public hasSnapshot(locale: string): boolean {
    return Boolean(this.runtimes.get(locale)?.snapshot);
  }

  public async query(
    input: LibraryCollectionsQuery
  ): Promise<LibraryCollectionsResponse> {
    if (!this.refreshReady) {
      const runtime = this.runtime(input.locale);
      const snapshot = runtime.snapshot;
      const filtered = (snapshot?.items ?? []).filter(
        (item) =>
          input.completeness === 'all' ||
          item.completeness === input.completeness
      );
      const sorted = sortCollections(filtered, input.sort, input.sortDirection);
      return {
        pageInfo: {
          pages: Math.ceil(sorted.length / input.take),
          page: Math.floor(input.skip / input.take) + 1,
          results: sorted.length,
          pageSize: input.take,
        },
        results: sorted.slice(input.skip, input.skip + input.take),
        status: snapshot ? 'partial' : 'pending',
        stale: Boolean(snapshot),
        discoveredCollections: snapshot?.items.length ?? 0,
        failedCollections: runtime.failedCollections,
        refreshedAt: snapshot?.refreshedAt.toISOString() ?? null,
      };
    }
    const ids = await this.dependencies.discoverCollectionIds();
    if (!this.refreshReady) return this.query(input);
    const fingerprint = collectionFingerprint(ids);
    const runtime = this.runtime(input.locale);
    runtime.desiredFingerprint = fingerprint;
    const now = this.dependencies.now();

    if (ids.length === 0) {
      runtime.snapshot = {
        fingerprint,
        items: [],
        byId: new Map(),
        refreshedAt: now,
        generation: runtime.generation,
      };
      runtime.status = 'complete';
      runtime.failedCollections = 0;
    } else {
      const snapshotExpired =
        runtime.snapshot !== undefined &&
        now.getTime() - runtime.snapshot.refreshedAt.getTime() >=
          this.dependencies.snapshotTtlMs;
      const unavailableRetryDue =
        runtime.status === 'complete' ||
        runtime.lastAttemptAt === undefined ||
        runtime.lastAttemptGeneration !== runtime.generation ||
        runtime.lastAttemptFingerprint !== fingerprint ||
        now.getTime() - runtime.lastAttemptAt.getTime() >=
          (runtime.retryDelayMs ?? this.dependencies.unavailableRetryMs);
      const needsRefresh =
        runtime.snapshot?.fingerprint !== fingerprint ||
        snapshotExpired ||
        runtime.snapshot?.generation !== runtime.generation ||
        runtime.status === 'partial';
      if (needsRefresh && unavailableRetryDue)
        this.startRefresh(input.locale, ids, fingerprint, runtime);
      // A warm snapshot/long collection-404 TTL must not suppress retries of
      // failed Movie observations. Reuse the existing pending-response lifecycle.
      if (
        !runtime.active &&
        ids.some(
          (id) =>
            this.missingCollections.has(id) &&
            (this.recoveryInFlight.has(id) ||
              now.getTime() >= (this.recoveryStates.peek(id)?.retryAt ?? 0))
        )
      ) {
        runtime.active = this.recoverMembership(ids).finally(() => {
          runtime.active = undefined;
        });
      }
    }

    const visibleIds = new Set(ids);
    const availableSnapshot = runtime.snapshot?.items.filter((item) =>
      visibleIds.has(item.id)
    );
    const filtered = (availableSnapshot ?? []).filter(
      (item) =>
        input.completeness === 'all' || item.completeness === input.completeness
    );
    const sorted = sortCollections(filtered, input.sort, input.sortDirection);
    const results = sorted.slice(input.skip, input.skip + input.take);

    return {
      pageInfo: {
        pages: Math.ceil(sorted.length / input.take),
        page: Math.floor(input.skip / input.take) + 1,
        results: sorted.length,
        pageSize: input.take,
      },
      results,
      status: ids.length > 0 && runtime.active ? 'pending' : runtime.status,
      stale:
        Boolean(runtime.snapshot) &&
        (runtime.active !== undefined || runtime.status === 'partial'),
      discoveredCollections: ids.length,
      failedCollections: runtime.failedCollections,
      refreshedAt: runtime.snapshot?.refreshedAt.toISOString() ?? null,
    };
  }
}

const libraryCollections = new LibraryCollectionsService({}, false);

export default libraryCollections;
