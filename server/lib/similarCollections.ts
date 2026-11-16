import TheMovieDb from '@server/api/themoviedb';
import type {
  TmdbCollection,
  TmdbSearchMovieResponse,
} from '@server/api/themoviedb/interfaces';
import dataSource from '@server/datasource';
import { SimilarCollectionRelation } from '@server/entity/SimilarCollectionRelation';
import { SimilarCollectionSeedProgress } from '@server/entity/SimilarCollectionSeedProgress';
import {
  movieCollectionMembership,
  type MovieCollectionBatch,
  type TypedMovieIdentity,
} from '@server/lib/movieCollectionMembership';
import logger from '@server/logger';
import { randomUUID } from 'node:crypto';
import type { DataSource, EntityManager } from 'typeorm';

export const SIMILAR_MAX_PAGES = 3;
const SIMILAR_MAX_LOOKUPS_PER_PAGE = 4;
const CLAIM_MS = 5 * 60 * 1000;
const MAX_RETRY_MS = 60 * 60 * 1000;

export interface SimilarCollectionsRead {
  relatedCollectionIds: number[];
  completedSeedCount: number;
  incompleteSeedCount: number;
  discoveryActive: boolean;
}

export interface SimilarCollectionsDependencies {
  collection: (id: number) => Promise<TmdbCollection>;
  recommendations: (
    movieId: number,
    page: number
  ) => Promise<TmdbSearchMovieResponse>;
  resolve: (movies: TypedMovieIdentity[]) => Promise<MovieCollectionBatch>;
  now: () => Date;
  randomIndex: (size: number) => number;
  dispatch: (work: () => Promise<void>) => void;
}

const dependencies = (): SimilarCollectionsDependencies => {
  const tmdb = new TheMovieDb();
  return {
    collection: (id) =>
      tmdb.getCollection({ collectionId: id, language: 'en' }),
    recommendations: (movieId, page) =>
      tmdb.getMovieRecommendations({ movieId, page, language: 'en' }),
    resolve: (movies) =>
      movieCollectionMembership.resolve(movies, {
        maxLookups: SIMILAR_MAX_LOOKUPS_PER_PAGE,
        concurrency: 4,
        deadlineMs: 1_000,
      }),
    now: () => new Date(),
    randomIndex: (size) => Math.floor(Math.random() * size),
    dispatch: (work) => {
      void work();
    },
  };
};

