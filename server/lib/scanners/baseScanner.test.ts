import TheMovieDb from '@server/api/themoviedb';
import type { TmdbMovieDetails } from '@server/api/themoviedb/interfaces';
import {
  MediaRequestStatus,
  MediaStatus,
  MediaType,
} from '@server/constants/media';
import { getRepository } from '@server/datasource';
import Media from '@server/entity/Media';
import MediaRequest from '@server/entity/MediaRequest';
import Season from '@server/entity/Season';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import type { ProcessableSeason } from '@server/lib/scanners/baseScanner';
import BaseScanner from '@server/lib/scanners/baseScanner';
import { getSettings } from '@server/lib/settings';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

mock.method(MediaRequest, 'sendNotification', async () => undefined);
// getMovie is an instance field; intercept its constructor assignment as in
// the route fixtures, so completion notifications cannot reach a provider.
Object.defineProperty(TheMovieDb.prototype, 'getMovie', {
  get() {
    return async ({ movieId }: { movieId: number }) =>
      ({
        id: movieId,
        title: 'Synthetic movie',
        overview: '',
        release_date: '2026-01-01',
        poster_path: '',
      }) as TmdbMovieDetails;
  },
  set() {},
  configurable: true,
});

setupTestDb();

class HarnessScanner extends BaseScanner<unknown> {
  public constructor() {
    super('Harness Scan');
  }

  public async scanShow(
    tmdbId: number,
    seasons: ProcessableSeason[]
  ): Promise<void> {
    await this.processShow(tmdbId, undefined, seasons, {
      title: 'Test Show',
    });
  }

  public scanAbandonedMovie(tmdbId: number): Promise<void> {
    return this.processMovie(tmdbId, {
      title: 'Test Movie',
      processing: false,
      hasFile: false,
    });
  }
}

// Identical to what plex/index.ts and jellyfin/index.ts push for a season the library lacks.
const LIBRARY_HAS_NO_EPISODES: ProcessableSeason[] = [
  {
    seasonNumber: 1,
    episodes: 0,
    episodes4k: 0,
    totalEpisodes: 10,
  },
];

async function seedInFlightShow(tmdbId: number): Promise<MediaRequest> {
  const mediaRepository = getRepository(Media);
  const requestRepository = getRepository(MediaRequest);
  const userRepository = getRepository(User);

  const requestedBy = await userRepository.findOneOrFail({ where: { id: 1 } });

  const media = await mediaRepository.save(
    new Media({
      tmdbId,
      mediaType: MediaType.TV,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
      seasons: [
        new Season({
          seasonNumber: 1,
          status: MediaStatus.PROCESSING,
          status4k: MediaStatus.UNKNOWN,
        }),
      ],
    })
  );

  // sendToSonarr runs on insert and only bails when no server is configured,
  // so leftover settings from another test would reach TMDB and fail the request.
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];

  return requestRepository.save(
    new MediaRequest({
      type: MediaType.TV,
      status: MediaRequestStatus.APPROVED,
      media,
      requestedBy,
      is4k: false,
      seasons: [
        new SeasonRequest({
          seasonNumber: 1,
          status: MediaRequestStatus.APPROVED,
        }),
      ],
    })
  );
}

async function seedInFlightMovie(tmdbId: number): Promise<MediaRequest> {
  const mediaRepository = getRepository(Media);
  const requestRepository = getRepository(MediaRequest);
  const userRepository = getRepository(User);

  const requestedBy = await userRepository.findOneOrFail({ where: { id: 1 } });

  const media = await mediaRepository.save(
    new Media({
      tmdbId,
      mediaType: MediaType.MOVIE,
      status: MediaStatus.PROCESSING,
      status4k: MediaStatus.UNKNOWN,
    })
  );

  // sendToRadarr runs on insert and only bails when no server is configured,
  // so leftover settings from another test would reach TMDB and fail the request.
  const settings = getSettings();
  settings.radarr = [];
  settings.sonarr = [];

  return requestRepository.save(
    new MediaRequest({
      type: MediaType.MOVIE,
      status: MediaRequestStatus.APPROVED,
      media,
      requestedBy,
      is4k: false,
    })
  );
}

