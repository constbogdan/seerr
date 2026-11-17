import TheMovieDb from '@server/api/themoviedb';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import dataSource from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import { MovieCollectionObservation } from '@server/entity/MovieCollectionObservation';
import {
  parseTmdbCollectionMembership,
  persistCanonicalMovieMembershipObservation,
  type TmdbCollectionMembershipObservation,
} from '@server/lib/libraryCollectionMembership';
import { In, type DataSource } from 'typeorm';

export const MOVIE_COLLECTION_FRESHNESS_MS = 30 * 24 * 60 * 60 * 1000;
const FAILURE_RETRY_MS = 5 * 60 * 1000;
const MAX_RETRY_KEYS = 512;

export type MovieCollectionMembership =
  | { kind: 'collection'; collectionId: number }
  | { kind: 'standalone' }
  | { kind: 'unresolved' };
export type TypedMovieIdentity = { mediaType: 'movie'; tmdbId: number };
export type MovieCollectionResolution = {
  membership: MovieCollectionMembership;
  observedAt: Date | null;
  stale: boolean;
  source: 'canonical' | 'observation' | 'unresolved';
};
export type MovieCollectionBatch = {
  results: Map<number, MovieCollectionResolution>;
  stats: {
    canonicalHits: number;
    observationHits: number;
    tmdbFallbackCalls: number;
    unresolved: number;
  };
};

const unresolved = (): MovieCollectionResolution => ({
  membership: { kind: 'unresolved' },
  observedAt: null,
  stale: false,
  source: 'unresolved',
});
const positiveId = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const validDate = (value: Date | null | undefined): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());
const resolution = (
  collectionId: number | null | undefined,
  observedAt: Date | null | undefined,
  source: MovieCollectionResolution['source'],
  nowMs: number,
  freshnessMs: number
): MovieCollectionResolution => {
  if (
    !validDate(observedAt) ||
    (collectionId !== null && !positiveId(collectionId))
  )
    return unresolved();
  return {
    membership:
      collectionId === null
        ? { kind: 'standalone' }
        : { kind: 'collection', collectionId },
    observedAt,
    stale: nowMs - observedAt.getTime() >= freshnessMs,
    source,
  };
};

/** Catalog observations never create canonical media or imply physical presence. */
export class MovieCollectionMembershipService {
  private readonly inFlight = new Map<number, Promise<void>>();
  private readonly retryAt = new Map<number, number>();

  constructor(
    private readonly database: DataSource = dataSource,
    private readonly provider: () => Pick<TheMovieDb, 'getMovieForScan'> = () =>
      new TheMovieDb(),
    private readonly now: () => Date = () => new Date(),
    private readonly freshnessMs = MOVIE_COLLECTION_FRESHNESS_MS
  ) {}

  private async convergeCanonical(
    tmdbId: number,
    observation: TmdbCollectionMembershipObservation
  ): Promise<void> {
    const identity = await this.database
      .getRepository(CanonicalMediaIdentity)
      .findOneBy({
        provider: 'tmdb',
        sourceScope: '',
        mediaType: LibraryMediaType.MOVIE,
        value: String(tmdbId),
      });
    if (!identity) return;
    await persistCanonicalMovieMembershipObservation(
      this.database.getRepository(CanonicalMedia),
      {
        canonicalMediaId: identity.canonicalMediaId,
        tmdbId,
        collectionMembership: observation,
      }
    );
  }

  /** Returns false for an absent, malformed or identity-mismatched TMDB field. */
  public async observeMovie(
    tmdbId: number,
    movie: { id: number; belongs_to_collection?: unknown },
    observedAt = this.now()
  ): Promise<boolean> {
    if (
      !positiveId(tmdbId) ||
      movie.id !== tmdbId ||
      !validDate(observedAt) ||
      !Object.prototype.hasOwnProperty.call(movie, 'belongs_to_collection')
    )
      return false;
    const membership = parseTmdbCollectionMembership(
      movie.belongs_to_collection,
      observedAt
    );
    if (!membership) return false;

    await this.observeValidated(tmdbId, membership);
    return true;
  }

