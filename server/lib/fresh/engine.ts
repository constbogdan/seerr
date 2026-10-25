import Autobrr, {
  type FreshRelease,
  type FreshReleasePage,
} from '@server/api/autobrr';
import TheMovieDb from '@server/api/themoviedb';
import dataSource from '@server/datasource';
import FreshDiscovery from '@server/entity/FreshDiscovery';
import FreshSourceState from '@server/entity/FreshSourceState';
import FreshWork from '@server/entity/FreshWork';
import {
  matchFreshIdentity,
  type FreshIdentityProvider,
} from '@server/lib/fresh/matching';
import {
  freshSourceKey,
  normalizeFreshTitle,
} from '@server/lib/fresh/normalize';
import type { FreshRunResult } from '@server/lib/fresh/types';
import type { FreshSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { createHash } from 'crypto';
import type { DataSource, EntityManager } from 'typeorm';

const DAY = 86_400_000;
export { freshSourceKey } from '@server/lib/fresh/normalize';
const retryDelay = (attempt: number) =>
  [1, 5, 30, 120, 720][Math.min(Math.max(attempt - 1, 0), 4)] * 60_000;

export interface FreshEngineDependencies {
  database: DataSource;
  autobrr: (settings: FreshSettings) => Pick<Autobrr, 'page' | 'filter'>;
  tmdb: FreshIdentityProvider;
  now: () => Date;
  pagesPerRun?: number;
  workPerRun?: number;
  budgetMs?: number;
}

/** One bounded pipeline; limits apply per execution, never to total history. */
export class FreshEngine {
  private cancelled = false;
  private deadline = Infinity;
  constructor(
    private readonly dependencies: FreshEngineDependencies = {
      database: dataSource,
      autobrr: (settings) => new Autobrr(settings.baseUrl, settings.apiToken),
      tmdb: new TheMovieDb(),
      now: () => new Date(),
    }
  ) {}

  cancel(): void {
    this.cancelled = true;
  }

  async run(settings: FreshSettings): Promise<FreshRunResult> {
    this.cancelled = false;
    this.deadline = Date.now() + (this.dependencies.budgetMs ?? 120000);
    const result: FreshRunResult = {
      ingested: 0,
      examined: 0,
      resolved: 0,
      skipped: 0,
      retried: 0,
      backfillComplete: false,
      sourceFailed: false,
      cancelled: false,
    };
    if (!settings.enabled) return result;
    const sourceKey = freshSourceKey(settings);
    const repository =
      this.dependencies.database.getRepository(FreshSourceState);
    let state = await repository.findOneBy({ id: 1 });
    if (!state || state.sourceKey !== sourceKey) {
      state = await repository.save(new FreshSourceState({ sourceKey }));
    }
    const now = this.dependencies.now();
    if (!state.nextAttemptAt || state.nextAttemptAt <= now) {
      try {
        const source = this.dependencies.autobrr(settings);
        const filter = await source.filter(settings.filterId);
        if (filter.id !== settings.filterId || filter.enabled === false)
          throw new Error('invalid_filter');
        const filterYears = JSON.stringify(filter.years);
        if (state.filterYears !== filterYears) {
          state.filterYears = filterYears;
          await repository.save(state);
        }
        const wasBackfilled = state.backfillComplete;
        await this.ingest(source, settings, state, result);
        if (
          wasBackfilled &&
          !state.scanCursor &&
          !this.cancelled &&
          Date.now() < this.deadline
        )
          await this.captureLateApprovals(source, settings, state, result);
      } catch {
        result.sourceFailed = true;
        state.attempts += 1;
        state.nextAttemptAt = new Date(
          now.getTime() + retryDelay(state.attempts)
        );
        state.lastError = 'source_unavailable_or_invalid';
        await repository.save(state);
        logger.warn('Fresh source ingestion deferred', {
          label: 'Fresh',
          operation: 'source',
          filterId: settings.filterId,
        });
      }
    }
    if (!this.cancelled) await this.resolve(settings, state, result);
    result.backfillComplete = state.backfillComplete;
    result.cancelled = this.cancelled;
    logger.info('Fresh sync completed', { label: 'Fresh', ...result });
    return result;
  }

  private validatePage(page: FreshReleasePage, cursor: number): void {
    let previous = cursor || Number.MAX_SAFE_INTEGER;
    for (const id of page.releaseIds) {
      if (
        !/^[1-9]\d*$/.test(id) ||
        !Number.isSafeInteger(Number(id)) ||
        Number(id) >= previous
      )
        throw new Error('invalid_source_page');
      previous = Number(id);
    }
    if (
      page.nextCursor !== (page.releaseIds.length ? previous : 0) ||
      page.newestReleaseId !== page.releaseIds[0] ||
      page.releases.some(
        (release) =>
          !page.releaseIds.includes(release.releaseId) ||
          !Number.isFinite(release.observedAt) ||
          release.observedAt > this.dependencies.now().getTime()
      )
    )
      throw new Error('invalid_source_page');
  }

  private async ingest(
    source: Pick<Autobrr, 'page'>,
    settings: FreshSettings,
    state: FreshSourceState,
    result: FreshRunResult
  ): Promise<void> {
    for (
      let batch = 0;
      batch < (this.dependencies.pagesPerRun ?? 10) &&
      !this.cancelled &&
      Date.now() < this.deadline;
      batch++
    ) {
      const cursor = Number(state.scanCursor ?? 0);
      const page = await source.page({ id: settings.filterId }, cursor);
      this.validatePage(page, cursor);
      // Freeze the range head while older pages are captured. New arrivals are
      // picked up after this range commits, including across process restarts.
      const next = new FreshSourceState({ ...state });
      if (!next.scanHead && page.newestReleaseId) {
        next.scanHead = page.newestReleaseId;
        if (
          next.checkpoint &&
          BigInt(next.scanHead) < BigInt(next.checkpoint)
        ) {
          next.recovering = true;
          logger.warn(
            'Fresh source IDs regressed; replaying retained history',
            {
              label: 'Fresh',
              operation: 'source_continuity',
              filterId: settings.filterId,
            }
          );
        }
      }
      const reached =
        !next.recovering &&
        !!next.checkpoint &&
        page.releaseIds.some((id) => BigInt(id) <= BigInt(next.checkpoint!));
      const complete = !page.nextCursor || reached;
      const missingCheckpoint =
        reached && !page.releaseIds.includes(next.checkpoint!);
      if ((complete && next.checkpoint && !reached) || missingCheckpoint) {
        logger.warn(
          'Fresh checkpoint absent; recovered available source range only',
          {
            label: 'Fresh',
            operation: 'source_continuity',
            filterId: settings.filterId,
          }
        );
      }
      next.scanCursor = complete ? null : String(page.nextCursor);
      next.attempts = 0;
      next.nextAttemptAt = null;
      next.lastError = null;
      next.lastIngestedAt = this.dependencies.now();
      if (complete) {
        next.checkpoint = next.scanHead ?? next.checkpoint;
        next.scanHead = null;
        next.backfillComplete = true;
        next.recovering = false;
        if (state.recovering) next.approvalCursor = null;
      }
      // Capture the whole boundary page. This cheap overlap also observes late
      // approvals still present on the head page without repeating TMDB calls.
      let inserted = 0;
      await this.dependencies.database.transaction(async (manager) => {
        for (const release of page.releases) {
          if (
            next.scanHead &&
            BigInt(release.releaseId) > BigInt(next.scanHead)
          )
            continue;
          if (await this.capture(manager, release, settings, state.sourceKey))
            inserted++;
        }
        const unchanged =
          complete &&
          state.backfillComplete &&
          !state.scanCursor &&
          state.checkpoint === next.checkpoint &&
          !state.lastError &&
          state.filterYears === next.filterYears;
        if (!unchanged)
          await manager.getRepository(FreshSourceState).save(next);
      });
      result.ingested += inserted;
      Object.assign(state, next);
      if (complete) break;
    }
  }

  private async captureLateApprovals(
    source: Pick<Autobrr, 'page'>,
    settings: FreshSettings,
    state: FreshSourceState,
    result: FreshRunResult
  ): Promise<void> {
    // autobrr exposes insertion-order cursors, not a proven modified-since feed.
    // Rotate one older page per tick so later approval is not silently lost.
    // Completed work is memoized; unchanged pages cause no TMDB requests.
    const cursor = Number(state.approvalCursor ?? state.checkpoint ?? 0);
    if (!cursor) return;
    const page = await source.page({ id: settings.filterId }, cursor);
    this.validatePage(page, cursor);
    let inserted = 0;
    const next = new FreshSourceState({
      ...state,
      approvalCursor: page.nextCursor ? String(page.nextCursor) : null,
    });
    await this.dependencies.database.transaction(async (manager) => {
      for (const release of page.releases)
        if (await this.capture(manager, release, settings, state.sourceKey))
          inserted++;
      if (state.approvalCursor !== next.approvalCursor)
        await manager.getRepository(FreshSourceState).save(next);
    });
    result.ingested += inserted;
    Object.assign(state, next);
  }

  private async capture(
    manager: EntityManager,
    release: FreshRelease,
    settings: FreshSettings,
    sourceKey: string
  ): Promise<boolean> {
    const season =
      release.mediaType === 'tv' &&
      release.explicitSeason &&
      release.seasonNumber > 0
        ? release.seasonNumber
        : -1;
    const groupKey = createHash('sha256')
      .update(
        JSON.stringify([
          release.mediaType,
          normalizeFreshTitle(release.title),
          release.year,
          season,
          release.tmdbId ?? null,
          release.tvdbId ?? null,
          release.imdbId ?? null,
        ])
      )
      .digest('hex');
    const repository = manager.getRepository(FreshWork);
    const existing = await repository.findOneBy({ sourceKey, groupKey });
    const observedAt = new Date(release.observedAt);
    if (existing) {
      if (observedAt < existing.firstObservedAt) {
        existing.firstObservedAt = observedAt;
        await repository.save(existing);
        if (existing.outcome === 'resolved')
          await this.discover(manager, existing, settings);
      }
      return false;
    }
    await repository.save(
      new FreshWork({
        sourceKey,
        groupKey,
        mediaType: release.mediaType,
        title: release.title,
        sourceTitle: release.sourceTitle,
        year: release.year,
        season,
        firstObservedAt: observedAt,
        externalTmdbId: release.tmdbId ?? null,
        externalTvdbId: release.tvdbId ?? null,
        externalImdbId: release.imdbId ?? null,
      })
    );
    return true;
  }

  private async discover(
    manager: EntityManager,
    work: FreshWork,
    settings: FreshSettings
  ): Promise<void> {
    if (!work.tmdbId || !work.canonicalTitle)
      throw new Error('invalid_identity');
    const eventKeys =
      work.mediaType === 'movie'
        ? ['movie']
        : ['series', ...(work.season > 0 ? [`season:${work.season}`] : [])];
    const repository = manager.getRepository(FreshDiscovery);
    for (const eventKey of eventKeys) {
      const identity = {
        sourceKey: work.sourceKey,
        mediaType: work.mediaType,
        tmdbId: work.tmdbId,
        eventKey,
      };
      const existing = await repository.findOneBy(identity);
      // During descending backfill, earlier evidence may arrive later. Move
      // clocks earlier only, never to ingestion/retry/repack time.
      if (!existing || work.firstObservedAt < existing.discoveredAt) {
        await repository.save(
          new FreshDiscovery({
            ...existing,
            ...identity,
            discoveredAt: work.firstObservedAt,
            visibleUntil: new Date(
              work.firstObservedAt.getTime() +
                settings.freshVisibilityDays * DAY
            ),
            title: work.canonicalTitle,
          })
        );
      }
    }
  }

  private async resolve(
    settings: FreshSettings,
    state: FreshSourceState,
    result: FreshRunResult
  ): Promise<void> {
    const repository = this.dependencies.database.getRepository(FreshWork);
    const due = await repository
      .createQueryBuilder('work')
      .where('work.sourceKey = :sourceKey', { sourceKey: state.sourceKey })
      .andWhere('work.outcome IN (:...outcomes)', {
        outcomes: ['pending', 'retry'],
      })
      .andWhere('(work.nextAttemptAt IS NULL OR work.nextAttemptAt <= :now)', {
        now: this.dependencies.now(),
      })
      .orderBy('work.firstObservedAt', 'ASC')
      .addOrderBy('work.id', 'ASC')
      .take(this.dependencies.workPerRun ?? 100)
      .getMany();
    const years: number[] = JSON.parse(state.filterYears);
    let warnings = 0;
    for (const work of due) {
      if (this.cancelled || Date.now() >= this.deadline) break;
      result.examined++;
      work.attempts++;
      let match;
      try {
        match = await matchFreshIdentity(
          work,
          years,
          this.dependencies.tmdb,
          () => !this.cancelled && Date.now() < this.deadline
        );
      } catch {
        work.outcome = 'retry';
        work.lastError = 'metadata_unavailable_or_invalid';
        work.nextAttemptAt = new Date(
          this.dependencies.now().getTime() + retryDelay(work.attempts)
        );
        await repository.save(work);
        result.retried++;
        if (warnings++ < 3)
          logger.warn('Fresh identity resolution deferred', {
            label: 'Fresh',
            operation: 'identity',
            workId: work.id,
            mediaType: work.mediaType,
          });
        continue;
      }
      work.outcome = match.kind;
      work.lastError = match.kind === 'incomplete' ? 'search_truncated' : null;
      work.nextAttemptAt = null;
      if (match.kind === 'resolved') {
        work.tmdbId = match.id;
        work.canonicalTitle = match.title;
        await this.dependencies.database.transaction(async (manager) => {
          await this.discover(manager, work, settings);
          await manager.getRepository(FreshWork).save(work);
        });
        result.resolved++;
      } else {
        await repository.save(work);
        result.skipped++;
      }
    }
  }
}