describe('BaseScanner', () => {
  it('completes multiple requests sequentially without savepoint collisions or identity loss', async () => {
    const requestRepository = getRepository(MediaRequest);
    const first = await seedInFlightMovie(7000);
    const second = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media: first.media,
        requestedBy: first.requestedBy,
        is4k: false,
      }),
      { listeners: false }
    );
    const fourK = await requestRepository.save(
      new MediaRequest({
        type: MediaType.MOVIE,
        status: MediaRequestStatus.APPROVED,
        media: first.media,
        requestedBy: first.requestedBy,
        is4k: true,
      }),
      { listeners: false }
    );
    first.media.status = MediaStatus.AVAILABLE;
    await getRepository(Media).save(first.media);
    for (const original of [first, second, fourK]) {
      const current = await requestRepository.findOneByOrFail({
        id: original.id,
      });
      assert.equal(
        current.status,
        original.is4k
          ? MediaRequestStatus.APPROVED
          : MediaRequestStatus.COMPLETED
      );
      assert.equal(current.createdAt.getTime(), original.createdAt.getTime());
    }
    assert.equal(await requestRepository.count(), 3);
  });

  describe('present media preserves request intent', () => {
    it('leaves an empty show request approved', async () => {
      const requestRepository = getRepository(MediaRequest);
      const request = await seedInFlightShow(7001);

      await new HarnessScanner().scanShow(7001, LIBRARY_HAS_NO_EPISODES);

      const updated = await requestRepository.findOneOrFail({
        where: { id: request.id },
      });

      assert.strictEqual(updated.status, MediaRequestStatus.APPROVED);
    });

    it('preserves the identity and season history of an empty show request', async () => {
      const requestRepository = getRepository(MediaRequest);
      const request = await seedInFlightShow(7002);

      await new HarnessScanner().scanShow(7002, LIBRARY_HAS_NO_EPISODES);

      const updated = await requestRepository.findOneOrFail({
        where: { id: request.id },
        relations: { seasons: true },
      });

      assert.strictEqual(updated.status, MediaRequestStatus.APPROVED);
      assert.deepEqual(
        updated.seasons.map(({ id, status }) => ({ id, status })),
        request.seasons.map(({ id, status }) => ({ id, status }))
      );
      assert.equal(updated.createdAt.getTime(), request.createdAt.getTime());
    });

    it('resets unmonitored movie availability without declining its request', async () => {
      const mediaRepository = getRepository(Media);
      const requestRepository = getRepository(MediaRequest);
      const request = await seedInFlightMovie(7003);

      await new HarnessScanner().scanAbandonedMovie(7003);

      const media = await mediaRepository.findOneOrFail({
        where: { tmdbId: 7003 },
      });
      const updated = await requestRepository.findOneOrFail({
        where: { id: request.id },
      });

      assert.strictEqual(media.status, MediaStatus.UNKNOWN);
      assert.strictEqual(updated.status, MediaRequestStatus.APPROVED);
    });

    it('repeated observations do not fabricate a decline or replace the request', async () => {
      const mediaRepository = getRepository(Media);
      const requestRepository = getRepository(MediaRequest);
      const request = await seedInFlightMovie(7004);
      const scanner = new HarnessScanner();

      await scanner.scanAbandonedMovie(7004);

      await scanner.scanAbandonedMovie(7004);

      const afterScan = await mediaRepository.findOneOrFail({
        where: { tmdbId: 7004 },
      });
      const updated = await requestRepository.findOneOrFail({
        where: { id: request.id },
      });

      assert.strictEqual(afterScan.status, MediaStatus.UNKNOWN);
      assert.strictEqual(updated.status, MediaRequestStatus.APPROVED);
      assert.equal(await requestRepository.count(), 1);
      assert.equal(updated.createdAt.getTime(), request.createdAt.getTime());
    });
  });
});