const validId = (id: number): boolean => Number.isSafeInteger(id) && id > 0;
const releasedBy = (value: unknown, today: string): boolean => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const date = new Date(`${value}T00:00:00Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value &&
    value <= today
  );
};
export const validSimilarVisitToken = (token: unknown): token is string =>
  typeof token === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token);
const retryDelay = (failures: number): number =>
  Math.min(MAX_RETRY_MS, 60_000 * 2 ** Math.min(failures - 1, 6));

/** Durable, visit-driven discovery. The seed-0 progress row is the origin-wide claim. */
export class SimilarCollectionsService {
  private readonly deps: SimilarCollectionsDependencies;

  constructor(
    private readonly database: DataSource = dataSource,
    overrides: Partial<SimilarCollectionsDependencies> = {}
  ) {
    this.deps = { ...dependencies(), ...overrides };
  }

  public async read(
    originCollectionId: number
  ): Promise<SimilarCollectionsRead> {
    if (!validId(originCollectionId)) throw new Error('Invalid collection ID');
    const [relations, progress] = await Promise.all([
      this.database.getRepository(SimilarCollectionRelation).find({
        where: { originCollectionId },
        order: { discoveredAt: 'ASC', relatedCollectionId: 'ASC' },
      }),
      this.database.getRepository(SimilarCollectionSeedProgress).findBy({
        originCollectionId,
      }),
    ]);
    const now = this.deps.now();
    const claim = progress.find((row) => row.seedMovieId === 0);
    return {
      relatedCollectionIds: [
        ...new Set(relations.map((row) => row.relatedCollectionId)),
      ],
      completedSeedCount: progress.filter(
        (row) => row.seedMovieId > 0 && row.completedAt
      ).length,
      incompleteSeedCount: progress.filter(
        (row) => row.seedMovieId > 0 && !row.completedAt
      ).length,
      discoveryActive: Boolean(
        claim?.claimExpiresAt && claim.claimExpiresAt > now
      ),
    };
  }

  /** Claims before responding; provider work is deliberately not awaited by the route. */
  public async trigger(
    originCollectionId: number,
    visitToken: string
  ): Promise<{ started: boolean }> {
    if (!validId(originCollectionId) || !validSimilarVisitToken(visitToken))
      throw new Error('Invalid discovery trigger');
    const token = randomUUID();
    const now = this.deps.now();
    const claims = this.database.getRepository(SimilarCollectionSeedProgress);
    await claims
      .createQueryBuilder()
      .insert()
      .values({ originCollectionId, seedMovieId: 0 })
      .orIgnore()
      .execute();
    const acquired = await claims
      .createQueryBuilder()
      .update()
      .set({
        claimToken: token,
        lastVisitToken: visitToken,
        claimExpiresAt: new Date(now.getTime() + CLAIM_MS),
      })
      .where('"originCollectionId" = :origin AND "seedMovieId" = 0', {
        origin: originCollectionId,
      })
      .andWhere('( "claimExpiresAt" IS NULL OR "claimExpiresAt" <= :now )', {
        now,
      })
      .andWhere(
        '( "lastVisitToken" IS NULL OR "lastVisitToken" <> :visitToken )',
        {
          visitToken,
        }
      )
      .execute();
    if (acquired.affected !== 1) return { started: false };
    this.deps.dispatch(async () => {
      try {
        await this.run(originCollectionId, token);
      } catch (error: unknown) {
        logger.warn('Similar Collections discovery failed', {
          originCollectionId,
          errorType:
            error instanceof Error ? error.constructor.name : 'Unknown',
        });
      }
    });
    return { started: true };
  }

  private async renewClaim(
    manager: EntityManager,
    origin: number,
    token: string
  ): Promise<boolean> {
    const now = this.deps.now();
    const updated = await manager
      .getRepository(SimilarCollectionSeedProgress)
      .createQueryBuilder()
      .update()
      .set({ claimExpiresAt: new Date(now.getTime() + CLAIM_MS) })
      .where('"originCollectionId" = :origin AND "seedMovieId" = 0', { origin })
      .andWhere('"claimToken" = :token AND "claimExpiresAt" > :now', {
        token,
        now,
      })
      .execute();
    return updated.affected === 1;
  }

  private async release(origin: number, token: string): Promise<void> {
    await this.database
      .getRepository(SimilarCollectionSeedProgress)
      .createQueryBuilder()
      .update()
      .set({ claimToken: null, claimExpiresAt: null })
      .where('"originCollectionId" = :origin AND "seedMovieId" = 0', { origin })
      .andWhere('"claimToken" = :token', { token })
      .execute();
  }

  private eligibleSeeds(collection: TmdbCollection): number[] {
    const today = this.deps.now().toISOString().slice(0, 10);
    return [
      ...new Set(
        collection.parts
          .filter(
            (part) => validId(part.id) && releasedBy(part.release_date, today)
          )
          .map((part) => part.id)
      ),
    ];
  }

  private async chooseSeed(
    manager: EntityManager,
    origin: number,
    eligible: number[]
  ): Promise<SimilarCollectionSeedProgress | null> {
    if (eligible.length === 0) return null;
    const existing = await manager
      .getRepository(SimilarCollectionSeedProgress)
      .findBy({ originCollectionId: origin });
    const byId = new Map(existing.map((row) => [row.seedMovieId, row]));
    const now = this.deps.now();
    const resumable = existing
      .filter(
        (row) =>
          row.seedMovieId > 0 &&
          eligible.includes(row.seedMovieId) &&
          !row.completedAt &&
          (!row.retryAfter || row.retryAfter <= now)
      )
      .sort((a, b) => a.nextPage - b.nextPage || a.seedMovieId - b.seedMovieId);
    if (resumable.length > 0) return resumable[0];
    const unused = eligible.filter((id) => !byId.has(id));
    if (unused.length === 0) return null;
    const index = this.deps.randomIndex(unused.length);
    if (!Number.isInteger(index) || index < 0 || index >= unused.length)
      throw new Error('Invalid seed selection');
    const seedMovieId = unused[index];
    await manager
      .getRepository(SimilarCollectionSeedProgress)
      .createQueryBuilder()
      .insert()
      .values({ originCollectionId: origin, seedMovieId })
      .orIgnore()
      .execute();
    return manager
      .getRepository(SimilarCollectionSeedProgress)
      .findOneByOrFail({
        originCollectionId: origin,
        seedMovieId,
      });
  }

  /** Each page's confirmed links and cursor update share one claim-guarded transaction. */
  private async commitPage(
    origin: number,
    token: string,
    seed: SimilarCollectionSeedProgress,
    page: number,
    reportedTotalPages: number | null,
    relatedIds: number[],
    completePage: boolean
  ): Promise<SimilarCollectionSeedProgress | null> {
    return this.database.transaction(async (manager) => {
      if (!(await this.renewClaim(manager, origin, token))) return null;
      const now = this.deps.now();
      const ids = [...new Set(relatedIds)].filter(
        (id) => validId(id) && id !== origin
      );
      if (ids.length > 0) {
        await manager
          .getRepository(SimilarCollectionRelation)
          .createQueryBuilder()
          .insert()
          .values(
            ids.map((relatedCollectionId) => ({
              originCollectionId: origin,
              seedMovieId: seed.seedMovieId,
              relatedCollectionId,
              discoveredAt: now,
            }))
          )
          .orIgnore()
          .execute();
      }
      const failures = completePage ? 0 : seed.failureCount + 1;
      const finished =
        completePage &&
        (page >= SIMILAR_MAX_PAGES ||
          (reportedTotalPages !== null && page >= reportedTotalPages));
      const updated = {
        ...seed,
        nextPage: completePage ? page + 1 : page,
        reportedTotalPages: reportedTotalPages ?? seed.reportedTotalPages,
        failureCount: failures,
        lastAttemptAt: now,
        retryAfter: completePage
          ? null
          : new Date(now.getTime() + retryDelay(failures)),
        completedAt: finished ? now : null,
      };
      await manager.getRepository(SimilarCollectionSeedProgress).save(updated);
      return updated;
    });
  }

  private async run(origin: number, token: string): Promise<void> {
    try {
      const collection = await this.deps.collection(origin);
      if (collection.id !== origin || !Array.isArray(collection.parts))
        throw new Error('Collection identity changed');
      let seed = await this.database.transaction(async (manager) => {
        if (!(await this.renewClaim(manager, origin, token))) return null;
        return this.chooseSeed(manager, origin, this.eligibleSeeds(collection));
      });
      if (!seed) return;
      for (let page = seed.nextPage; page <= SIMILAR_MAX_PAGES; page++) {
        let recommendations: TmdbSearchMovieResponse;
        try {
          recommendations = await this.deps.recommendations(
            seed.seedMovieId,
            page
          );
        } catch {
          await this.commitPage(origin, token, seed, page, null, [], false);
          return;
        }
        const total = recommendations.total_pages;
        if (
          recommendations.page !== page ||
          !Number.isSafeInteger(total) ||
          total < 0 ||
          !Array.isArray(recommendations.results)
        ) {
          await this.commitPage(origin, token, seed, page, null, [], false);
          return;
        }
        const ids = recommendations.results.map((movie) => movie.id);
        if (ids.some((id) => !validId(id))) {
          await this.commitPage(origin, token, seed, page, total, [], false);
          return;
        }
        let resolved: MovieCollectionBatch;
        try {
          resolved = await this.deps.resolve(
            ids.map((tmdbId) => ({ mediaType: 'movie', tmdbId }))
          );
        } catch {
          await this.commitPage(origin, token, seed, page, total, [], false);
          return;
        }
        const memberships = ids.map(
          (id) => resolved.results.get(id)?.membership
        );
        const related = memberships.flatMap((membership) =>
          membership?.kind === 'collection' ? [membership.collectionId] : []
        );
        const completePage = memberships.every(
          (membership) =>
            membership?.kind === 'standalone' ||
            (membership?.kind === 'collection' &&
              validId(membership.collectionId))
        );
        const updated = await this.commitPage(
          origin,
          token,
          seed,
          page,
          total,
          related,
          completePage
        );
        if (!updated || !completePage || updated.completedAt) return;
        seed = updated;
      }
    } finally {
      await this.release(origin, token);
    }
  }
}

export const similarCollections = new SimilarCollectionsService();
