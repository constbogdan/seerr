import Autobrr from '@server/api/autobrr';
import dataSource from '@server/datasource';
import FreshDiscovery from '@server/entity/FreshDiscovery';
import FreshSourceState from '@server/entity/FreshSourceState';
import FreshWork from '@server/entity/FreshWork';
import {
  SynchronizationExecutionBlockedError,
  synchronizationPolicy,
  type SynchronizationPolicy,
} from '@server/job/synchronizationPolicy';
import backgroundDatabaseWriteCoordinator from '@server/lib/backgroundDatabaseWriteCoordinator';
import { normalizeFreshContentFilters } from '@server/lib/fresh/contentFilters';
import { FreshEngine, freshSourceKey } from '@server/lib/fresh/engine';
import type { FreshStatus } from '@server/lib/fresh/types';
import type { FreshSettings } from '@server/lib/settings';
import logger from '@server/logger';
import type { DataSource } from 'typeorm';

export const normalizeFreshSettings = (
  settings: FreshSettings
): FreshSettings => {
  const value = {
    enabled: settings.enabled,
    baseUrl: settings.baseUrl.trim().replace(/\/$/, ''),
    apiToken: settings.apiToken.trim(),
    filterId: settings.filterId,
    cachedFilterName: settings.cachedFilterName.trim(),
    freshVisibilityDays: settings.freshVisibilityDays,
    ...normalizeFreshContentFilters(settings),
  };
  if (value.enabled) new Autobrr(value.baseUrl, value.apiToken);
  if (
    !Number.isInteger(value.filterId) ||
    value.filterId < (value.enabled ? 1 : 0) ||
    !Number.isInteger(value.freshVisibilityDays) ||
    value.freshVisibilityDays < 1 ||
    value.freshVisibilityDays > 90
  )
    throw new Error('Invalid Fresh configuration');
  return value;
};
export const publicFreshSettings = ({
  apiToken,
  ...settings
}: FreshSettings) => ({ ...settings, apiTokenConfigured: !!apiToken });

export class FreshService {
  private settings?: FreshSettings;
  private inFlight?: Promise<void>;
  constructor(
    private readonly engine: Pick<
      FreshEngine,
      'run' | 'cancel'
    > = new FreshEngine(),
    private readonly database: DataSource = dataSource,
    private readonly policy: SynchronizationPolicy = synchronizationPolicy
  ) {}
  configure(settings: FreshSettings): void {
    this.settings = normalizeFreshSettings(settings);
  }
  sync(requireComplete = false): Promise<void> {
    const commissioning =
      this.policy.mode === 'commissioning' &&
      requireComplete &&
      this.policy.status(this.settings?.enabled ?? false).commissioning
        ?.activeJobId === 'fresh-sync';
    if (this.policy.mode !== 'normal' && !commissioning)
      throw new SynchronizationExecutionBlockedError(
        'Fresh synchronization is contained.'
      );
    if (!this.settings?.enabled) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const settings = { ...this.settings };
    this.inFlight = backgroundDatabaseWriteCoordinator
      .runExclusive(async () => {
        const result = await this.engine.run(settings);
        const pending = requireComplete
          ? await this.database
              .getRepository(FreshWork)
              .createQueryBuilder('work')
              .where('work.sourceKey = :sourceKey', {
                sourceKey: freshSourceKey(settings),
              })
              .andWhere('work.outcome IN (:...outcomes)', {
                outcomes: ['pending', 'retry'],
              })
              .getCount()
          : 0;
        if (
          requireComplete &&
          (result.sourceFailed ||
            !result.backfillComplete ||
            result.cancelled ||
            pending > 0)
        )
          throw new Error('Fresh synchronization incomplete');
      })
      .finally(() => {
        this.inFlight = undefined;
      });
    // Native scheduled callbacks intentionally do not await; keep failures observed.
    void this.inFlight.catch(() =>
      logger.warn('Fresh synchronization deferred', {
        label: 'Fresh',
        operation: 'sync',
      })
    );
    return this.inFlight;
  }
  running(): boolean {
    return !!this.inFlight;
  }
  cancel(): void {
    this.engine.cancel();
  }
  startCatchUp(): void {
    if (this.policy.startupCatchUpsAllowed && this.settings?.enabled)
      setImmediate(() => {
        void this.sync();
      });
  }
  async status(): Promise<FreshStatus> {
    const settings = this.settings;
    const empty: FreshStatus = {
      status: 'disabled',
      refreshing: false,
      backfillComplete: false,
      itemCount: 0,
      pendingWork: 0,
    };
    if (!settings?.enabled) return empty;
    const sourceKey = freshSourceKey(settings);
    const state = await this.database
      .getRepository(FreshSourceState)
      .findOneBy({ id: 1, sourceKey });
    const now = new Date();
    const visible = this.database
      .getRepository(FreshDiscovery)
      .createQueryBuilder('discovery')
      .select('discovery.mediaType')
      .addSelect('discovery.tmdbId')
      .where('discovery.sourceKey = :sourceKey', { sourceKey })
      .andWhere(
        'discovery.discoveredAt >= :cutoff AND discovery.discoveredAt <= :now',
        {
          cutoff: new Date(
            now.getTime() - settings.freshVisibilityDays * 86400000
          ),
          now,
        }
      )
      .groupBy('discovery.mediaType')
      .addGroupBy('discovery.tmdbId');
    const [count, pendingWork, retries] = await Promise.all([
      this.database
        .createQueryBuilder()
        .select('COUNT(*)', 'count')
        .from(`(${visible.getQuery()})`, 'feed')
        .setParameters(visible.getParameters())
        .getRawOne<{ count: string | number }>(),
      this.database
        .getRepository(FreshWork)
        .createQueryBuilder('work')
        .where('work.sourceKey = :sourceKey', { sourceKey })
        .andWhere('work.outcome IN (:...outcomes)', {
          outcomes: ['pending', 'retry'],
        })
        .getCount(),
      this.database
        .getRepository(FreshWork)
        .countBy({ sourceKey, outcome: 'retry' }),
    ]);
    const itemCount = Number(count?.count ?? 0);
    const failed = !!state?.lastError || retries > 0;
    return {
      ...empty,
      status: failed
        ? itemCount
          ? 'stale'
          : 'unavailable'
        : !state?.backfillComplete || pendingWork > 0
          ? 'preparing'
          : this.running()
            ? 'refreshing'
            : 'ready',
      refreshing: this.running(),
      backfillComplete: state?.backfillComplete ?? false,
      itemCount,
      pendingWork,
      lastRefresh: state?.lastIngestedAt?.toISOString(),
      checkpoint: state?.checkpoint ?? undefined,
      error: failed
        ? 'Fresh synchronization temporarily unavailable.'
        : undefined,
    };
  }
  filters(settings: FreshSettings) {
    return new Autobrr(settings.baseUrl, settings.apiToken).filters();
  }
  async test(settings: FreshSettings) {
    await this.filters(settings);
  }
}

export default new FreshService();
