import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import {
  MAX_WATCHLIST_ROULETTE_ITEMS_PER_RUN,
  MIN_WATCHLIST_ROULETTE_ITEMS_PER_RUN,
  type WatchlistRouletteRunSummary,
} from '@server/constants/watchlistRoulette';
import { getRepository } from '@server/datasource';
import { MediaRequest } from '@server/entity/MediaRequest';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import type {
  WatchlistRouletteLastRun,
  WatchlistRouletteSelection,
  WatchlistRouletteSettingsResponse,
  WatchlistRouletteSettingsUpdate,
} from '@server/interfaces/api/watchlistRouletteInterfaces';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import { validateWatchlistRouletteRequestOwner } from '@server/lib/watchlistRoulette';
import { Router } from 'express';
import { In } from 'typeorm';
import { z } from 'zod';

export const watchlistRouletteSettingsSchema = z
  .object({
    requestOwnerUserId: z.number().int().positive().nullable(),
    movieItemsPerRun: z
      .number()
      .int()
      .min(MIN_WATCHLIST_ROULETTE_ITEMS_PER_RUN)
      .max(MAX_WATCHLIST_ROULETTE_ITEMS_PER_RUN),
    seriesItemsPerRun: z
      .number()
      .int()
      .min(MIN_WATCHLIST_ROULETTE_ITEMS_PER_RUN)
      .max(MAX_WATCHLIST_ROULETTE_ITEMS_PER_RUN),
  })
  .strict();

export const safeWatchlistRouletteExternalUrl = (
  value?: string | null
): string | null => {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
};

const releaseYear = (value?: string | null): number | null => {
  if (!value) return null;
  const year = Number(value.slice(0, 4));
  return Number.isSafeInteger(year) && year > 0 ? year : null;
};

const resolveSelection = async (
  requestId: number,
  requestById: Map<number, MediaRequest>,
  tmdb: TheMovieDb
): Promise<WatchlistRouletteSelection> => {
  const request = requestById.get(requestId);
  if (!request?.media) {
    return {
      requestId,
      mediaType: null,
      tmdbId: null,
      title: null,
      year: null,
      seerrUrl: null,
      servarrUrl: null,
      unavailable: true,
    };
  }

  const mediaType = request.media.mediaType;
  const tmdbId = request.media.tmdbId;
  let title: string | null = null;
  let year: number | null = null;
  let unavailable = false;
  try {
    if (mediaType === MediaType.MOVIE) {
      const movie = await tmdb.getMovie({ movieId: tmdbId });
      title = movie.title;
      year = releaseYear(movie.release_date);
    } else {
      const series = await tmdb.getTvShow({ tvId: tmdbId });
      title = series.name;
      year = releaseYear(series.first_air_date);
    }
  } catch {
    unavailable = true;
    const watchlist = await getRepository(Watchlist).findOne({
      where: { mediaType, tmdbId },
      order: { id: 'ASC' },
    });
    title = watchlist?.title || null;
  }

  return {
    requestId,
    mediaType,
    tmdbId,
    title,
    year,
    seerrUrl: `/${mediaType}/${tmdbId}`,
    servarrUrl: safeWatchlistRouletteExternalUrl(request.media.serviceUrl),
    unavailable,
  };
};

const resolveLastRun = async (
  summary?: WatchlistRouletteRunSummary
): Promise<WatchlistRouletteLastRun | null> => {
  if (!summary) return null;
  const requestIds = [...new Set(summary.requestIds)];
  const requests = requestIds.length
    ? await getRepository(MediaRequest).find({
        where: { id: In(requestIds) },
      })
    : [];
  const requestById = new Map(requests.map((request) => [request.id, request]));
  const tmdb = new TheMovieDb();
  return {
    summary,
    selections: await Promise.all(
      summary.requestIds.map((requestId) =>
        resolveSelection(requestId, requestById, tmdb)
      )
    ),
  };
};

const response = async (): Promise<WatchlistRouletteSettingsResponse> => {
  const settings = getSettings();
  const users = await getRepository(User).find({ order: { id: 'ASC' } });
  const [lastMovieRun, lastSeriesRun] = await Promise.all([
    resolveLastRun(settings.watchlistRoulette.lastMovieRun),
    resolveLastRun(settings.watchlistRoulette.lastSeriesRun),
  ]);
  return {
    settings: settings.watchlistRoulette,
    administrators: users
      .filter((user) => user.hasPermission(Permission.ADMIN))
      .map((user) => ({ id: user.id, displayName: user.displayName }))
      .sort((left, right) => left.displayName.localeCompare(right.displayName)),
    lastMovieRun,
    lastSeriesRun,
  };
};

const watchlistRouletteRoutes = Router();

watchlistRouletteRoutes.get('/', async (_req, res, next) => {
  try {
    return res.status(200).json(await response());
  } catch (error) {
    return next(error);
  }
});

watchlistRouletteRoutes.post('/', async (req, res, next) => {
  const parsed = watchlistRouletteSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    return next({
      status: 400,
      message: 'Invalid Watchlist Roulette settings.',
    });
  }
  try {
    const update: WatchlistRouletteSettingsUpdate = parsed.data;
    const settings = getSettings();
    const jobsEnabled =
      settings.jobs['watchlist-roulette-movies'].enabled === true ||
      settings.jobs['watchlist-roulette-series'].enabled === true;
    const requestOwner = update.requestOwnerUserId
      ? await validateWatchlistRouletteRequestOwner(update.requestOwnerUserId)
      : null;
    if (update.requestOwnerUserId !== null && !requestOwner) {
      return next({
        status: 400,
        message:
          'The selected Watchlist Roulette request owner is not a current administrator.',
      });
    }
    if (jobsEnabled && !requestOwner) {
      return next({
        status: 400,
        message:
          'A current administrator is required while a Watchlist Roulette job is enabled.',
      });
    }

    const previous = settings.watchlistRoulette;
    settings.watchlistRoulette = { ...previous, ...update };
    try {
      await settings.save();
    } catch (error) {
      settings.watchlistRoulette = previous;
      throw error;
    }
    return res.status(200).json(settings.watchlistRoulette);
  } catch (error) {
    return next(error);
  }
});

export default watchlistRouletteRoutes;
