import TheMovieDb from '@server/api/themoviedb';
import type { TmdbCollection } from '@server/api/themoviedb/interfaces';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { CanonicalMedia } from '@server/entity/CanonicalMedia';
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
import { currentLibraryPresenceSql } from '@server/lib/libraryActivity';
import logger from '@server/logger';
import { In } from 'typeorm';

const COLLECTION_SNAPSHOT_TTL_MS = 15 * 60 * 1000;
const UNAVAILABLE_RETRY_MS = 30 * 1000;
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
  refreshedAt: Date;
}

interface CollectionRuntime {
  snapshot?: CollectionSnapshot;
  active?: Promise<void>;
  desiredFingerprint?: string;
  status: LibraryCollectionHydrationState;
  failedCollections: number;
  lastAttemptAt?: Date;
}

interface CollectionMetadataResult {
  id: number;
  collection?: TmdbCollection;
  failed: boolean;
}

export interface LibraryCollectionsDependencies {
  discoverCollectionIds: () => Promise<number[]>;
  fetchCollection: (id: number, locale: string) => Promise<TmdbCollection>;
  fetchAvailability: (tmdbIds: number[]) => Promise<Map<number, boolean>>;
  now: () => Date;
  snapshotTtlMs: number;
  unavailableRetryMs: number;
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

const defaultDependencies = (): LibraryCollectionsDependencies => {
  const tmdb = new TheMovieDb();
  return {
    discoverCollectionIds: discoverCurrentCollectionIds,
    fetchCollection: (id, locale) =>
      tmdb.getCollection({ collectionId: id, language: locale }),
    fetchAvailability: fetchStrictAvailability,
    now: () => new Date(),
    snapshotTtlMs: COLLECTION_SNAPSHOT_TTL_MS,
    unavailableRetryMs: UNAVAILABLE_RETRY_MS,
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

const collectionItem = (
  collection: TmdbCollection,
  availability: Map<number, boolean>
): LibraryCollectionItem => {
  const memberIds = [
    ...new Set(
      collection.parts
        .map((part) => Number(part.id))
        .filter((id) => Number.isSafeInteger(id) && id > 0)
    ),
  ];
  if (memberIds.length === 0) {
    return {
      id: collection.id,
      name: collection.name,
      overview: collection.overview ?? null,
      posterPath: collection.poster_path ?? null,
      backdropPath: collection.backdrop_path ?? null,
      availableMovies: null,
      totalMovies: null,
      completeness: 'unknown',
    };
  }
  const posterPath =
    collection.poster_path ??
    collection.parts.find(
      (part) => availability.get(Number(part.id)) && part.poster_path
    )?.poster_path ??
    collection.parts.find((part) => part.poster_path)?.poster_path ??
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

  constructor(dependencies: Partial<LibraryCollectionsDependencies> = {}) {
    this.dependencies = { ...defaultDependencies(), ...dependencies };
  }

  private runtime(locale: string): CollectionRuntime {
    const existing = this.runtimes.get(locale);
    if (existing) return existing;
    const created: CollectionRuntime = {
      status: 'pending',
      failedCollections: 0,
    };
    this.runtimes.set(locale, created);
    return created;
  }

  private async refresh(
    locale: string,
    ids: number[],
    fingerprint: string,
    runtime: CollectionRuntime
  ): Promise<void> {
    const startedAt = this.dependencies.now();
    runtime.lastAttemptAt = startedAt;
    try {
      const metadata = await mapBounded(
        ids,
        this.dependencies.metadataConcurrency,
        async (id): Promise<CollectionMetadataResult> => {
          try {
            return {
              id,
              collection: await this.dependencies.fetchCollection(id, locale),
              failed: false,
            };
          } catch (error) {
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
      const successful = metadata.filter(
        (
          entry
        ): entry is CollectionMetadataResult & { collection: TmdbCollection } =>
          !entry.failed && Boolean(entry.collection)
      );
      const failedIds = new Set(
        metadata.filter((entry) => entry.failed).map((entry) => entry.id)
      );

      if (failedIds.size > 0 && !runtime.snapshot) {
        if (runtime.desiredFingerprint !== fingerprint) return;
        runtime.status = 'unavailable';
        runtime.failedCollections = failedIds.size;
        return;
      }

      const memberIds = successful.flatMap((entry) =>
        entry.collection.parts.map((part) => part.id)
      );
      const availability = await this.dependencies.fetchAvailability(memberIds);
      const refreshedItems = successful.map((entry) =>
        collectionItem(entry.collection, availability)
      );
      const previousById = new Map(
        (runtime.snapshot?.items ?? []).map((item) => [item.id, item])
      );
      const refreshedById = new Map(
        refreshedItems.map((item) => [item.id, item])
      );
      const items = ids.flatMap((id) => {
        const item = refreshedById.get(id) ?? previousById.get(id);
        return item ? [item] : [];
      });
      const refreshedAt = this.dependencies.now();
      if (runtime.desiredFingerprint !== fingerprint) return;
      runtime.snapshot = { fingerprint, items, refreshedAt };
      runtime.failedCollections = failedIds.size;
      runtime.status = failedIds.size > 0 ? 'partial' : 'complete';
      logger.info('Library collection snapshot refreshed', {
        label: 'Library Collections',
        discoveredCollections: ids.length,
        failedCollections: failedIds.size,
        durationMs: refreshedAt.getTime() - startedAt.getTime(),
      });
    } catch (error) {
      if (runtime.desiredFingerprint !== fingerprint) return;
      runtime.status = runtime.snapshot ? 'partial' : 'unavailable';
      runtime.failedCollections = Math.max(
        runtime.failedCollections,
        ids.length
      );
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
    runtime.active = this.refresh(locale, ids, fingerprint, runtime).finally(
      () => {
        runtime.active = undefined;
      }
    );
  }

  public async query(
    input: LibraryCollectionsQuery
  ): Promise<LibraryCollectionsResponse> {
    const ids = await this.dependencies.discoverCollectionIds();
    const fingerprint = collectionFingerprint(ids);
    const runtime = this.runtime(input.locale);
    runtime.desiredFingerprint = fingerprint;
    const now = this.dependencies.now();

    if (ids.length === 0) {
      runtime.snapshot = { fingerprint, items: [], refreshedAt: now };
      runtime.status = 'complete';
      runtime.failedCollections = 0;
    } else {
      const snapshotExpired =
        runtime.snapshot !== undefined &&
        now.getTime() - runtime.snapshot.refreshedAt.getTime() >=
          this.dependencies.snapshotTtlMs;
      const unavailableRetryDue =
        runtime.status !== 'unavailable' ||
        runtime.lastAttemptAt === undefined ||
        now.getTime() - runtime.lastAttemptAt.getTime() >=
          this.dependencies.unavailableRetryMs;
      const needsRefresh =
        runtime.snapshot?.fingerprint !== fingerprint || snapshotExpired;
      if (needsRefresh && unavailableRetryDue)
        this.startRefresh(input.locale, ids, fingerprint, runtime);
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

const libraryCollections = new LibraryCollectionsService();

export default libraryCollections;
