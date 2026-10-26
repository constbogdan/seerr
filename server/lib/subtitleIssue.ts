import { IssueStatus, IssueType } from '@server/constants/issue';
import { MediaType } from '@server/constants/media';
import dataSource from '@server/datasource';
import Issue from '@server/entity/Issue';
import Media from '@server/entity/Media';
import type { User } from '@server/entity/User';
import backgroundDatabaseWriteCoordinator from '@server/lib/backgroundDatabaseWriteCoordinator';
import { createIssue } from '@server/lib/createIssue';
import { normalizeJellyfinGuid } from '@server/utils/jellyfin';
import type { DataSource, EntityManager } from 'typeorm';

export class SubtitleReportError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface SubtitleItem {
  Id?: string;
  Type?: string;
  Name?: string;
  ProductionYear?: number;
  ProviderIds?: { Tmdb?: string; TheMovieDb?: string };
  SeriesId?: string;
  IndexNumber?: number;
  IndexNumberEnd?: number | null;
  ParentIndexNumber?: number;
}

export async function resolveSubtitleItem(
  itemId: string,
  getItem: (id: string) => Promise<SubtitleItem>
) {
  const read = async (id: string) => {
    const item = await getItem(id);
    if (normalizeJellyfinGuid(item.Id) !== id) {
      throw new SubtitleReportError(
        422,
        'Jellyfin item identity is unresolved.'
      );
    }
    return item;
  };
  let item = await read(itemId);
  let season = 0;
  let episode = 0;
  const valid = (n: unknown, minimum: number): n is number =>
    typeof n === 'number' &&
    Number.isSafeInteger(n) &&
    n >= minimum &&
    n <= 2147483647;
  if (item.Type === 'Season') {
    const parent = normalizeJellyfinGuid(item.SeriesId);
    // 0/0 already means Series-wide: never reinterpret a Specials Season as it.
    if (!parent || !valid(item.IndexNumber, 1)) {
      throw new SubtitleReportError(
        422,
        'Regular Season coordinates are missing or invalid.'
      );
    }
    season = item.IndexNumber;
    item = await read(parent);
    if (item.Type !== 'Series') {
      throw new SubtitleReportError(422, 'Season parent Series is unresolved.');
    }
  }
  if (item.Type === 'Episode') {
    const parent = normalizeJellyfinGuid(item.SeriesId);
    if (
      !parent ||
      !valid(item.ParentIndexNumber, 0) ||
      !valid(item.IndexNumber, 1) ||
      (item.IndexNumberEnd != null && item.IndexNumberEnd !== item.IndexNumber)
    ) {
      throw new SubtitleReportError(
        422,
        'Episode coordinates are missing, invalid or ambiguous.'
      );
    }
    season = item.ParentIndexNumber;
    episode = item.IndexNumber;
    item = await read(parent);
    if (item.Type !== 'Series') {
      throw new SubtitleReportError(
        422,
        'Episode parent Series is unresolved.'
      );
    }
  }
  if (item.Type !== 'Movie' && item.Type !== 'Series') {
    throw new SubtitleReportError(
      422,
      'Only Movies, Series, regular Seasons and individual Episodes are supported.'
    );
  }
  const ids = [item.ProviderIds?.Tmdb, item.ProviderIds?.TheMovieDb].filter(
    (id): id is string => id !== undefined
  );
  if (
    !ids.length ||
    ids.some(
      (id) =>
        !/^[1-9]\d*$/.test(id) ||
        !Number.isSafeInteger(Number(id)) ||
        Number(id) > 2147483647
    ) ||
    new Set(ids.map(Number)).size !== 1 ||
    typeof item.Name !== 'string' ||
    !item.Name.trim()
  ) {
    throw new SubtitleReportError(
      422,
      'Authoritative media identity is unresolved.'
    );
  }
  const mediaType = item.Type === 'Movie' ? MediaType.MOVIE : MediaType.TV;
  const year =
    Number.isInteger(item.ProductionYear) && (item.ProductionYear ?? 0) > 0
      ? ` (${item.ProductionYear})`
      : '';
  const scope =
    episode > 0
      ? ` – S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`
      : season > 0
        ? ` – Season ${season} (all Episodes)`
        : mediaType === MediaType.MOVIE
          ? year
          : ' – Series-wide';
  return {
    mediaType,
    tmdbId: Number(ids[0]),
    season,
    episode,
    description: `${item.Name.replace(/\p{Cc}/gu, ' ').slice(0, 500)}${scope}`,
  };
}

export type SubtitleTarget = Awaited<ReturnType<typeof resolveSubtitleItem>>;

export async function reportSubtitleIssue(
  target: SubtitleTarget,
  user: User,
  itemId: string,
  applicationUrl: string,
  db: DataSource = dataSource
): Promise<{ status: 'created' | 'already-reported' }> {
  const media = await db.manager.findOne(Media, {
    where: { mediaType: target.mediaType, tmdbId: target.tmdbId },
    loadEagerRelations: false,
  });
  if (!media)
    throw new SubtitleReportError(404, 'Media is not known to Seerr.');
  // Jellyfin identity verification is complete before acquiring the write lock.
  // Normal issue/comment subscribers retain their existing notification path.
  const transaction = async (manager: EntityManager) => {
    // PostgreSQL locks the stable parent, even when no issue exists yet.
    // SQLite must acquire its write reservation BEFORE reading issues. A
    // competing connection either waits or fails busy; it cannot insert a duplicate.
    if (db.options.type === 'postgres') {
      await manager.query("SET LOCAL lock_timeout = '2s'");
      await manager.query(
        'SELECT "id" FROM "media" WHERE "id" = $1 FOR UPDATE',
        [media.id]
      );
    } else {
      // No-op write, deliberately raw SQL so updatedAt/subscribers are untouched.
      await manager.query('UPDATE "media" SET "id" = "id" WHERE "id" = ?', [
        media.id,
      ]);
    }
    const existing = await manager.findOne(Issue, {
      where: {
        media: { id: media.id },
        issueType: IssueType.SUBTITLES,
        status: IssueStatus.OPEN,
        problemSeason: target.season,
        problemEpisode: target.episode,
      },
      loadEagerRelations: false,
    });
    if (existing) return { status: 'already-reported' as const };
    await createIssue(manager, {
      media,
      createdBy: user,
      issueType: IssueType.SUBTITLES,
      problemSeason: target.season,
      problemEpisode: target.episode,
      message: `Subtitle issue reported for: ${target.description} – ${applicationUrl.replace(/\/$/, '')}/${target.mediaType === MediaType.MOVIE ? 'movie' : 'tv'}/${target.tmdbId}\nJellyfin item ID: ${itemId}`,
    });
    // Do not disclose another reporter's issue, comments or identity.
    return { status: 'created' as const };
  };
  const work = () =>
    db.options.type === 'postgres'
      ? db.transaction('READ COMMITTED', transaction)
      : db.transaction(transaction);
  return db.options.type === 'postgres'
    ? work()
    : backgroundDatabaseWriteCoordinator.runExclusive(work);
}
