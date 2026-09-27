import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import { Watchlist } from '@server/entity/Watchlist';
import logger from '@server/logger';
import { IsNull } from 'typeorm';

const BACKFILL_BATCH_SIZE = 10;

class WatchlistMetadataBackfill {
  private isRunning = false;
  private cancelled = false;

  constructor(
    private readonly tmdbFactory: () => Pick<
      TheMovieDb,
      'getMovie' | 'getTvShow'
    > = () => new TheMovieDb()
  ) {}

  public running(): boolean {
    return this.isRunning;
  }

  public cancel(): void {
    this.cancelled = true;
  }

  public async run(limit = BACKFILL_BATCH_SIZE): Promise<number> {
    if (this.isRunning) {
      return 0;
    }

    this.isRunning = true;
    this.cancelled = false;
    let hydrated = 0;

    try {
      const repository = getRepository(Watchlist);
      const rows = await repository.find({
        where: { genreIds: IsNull() },
        order: { updatedAt: 'ASC', id: 'ASC' },
        take: Math.max(1, Math.min(limit, BACKFILL_BATCH_SIZE)),
      });
      const tmdb = this.tmdbFactory();

      for (const row of rows) {
        if (this.cancelled) {
          break;
        }

        try {
          const details =
            row.mediaType === MediaType.MOVIE
              ? await tmdb.getMovie({ movieId: row.tmdbId })
              : await tmdb.getTvShow({ tvId: row.tmdbId });
          row.genreIds = details.genres.map((genre) => genre.id);
          await repository.save(row);
          hydrated += 1;
        } catch (error) {
          // Move a failed row behind older unhydrated rows so a persistent
          // provider failure cannot starve the rest of the bounded backlog.
          row.updatedAt = new Date();
          await repository.save(row);
          logger.warn('Unable to hydrate Watchlist genre metadata', {
            label: 'Watchlist',
            mediaType: row.mediaType,
            tmdbId: row.tmdbId,
            errorMessage:
              error instanceof Error ? error.message : 'Unknown provider error',
          });
        }
      }

      return hydrated;
    } finally {
      this.isRunning = false;
      this.cancelled = false;
    }
  }
}

const watchlistMetadataBackfill = new WatchlistMetadataBackfill();

export { WatchlistMetadataBackfill };
export default watchlistMetadataBackfill;
