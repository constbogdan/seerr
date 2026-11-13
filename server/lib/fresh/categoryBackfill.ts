import type TheMovieDb from '@server/api/themoviedb';
import FreshDiscovery from '@server/entity/FreshDiscovery';
import type { FreshClassification } from '@server/lib/fresh/categories';
import { classifyFreshGenres } from '@server/lib/fresh/categories';
import type { DataSource } from 'typeorm';

/** One explicit maintenance batch. No scheduler, source ingestion or schema writes. */
const selectFreshCategoryBatch = async ({
  database,
  afterId = 0,
  limit = 20,
  budgetMs = 120_000,
}: {
  database: DataSource;
  afterId?: number;
  limit?: number;
  budgetMs?: number;
}) => {
  if (
    !Number.isSafeInteger(afterId) ||
    afterId < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(budgetMs) ||
    budgetMs < 1 ||
    budgetMs > 120_000
  )
    throw new Error('Invalid Fresh backfill bounds');
  const repository = database.getRepository(FreshDiscovery);
  const unknown = () =>
    repository
      .createQueryBuilder('anchor')
      .where(
        `((anchor.mediaType = 'movie' AND anchor.eventKey = 'movie') OR
          (anchor.mediaType = 'tv' AND anchor.eventKey = 'series'))`
      )
      .andWhere('(anchor.isAnimation IS NULL OR anchor.isDocumentary IS NULL)');
  const rows = await unknown()
    .andWhere('anchor.id > :afterId', { afterId })
    .orderBy('anchor.id', 'ASC')
    .take(limit)
    .getMany();
  return { unknown, rows, afterId, limit, budgetMs };
};

export const previewFreshCategories = async (
  options: Parameters<typeof selectFreshCategoryBatch>[0]
) => {
  const { unknown, rows, afterId, limit, budgetMs } =
    await selectFreshCategoryBatch(options);
  const nextAfterId = rows.at(-1)?.id ?? afterId;
  return {
    dryRun: true,
    afterId,
    limit,
    maxLimit: 100,
    budgetMs,
    remainingUnknown: await unknown().getCount(),
    unknownMovies: await unknown()
      .andWhere('anchor.mediaType = :type', { type: 'movie' })
      .getCount(),
    unknownTv: await unknown()
      .andWhere('anchor.mediaType = :type', { type: 'tv' })
      .getCount(),
    eligibleRecords: rows.length,
    selectedAnchorIds: rows.map((row) => row.id),
    nextAfterId,
    hasMore:
      (await unknown()
        .andWhere('anchor.id > :cursor', { cursor: nextAfterId })
        .getCount()) > 0,
  };
};

export const backfillFreshCategories = async ({
  provider,
  now = Date.now,
  ...options
}: Parameters<typeof selectFreshCategoryBatch>[0] & {
  provider: Pick<TheMovieDb, 'getMovie' | 'getTvShow'>;
  now?: () => number;
}) => {
  const { unknown, rows, afterId, budgetMs } =
    await selectFreshCategoryBatch(options);
  const repository = options.database.getRepository(FreshDiscovery);
  const started = now();
  let cursor = afterId;
  let inspected = 0;
  let updated = 0;
  let failures = 0;
  let unavailableGenres = 0;
  // Multiple source anchors can identify the same title. Resolve it once/batch.
  const observations = new Map<string, FreshClassification | null>();
  for (const row of rows) {
    if (now() - started >= budgetMs) break;
    cursor = row.id;
    inspected++;
    const key = `${row.mediaType}:${row.tmdbId}`;
    if (!observations.has(key)) {
      try {
        const details =
          row.mediaType === 'movie'
            ? await provider.getMovie({ movieId: row.tmdbId })
            : await provider.getTvShow({ tvId: row.tmdbId });
        const title = 'title' in details ? details.title : details.name;
        if (
          details.id !== row.tmdbId ||
          (row.mediaType === 'movie'
            ? !('title' in details)
            : !('name' in details)) ||
          typeof title !== 'string' ||
          !title.trim() ||
          title.length > 300
        )
          throw new Error('Invalid Fresh backfill identity');
        observations.set(key, classifyFreshGenres(details.genres));
      } catch {
        observations.set(key, null);
      }
    }
    const flags = observations.get(key);
    if (!flags) {
      failures++;
      continue;
    }
    if (flags.isAnimation === null || flags.isDocumentary === null) {
      unavailableGenres++;
      continue;
    }
    // A concurrent successful match may already have filled this anchor. Never
    // overwrite that observation with a maintenance response that started earlier.
    const result = await repository
      .createQueryBuilder()
      .update()
      .set(flags)
      .where('id = :id', { id: row.id })
      .andWhere('("isAnimation" IS NULL OR "isDocumentary" IS NULL)')
      .execute();
    updated += result.affected ?? 0;
  }
  return {
    inspected,
    updated,
    failures,
    unavailableGenres,
    nextAfterId: cursor,
    hasMore:
      (await unknown().andWhere('anchor.id > :cursor', { cursor }).getCount()) >
      0,
    remainingUnknown: await unknown().getCount(),
  };
};
