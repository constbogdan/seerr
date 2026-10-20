import { MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import { User } from '@server/entity/User';
import { Watchlist } from '@server/entity/Watchlist';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

describe('Media related Watchlist membership', () => {
  it('loads Movie and Series membership only for the current user', async () => {
    const owner = await getRepository(User).findOneByOrFail({ id: 1 });
    const other = await getRepository(User).save(
      new User({ email: 'filmography-other@example.test', avatar: '' })
    );
    const movie = await getRepository(Media).save(
      new Media({ tmdbId: 9740, mediaType: MediaType.MOVIE })
    );
    const series = await getRepository(Media).save(
      new Media({ tmdbId: 2001, mediaType: MediaType.TV })
    );

    await getRepository(Watchlist).save([
      new Watchlist({
        tmdbId: movie.tmdbId,
        mediaType: MediaType.MOVIE,
        title: 'Watchlisted Movie',
        requestedBy: owner,
        media: movie,
      }),
      new Watchlist({
        tmdbId: series.tmdbId,
        mediaType: MediaType.TV,
        title: 'Watchlisted Series',
        requestedBy: owner,
        media: series,
      }),
      new Watchlist({
        tmdbId: movie.tmdbId,
        mediaType: MediaType.MOVIE,
        title: 'Other User Movie',
        requestedBy: other,
        media: movie,
      }),
    ]);

    const targets = [
      { tmdbId: movie.tmdbId, mediaType: MediaType.MOVIE },
      { tmdbId: series.tmdbId, mediaType: MediaType.TV },
    ];
    const ownerMedia = await Media.getRelatedMedia(owner, targets);
    const otherMedia = await Media.getRelatedMedia(other, targets);

    assert.equal(ownerMedia.length, 2);
    assert.deepEqual(
      ownerMedia
        .map((item) => [
          item.mediaType,
          item.tmdbId,
          item.watchlists?.map((entry) => entry.title),
        ])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
      [
        [MediaType.MOVIE, movie.tmdbId, ['Watchlisted Movie']],
        [MediaType.TV, series.tmdbId, ['Watchlisted Series']],
      ]
    );
    assert.deepEqual(
      otherMedia
        .map((item) => [
          item.mediaType,
          item.tmdbId,
          item.watchlists?.map((entry) => entry.title),
        ])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
      [
        [MediaType.MOVIE, movie.tmdbId, ['Other User Movie']],
        [MediaType.TV, series.tmdbId, []],
      ]
    );
  });

  it('does not report membership for a related title absent from the Watchlist', async () => {
    const owner = await getRepository(User).findOneByOrFail({ id: 1 });
    const movie = await getRepository(Media).save(
      new Media({ tmdbId: 4242, mediaType: MediaType.MOVIE })
    );

    const [result] = await Media.getRelatedMedia(owner, [
      { tmdbId: movie.tmdbId, mediaType: MediaType.MOVIE },
    ]);

    assert.deepEqual(result.watchlists, []);
  });
});
