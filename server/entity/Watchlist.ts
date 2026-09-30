import TheMovieDb from '@server/api/themoviedb';
import { MediaType } from '@server/constants/media';
import dataSource, { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { UserMediaState } from '@server/entity/UserMediaState';
import type { WatchlistItem } from '@server/interfaces/api/discoverInterfaces';
import logger from '@server/logger';
import { DbAwareColumn, resolveDbType } from '@server/utils/DbColumnHelper';
import {
  Column,
  Entity,
  Index,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import type { ZodNumber, ZodOptional, ZodString } from 'zod';

export class DuplicateWatchlistRequestError extends Error {}
export class NotFoundError extends Error {
  constructor(message = 'Not found') {
    super(message);
    this.name = 'NotFoundError';
  }
}

const nullableNumberArray = {
  to: (value?: number[] | null) =>
    value === null || value === undefined ? null : JSON.stringify(value),
  from: (value?: string | null) =>
    value === null || value === undefined
      ? null
      : (JSON.parse(value) as number[]),
};

@Entity()
@Unique('UNIQUE_USER_DB', ['tmdbId', 'mediaType', 'requestedBy'])
@Index('IDX_watchlist_user_created', ['requestedBy', 'createdAt'])
@Index('IDX_watchlist_user_type_title', ['requestedBy', 'mediaType', 'title'])
export class Watchlist implements WatchlistItem {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: 'varchar' })
  public ratingKey = '';

  @Column({ type: 'varchar' })
  public mediaType: MediaType;

  @Column({ type: 'varchar' })
  title = '';

  @Column({ type: 'text', nullable: true, transformer: nullableNumberArray })
  public genreIds: number[] | null = null;

  @Column()
  @Index()
  public tmdbId: number;

  @ManyToOne(() => User, (user) => user.watchlists, {
    eager: true,
    onDelete: 'CASCADE',
  })
  @Index()
  public requestedBy: User;

  @ManyToOne(() => Media, (media) => media.watchlists, {
    eager: true,
    nullable: true,
    onDelete: 'SET NULL',
  })
  @Index()
  public media?: Media | null;

  public userMediaState?: UserMediaState | null;

  @DbAwareColumn({ type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  public createdAt: Date;

  @UpdateDateColumn({
    type: resolveDbType('datetime'),
    default: () => 'CURRENT_TIMESTAMP',
  })
  public updatedAt: Date;

  constructor(init?: Partial<Watchlist>) {
    Object.assign(this, init);
  }

  public static async createWatchlist({
    watchlistRequest,
    user,
    tmdb = new TheMovieDb(),
  }: {
    watchlistRequest: {
      mediaType: MediaType;
      ratingKey?: ZodOptional<ZodString>['_output'];
      title?: ZodOptional<ZodString>['_output'];
      tmdbId: ZodNumber['_output'];
    };
    user: User;
    tmdb?: Pick<TheMovieDb, 'getMovie' | 'getTvShow'>;
  }): Promise<Watchlist> {
    const watchlistRepository = getRepository(this);

    const tmdbMedia =
      watchlistRequest.mediaType === MediaType.MOVIE
        ? await tmdb.getMovie({ movieId: watchlistRequest.tmdbId })
        : await tmdb.getTvShow({ tvId: watchlistRequest.tmdbId });

    const existing = await watchlistRepository
      .createQueryBuilder('watchlist')
      .leftJoinAndSelect('watchlist.requestedBy', 'user')
      .where('user.id = :userId', { userId: user.id })
      .andWhere('watchlist.tmdbId = :tmdbId', {
        tmdbId: watchlistRequest.tmdbId,
      })
      .andWhere('watchlist.mediaType = :mediaType', {
        mediaType: watchlistRequest.mediaType,
      })
      .getMany();

    if (existing && existing.length > 0) {
      logger.warn('Duplicate request for watchlist blocked', {
        tmdbId: watchlistRequest.tmdbId,
        mediaType: watchlistRequest.mediaType,
        label: 'Watchlist',
      });

      throw new DuplicateWatchlistRequestError();
    }

    return dataSource.transaction(async (manager) => {
      const transactionalWatchlistRepository = manager.getRepository(this);
      const mediaRepository = manager.getRepository(Media);
      const mediaStateRepository = manager.getRepository(UserMediaState);
      let media = await mediaRepository.findOne({
        where: {
          tmdbId: watchlistRequest.tmdbId,
          mediaType: watchlistRequest.mediaType,
        },
      });

      if (!media) {
        media = new Media({
          tmdbId: tmdbMedia.id,
          tvdbId: tmdbMedia.external_ids.tvdb_id,
          mediaType: watchlistRequest.mediaType,
        });
      }

      const watchlist = new this({
        ...watchlistRequest,
        genreIds: tmdbMedia.genres.map((genre) => genre.id),
        requestedBy: user,
        media,
      });

      await mediaRepository.save(media);
      await transactionalWatchlistRepository.save(watchlist);
      const existingState = await mediaStateRepository.findOne({
        where: {
          user: { id: user.id },
          mediaType: watchlistRequest.mediaType,
          tmdbId: watchlistRequest.tmdbId,
        },
      });
      if (!existingState) {
        await mediaStateRepository.save(
          new UserMediaState({
            user,
            mediaType: watchlistRequest.mediaType,
            tmdbId: watchlistRequest.tmdbId,
            media,
          })
        );
      } else if (!existingState.media) {
        existingState.media = media;
        await mediaStateRepository.save(existingState);
      }
      return watchlist;
    });
  }

  public static async deleteWatchlist(
    tmdbId: Watchlist['tmdbId'],
    mediaType: MediaType,
    user: User
  ): Promise<Watchlist | null> {
    const watchlistRepository = getRepository(this);
    const watchlist = await watchlistRepository.findOneBy({
      tmdbId,
      mediaType,
      requestedBy: { id: user.id },
    });
    if (!watchlist) {
      throw new NotFoundError('not Found');
    }

    if (watchlist) {
      await watchlistRepository.delete(watchlist.id);
    }

    return watchlist;
  }
}
