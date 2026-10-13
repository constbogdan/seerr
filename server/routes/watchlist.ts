import {
  DuplicateWatchlistRequestError,
  NotFoundError,
  Watchlist,
} from '@server/entity/Watchlist';
import logger from '@server/logger';
import { Router } from 'express';
import { QueryFailedError } from 'typeorm';
import { ZodError } from 'zod';

import { MediaType } from '@server/constants/media';
import { UserMediaIntentState } from '@server/constants/watchlist';
import { watchlistCreate } from '@server/interfaces/api/watchlistCreate';
import { Permission } from '@server/lib/permissions';
import {
  getWatchlistHistory,
  type WatchlistHistoryResponse,
} from '@server/lib/watchlistLifecycle';

const watchlistRoutes = Router();

watchlistRoutes.get<never, WatchlistHistoryResponse>(
  '/history',
  async (req, res, next) => {
    const requestedUserId = Number(req.query.userId ?? req.user?.id);
    if (!Number.isSafeInteger(requestedUserId) || requestedUserId < 1) {
      return next({ status: 400, message: 'Invalid Watchlist history user.' });
    }
    if (
      requestedUserId !== req.user?.id &&
      !req.user?.hasPermission(Permission.WATCHLIST_VIEW)
    ) {
      return next({
        status: 403,
        message: 'You do not have permission to view this Watchlist history.',
      });
    }
    const requestedPage = Number(req.query.page ?? 1);
    const page =
      Number.isSafeInteger(requestedPage) && requestedPage > 0
        ? requestedPage
        : 1;
    const state = Object.values(UserMediaIntentState).includes(
      req.query.state as UserMediaIntentState
    )
      ? (req.query.state as UserMediaIntentState)
      : undefined;
    return res.json(
      await getWatchlistHistory({ userId: requestedUserId, page, state })
    );
  }
);

watchlistRoutes.post<never, Watchlist, Watchlist>(
  '/',
  async (req, res, next) => {
    try {
      if (!req.user) {
        return next({
          status: 401,
          message: 'You must be logged in to add watchlist.',
        });
      }
      const values = watchlistCreate.parse(req.body);

      const request = await Watchlist.createWatchlist({
        watchlistRequest: values,
        user: req.user,
      });
      return res.status(201).json(request);
    } catch (error) {
      if (!(error instanceof Error)) {
        return;
      }
      if (error instanceof ZodError) {
        return next({ status: 400, message: 'Invalid Watchlist item.' });
      }
      switch (error.constructor) {
        case QueryFailedError:
          logger.warn('Something wrong with data watchlist', {
            tmdbId: req.body.tmdbId,
            mediaType: req.body.mediaType,
            label: 'Watchlist',
          });
          return next({ status: 409, message: 'Something wrong' });
        case DuplicateWatchlistRequestError:
          return next({ status: 409, message: error.message });
        default:
          return next({ status: 500, message: error.message });
      }
    }
  }
);

watchlistRoutes.delete('/:tmdbId', async (req, res, next) => {
  if (!req.user) {
    return next({
      status: 401,
      message: 'You must be logged in to delete watchlist data.',
    });
  }
  try {
    const tmdbId = Number(req.params.tmdbId);
    if (
      !Number.isSafeInteger(tmdbId) ||
      tmdbId <= 0 ||
      !/^\d+$/.test(req.params.tmdbId)
    ) {
      return next({ status: 400, message: 'Invalid TMDB identifier.' });
    }
    const mediaType = req.query.mediaType;
    if (mediaType !== MediaType.MOVIE && mediaType !== MediaType.TV) {
      return next({
        status: 400,
        message: 'Invalid mediaType query parameter.',
      });
    }

    await Watchlist.deleteWatchlist(tmdbId, mediaType, req.user);
    return res.status(204).send();
  } catch (e) {
    if (e instanceof NotFoundError) {
      return next({
        status: 404,
        message: e.message,
      });
    }
    return next({ status: 500, message: e.message });
  }
});

export default watchlistRoutes;