  public async observeValidated(
    tmdbId: number,
    membership: TmdbCollectionMembershipObservation
  ): Promise<void> {
    if (
      !positiveId(tmdbId) ||
      !validDate(membership.observedAt) ||
      (membership.tmdbCollectionId !== null &&
        !positiveId(membership.tmdbCollectionId))
    )
      throw new Error('Invalid movie collection observation');

    const repository = this.database.getRepository(MovieCollectionObservation);
    const existing = await repository.findOneBy({
      mediaType: LibraryMediaType.MOVIE,
      tmdbId,
    });
    if (
      existing &&
      existing.tmdbCollectionId === membership.tmdbCollectionId &&
      validDate(existing.observedAt) &&
      this.now().getTime() - existing.observedAt.getTime() < this.freshnessMs
    ) {
      await this.convergeCanonical(tmdbId, {
        tmdbCollectionId: existing.tmdbCollectionId,
        observedAt: existing.observedAt,
      });
      return;
    }

    // Both supported databases implement this guarded UPSERT. QueryBuilder
    // supplies driver-specific timestamp binding; the SQL guard is atomic.
    const insert = repository
      .createQueryBuilder()
      .insert()
      .into(MovieCollectionObservation)
      .values({
        mediaType: LibraryMediaType.MOVIE,
        tmdbId,
        tmdbCollectionId: membership.tmdbCollectionId,
        observedAt: membership.observedAt,
      });
    const [sql, parameters] = insert.getQueryAndParameters();
    await repository.query(
      sql +
        ' ON CONFLICT ("mediaType", "tmdbId") DO UPDATE SET ' +
        '"tmdbCollectionId" = excluded."tmdbCollectionId", ' +
        '"observedAt" = excluded."observedAt" WHERE ' +
        '"movie_collection_observation"."observedAt" < excluded."observedAt"',
      parameters
    );
    const winner = await repository.findOneByOrFail({
      mediaType: LibraryMediaType.MOVIE,
      tmdbId,
    });
    await this.convergeCanonical(tmdbId, {
      tmdbCollectionId: winner.tmdbCollectionId,
      observedAt: winner.observedAt,
    });
  }

  private async readKnown(
    ids: number[],
    reconcile: boolean
  ): Promise<Map<number, MovieCollectionResolution>> {
    const nowMs = this.now().getTime();
    const result = new Map(ids.map((id) => [id, unresolved()]));
    if (ids.length === 0) return result;
    const [identities, observations] = await Promise.all([
      this.database.getRepository(CanonicalMediaIdentity).find({
        where: {
          provider: 'tmdb',
          sourceScope: '',
          mediaType: LibraryMediaType.MOVIE,
          value: In(ids.map(String)),
        },
        relations: ['canonicalMedia'],
      }),
      this.database.getRepository(MovieCollectionObservation).findBy({
        mediaType: LibraryMediaType.MOVIE,
        tmdbId: In(ids),
      }),
    ]);
    const canonicalById = new Map(
      identities.map((identity) => [Number(identity.value), identity])
    );
    const observationById = new Map(
      observations.map((observation) => [observation.tmdbId, observation])
    );
    for (const id of ids) {
      const identity = canonicalById.get(id);
      const canonical = identity?.canonicalMedia;
      const observation = observationById.get(id);
      const fromCanonical = resolution(
        canonical?.tmdbCollectionId,
        canonical?.collectionMembershipHydratedAt,
        'canonical',
        nowMs,
        this.freshnessMs
      );
      const fromObservation = resolution(
        observation?.tmdbCollectionId,
        observation?.observedAt,
        'observation',
        nowMs,
        this.freshnessMs
      );
      const observationWins =
        fromObservation.observedAt &&
        (!fromCanonical.observedAt ||
          fromObservation.observedAt > fromCanonical.observedAt);
      result.set(id, observationWins ? fromObservation : fromCanonical);
      if (reconcile && observationWins && identity && observation) {
        await persistCanonicalMovieMembershipObservation(
          this.database.getRepository(CanonicalMedia),
          {
            canonicalMediaId: identity.canonicalMediaId,
            tmdbId: id,
            collectionMembership: {
              tmdbCollectionId: observation.tmdbCollectionId,
              observedAt: observation.observedAt,
            },
          }
        );
      }
    }
    return result;
  }

