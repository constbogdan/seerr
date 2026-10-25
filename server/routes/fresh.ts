import type {
  TmdbMovieDetails,
  TmdbMovieResult,
  TmdbTvDetails,
  TmdbTvResult,
} from '@server/api/themoviedb/interfaces';
import { FRESH_PAGE_SIZE } from '@server/constants/fresh';
import dataSource from '@server/datasource';
import FreshDiscovery from '@server/entity/FreshDiscovery';
import Media from '@server/entity/Media';
import { hasFreshContentFilters } from '@server/lib/fresh/contentFilters';
import { freshSourceKey } from '@server/lib/fresh/engine';
import {
  FRESH_FILTER_MAX_ITEMS,
  FreshFilterSnapshots,
  isFreshMetricSort,
  selectFreshSnapshotRows,
} from '@server/lib/fresh/filterSnapshot';
import {
  freshPresentationKey,
  resolveFreshPagePresentation,
} from '@server/lib/fresh/presentation';
import freshService from '@server/lib/fresh/service';
import type { FreshSort } from '@server/lib/fresh/types';
import { getSettings } from '@server/lib/settings';
import { mapMovieResult, mapTvResult } from '@server/models/Search';
import { Router } from 'express';

export const createFreshRoutes = ({
  database = dataSource,
  settings: readSettings = () => getSettings().fresh,
  status: readStatus = () => freshService.status(),
  presentation: present = resolveFreshPagePresentation,
  related: relatedMedia = Media.getRelatedMedia.bind(Media),
} = {}) => {
  const freshRoutes = Router();
  const snapshots = new FreshFilterSnapshots();
  freshRoutes.get('/', async (req, res, next) => {
    try {
      const settings = readSettings();
      const status = await readStatus();
      const page = Math.max(
        1,
        Math.min(1000000, Math.trunc(Number(req.query.page) || 1))
      );
      if (!settings.enabled)
        return res.json({
          page,
          totalPages: 0,
          totalResults: 0,
          results: [],
          status,
        });
      const now = new Date();
      const query = database
        .getRepository(FreshDiscovery)
        .createQueryBuilder('discovery')
        .select('discovery.mediaType', 'mediaType')
        .addSelect('discovery.tmdbId', 'tmdbId')
        .addSelect('MAX(discovery.discoveredAt)', 'discoveredAt')
        .addSelect('MIN(discovery.title)', 'title')
        .where('discovery.sourceKey = :sourceKey', {
          sourceKey: freshSourceKey(settings),
        })
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
      if (req.query.mediaType === 'movie' || req.query.mediaType === 'tv')
        query.andWhere('discovery.mediaType = :mediaType', {
          mediaType: req.query.mediaType,
        });
      const count = await database
        .createQueryBuilder()
        .select('COUNT(*)', 'count')
        .from(`(${query.getQuery()})`, 'feed')
        .setParameters(query.getParameters())
        .getRawOne<{ count: string | number }>();
      let totalResults = Number(count?.count ?? 0);
      const sort: FreshSort =
        req.query.sort === 'oldest' || isFreshMetricSort(req.query.sort)
          ? req.query.sort
          : 'freshest';
      const requiresSnapshot =
        hasFreshContentFilters(settings) || isFreshMetricSort(sort);
      if (requiresSnapshot && totalResults > FRESH_FILTER_MAX_ITEMS)
        throw new Error('fresh_filter_population_limit');
      const population = await query
        .orderBy('"discoveredAt"', sort === 'oldest' ? 'ASC' : 'DESC')
        .addOrderBy('discovery.mediaType', 'ASC')
        .addOrderBy('discovery.tmdbId', 'ASC')
        .offset(requiresSnapshot ? 0 : (page - 1) * FRESH_PAGE_SIZE)
        .limit(requiresSnapshot ? FRESH_FILTER_MAX_ITEMS : FRESH_PAGE_SIZE)
        .getRawMany<{
          mediaType: 'movie' | 'tv';
          tmdbId: number;
          discoveredAt: Date | string;
          title: string;
        }>();
      let rows = population;
      let snapshotPresentation;
      if (requiresSnapshot) {
        if (population.length !== totalResults)
          throw new Error('fresh_filter_population_changed');
        const snapshot = await snapshots.evaluate(
          population,
          settings,
          req.locale ?? 'en',
          present
        );
        const eligible = selectFreshSnapshotRows(population, snapshot, sort);
        totalResults = eligible.length;
        rows = eligible.slice(
          (page - 1) * FRESH_PAGE_SIZE,
          page * FRESH_PAGE_SIZE
        );
        snapshotPresentation = snapshot.presentations;
      }
      const [related, presentations] = await Promise.all([
        relatedMedia(
          req.user,
          rows.map(({ tmdbId, mediaType }) => ({ tmdbId, mediaType })),
          { includeActiveRequest: true }
        ),
        snapshotPresentation ?? present(rows, req.locale ?? 'en'),
      ]);
      const results = rows.map((item) => {
        const media = related.find(
          (value) =>
            value.tmdbId === item.tmdbId && value.mediaType === item.mediaType
        );
        const presentation = presentations.get(freshPresentationKey(item));
        const common = {
          id: item.tmdbId,
          media_type: item.mediaType,
          genre_ids: presentation?.genres?.map((genre) => genre.id) ?? [],
          original_language: '',
          overview: '',
          popularity: 0,
          vote_average: 0,
          vote_count: 0,
          ...presentation,
        };
        const result =
          item.mediaType === 'movie'
            ? mapMovieResult(
                {
                  adult: false,
                  title: item.title,
                  original_title: item.title,
                  release_date: '',
                  video: false,
                  ...common,
                } as TmdbMovieResult & Partial<TmdbMovieDetails>,
                media
              )
            : mapTvResult(
                {
                  name: item.title,
                  original_name: item.title,
                  first_air_date: '',
                  origin_country: [],
                  ...common,
                } as TmdbTvResult & Partial<TmdbTvDetails>,
                media
              );
        const value =
          item.discoveredAt instanceof Date
            ? item.discoveredAt.toISOString()
            : item.discoveredAt.replace(' ', 'T');
        const date = new Date(
          /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? value : value + 'Z'
        );
        return { ...result, freshFirstSeenAt: date.toISOString() };
      });
      return res.json({
        page,
        totalPages: Math.ceil(totalResults / FRESH_PAGE_SIZE),
        totalResults,
        results,
        status,
      });
    } catch {
      return next({ status: 503, message: 'Unable to retrieve Fresh media.' });
    }
  });
  return freshRoutes;
};
export default createFreshRoutes();
