import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import Media from '@server/entity/Media';
import {
  similarCollections,
  validSimilarVisitToken,
} from '@server/lib/similarCollections';
import logger from '@server/logger';
import { mapCollection } from '@server/models/Collection';
import { Router } from 'express';

const collectionRoutes = Router();

collectionRoutes.get<{ id: string }>('/:id/similar', async (req, res, next) => {
  const id = Number(req.params.id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return next({
      status: 400,
      message: 'Invalid Similar Collections collection ID.',
    });
  }

  try {
    return res.status(200).json(await similarCollections.read(id));
  } catch {
    return next({
      status: 500,
      message: 'Unable to read Similar Collections state.',
    });
  }
});

collectionRoutes.post<{ id: string }>(
  '/:id/similar',
  async (req, res, next) => {
    const id = Number(req.params.id);
    const visitToken = req.body?.visitToken;
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !validSimilarVisitToken(visitToken)
    ) {
      return next({
        status: 400,
        message: 'Invalid Similar Collections trigger.',
      });
    }
    try {
      return res
        .status(202)
        .json(await similarCollections.trigger(id, visitToken));
    } catch {
      return next({
        status: 500,
        message: 'Unable to start Similar Collections discovery.',
      });
    }
  }
);

collectionRoutes.get<{ id: string }>('/:id', async (req, res, next) => {
  const tmdb = new TheMovieDb();

  try {
    const collection = await tmdb.getCollection({
      collectionId: Number(req.params.id),
      language: (req.query.language as string) ?? req.locale,
    });

    const media = await Media.getRelatedMedia(
      req.user,
      collection.parts.map((part) => ({
        tmdbId: part.id,
        mediaType: MediaType.MOVIE,
      })),
      { includeActiveRequest: true }
    );

    const result = mapCollection(collection, media);
    try {
      result.similarCollections = await similarCollections.read(collection.id);
    } catch {
      // Optional discovery state must not block the established details response.
      logger.warn('Unable to read Similar Collections state', {
        collectionId: collection.id,
      });
    }
    return res.status(200).json(result);
  } catch (e) {
    logger.debug('Something went wrong retrieving collection', {
      label: 'API',
      errorMessage: e.message,
      collectionId: req.params.id,
    });
    return next({
      status: 500,
      message: 'Unable to retrieve collection.',
    });
  }
});

export default collectionRoutes;