  private deferRetry(id: number): void {
    if (this.retryAt.size >= MAX_RETRY_KEYS) {
      const oldest = this.retryAt.keys().next().value;
      if (oldest !== undefined) this.retryAt.delete(oldest);
    }
    this.retryAt.set(id, this.now().getTime() + FAILURE_RETRY_MS);
  }

  private loadMovie(id: number): Promise<void> {
    const pending = this.inFlight.get(id);
    if (pending) return pending;
    const work = (async () => {
      try {
        const movie = await this.provider().getMovieForScan({
          movieId: id,
          language: 'en',
        });
        if (!(await this.observeMovie(id, movie))) this.deferRetry(id);
        else this.retryAt.delete(id);
      } catch {
        this.deferRetry(id);
      }
    })();
    this.inFlight.set(id, work);
    void work.finally(() => {
      if (this.inFlight.get(id) === work) this.inFlight.delete(id);
    });
    return work;
  }

  public async resolve(
    identities: TypedMovieIdentity[],
    options: {
      maxLookups?: number;
      concurrency?: number;
      deadlineMs?: number;
      onConfirmed?: (
        tmdbId: number,
        resolution: MovieCollectionResolution
      ) => Promise<void>;
    } = {}
  ): Promise<MovieCollectionBatch> {
    const ids = [
      ...new Set(
        identities.map((identity) => {
          if (identity.mediaType !== 'movie' || !positiveId(identity.tmdbId))
            throw new Error('Invalid typed TMDB movie identity');
          return identity.tmdbId;
        })
      ),
    ];
    const initial = await this.readKnown(ids, true);
    const maxLookups = Math.max(0, Math.min(20, options.maxLookups ?? 0));
    const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 4));
    const deadline =
      this.now().getTime() + Math.max(0, options.deadlineMs ?? 0);
    const pending = ids
      .filter((id) => {
        const current = initial.get(id)!;
        return (
          (current.membership.kind === 'unresolved' || current.stale) &&
          (this.retryAt.get(id) ?? 0) <= this.now().getTime()
        );
      })
      .slice(0, maxLookups);
    const pendingIds = new Set(pending);
    const published = new Set<number>();
    const publish = async (id: number, item: MovieCollectionResolution) => {
      if (item.membership.kind === 'unresolved' || published.has(id)) return;
      await options.onConfirmed?.(id, item);
      published.add(id);
    };
    for (const id of ids)
      if (!pendingIds.has(id)) await publish(id, initial.get(id)!);
    let cursor = 0;
    let tmdbFallbackCalls = 0;
    const workers = await Promise.allSettled(
      Array.from(
        { length: Math.min(concurrency, pending.length) },
        async () => {
          while (cursor < pending.length && this.now().getTime() <= deadline) {
            const id = pending[cursor++];
            if (!this.inFlight.has(id)) tmdbFallbackCalls++;
            // Started work is always awaited; the provider's own timeout bounds it.
            await this.loadMovie(id);
            const current = await this.readKnown([id], false);
            await publish(id, current.get(id)!);
          }
        }
      )
    );
    const failed = workers.find((worker) => worker.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const results = cursor > 0 ? await this.readKnown(ids, true) : initial;
    for (const id of ids) await publish(id, results.get(id)!);
    return {
      results,
      stats: {
        canonicalHits: [...results.values()].filter(
          (item) => item.source === 'canonical'
        ).length,
        observationHits: [...results.values()].filter(
          (item) => item.source === 'observation'
        ).length,
        tmdbFallbackCalls,
        unresolved: [...results.values()].filter(
          (item) => item.membership.kind === 'unresolved'
        ).length,
      },
    };
  }
}

export const movieCollectionMembership = new MovieCollectionMembershipService();
