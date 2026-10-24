import {
  LibraryMediaType,
  LibraryRemovalSource,
  SourceCheckpointStatus,
  ViewingCompletionClassification,
} from '@server/constants/libraryHistory';
import { MediaRequestStatus, MediaType } from '@server/constants/media';
import { MediaServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import {
  CanonicalEpisode,
  CanonicalEpisodeIdentity,
  CanonicalMedia,
  CanonicalMediaIdentity,
  CanonicalSeason,
  CanonicalSeasonIdentity,
} from '@server/entity/CanonicalMedia';
import { CurrentViewingState } from '@server/entity/CurrentViewingState';
import FreshMedia from '@server/entity/FreshMedia';
import {
  LibraryFile,
  LibraryFileEpisode,
  LibraryPresence,
  StorageRoot,
} from '@server/entity/LibraryHistory';
import { SourceCheckpoint } from '@server/entity/LibraryHydration';
import Media from '@server/entity/Media';
import { MediaRequest } from '@server/entity/MediaRequest';
import { RemovalSchedule } from '@server/entity/RemovalSchedule';
import SeasonRequest from '@server/entity/SeasonRequest';
import { User } from '@server/entity/User';
import { Viewer } from '@server/entity/Viewer';
import { ViewingEvidence } from '@server/entity/ViewingEvidence';
import { Watchlist } from '@server/entity/Watchlist';
import type { LibraryItem } from '@server/interfaces/api/libraryInterfaces';
import historicalDataImport from '@server/lib/historicalDataImport';
import {
  LibraryService,
  buildLibraryExternalLinks,
  resolveLibraryJellyfinUrl,
  type PageFacts,
} from '@server/lib/library';
import {
  getSettings,
  type RadarrSettings,
  type SonarrSettings,
} from '@server/lib/settings';
import { createWholphinHistoryArtifact } from '@server/lib/wholphinHistory';
import { isAuthenticated } from '@server/middleware/auth';
import { createLibraryRouter } from '@server/routes/library';
import { setupTestDb } from '@server/test/db';
import express from 'express';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

const service = new LibraryService({
  fetchPresentation: async (_mediaType, tmdbId) => ({
    title:
      new Map([
        [101, 'The Completed Movie'],
        [102, 'A Spy Among Friends'],
        [80039, 'The Underground Railroad'],
      ]).get(tmdbId) ?? `Canonical ${tmdbId}`,
    year: 2026,
    posterPath: `/poster-${tmdbId}.jpg`,
    backdropPath: `/backdrop-${tmdbId}.jpg`,
    voteAverage: 7.5,
    voteCount: 100,
    seasons:
      tmdbId === 80039
        ? [1, 2, 3, 4].map((seasonNumber) => ({
            seasonNumber,
            airDate: '2025-01-01',
          }))
        : undefined,
    collection:
      tmdbId === 101
        ? {
            id: 501,
            name: 'The Completed Collection',
            posterPath: '/collection-poster.jpg',
            backdropPath: '/collection-backdrop.jpg',
          }
        : null,
  }),
});
const app = express();
app.use(express.json());
const applyTestUser = (
  req: express.Request,
  _res: express.Response,
  next: express.NextFunction
) => {
  const role = req.header('x-test-role');
  if (role) {
    req.user = {
      id: 1,
      hasPermission: () => role === 'admin',
    } as unknown as Express.Request['user'];
  }
  next();
};
app.use(applyTestUser);
app.use('/library', isAuthenticated(), createLibraryRouter(service));
app.use(
  (
    error: { status?: number; message?: string },
    _req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) => {
    void next;
    return res.status(error.status ?? 500).json({ message: error.message });
  }
);

const candidateApp = express();
candidateApp.use(express.json());
candidateApp.use(applyTestUser);
candidateApp.use(
  '/library',
  isAuthenticated(),
  createLibraryRouter({
    query: (input) => service.queryCandidateForParity(input),
    seriesDetail: (canonicalMediaId) => service.seriesDetail(canonicalMediaId),
    userAvailability: (input) => service.userAvailability(input),
  })
);

setupTestDb();

let completedMovieId: number;
let partialMovieId: number;
let seriesId: number;
let removedMovieId: number;
let adminViewer: Viewer;
let secondViewer: Viewer;
let secondUser: User;

const addIdentity = async (media: CanonicalMedia, tmdbId: number) =>
  getRepository(CanonicalMediaIdentity).save(
    new CanonicalMediaIdentity({
      canonicalMediaId: media.id,
      mediaType: media.mediaType,
      provider: 'tmdb',
      sourceScope: '',
      value: String(tmdbId),
    })
  );

const jellyfinMovieId = (tmdbId: number) =>
  tmdbId.toString(16).padStart(32, '0');
const jellyfinEpisodeId = (episodeNumber: number, seasonNumber = 1) =>
  (seasonNumber * 1000 + episodeNumber).toString(16).padStart(32, '0');
const jellyfinLibraryGeneration = 'library-route-fixture-generation';

const addCurrentMovie = async (
  title: string,
  tmdbId: number,
  size: number,
  importedAt: string
) => {
  const media = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.MOVIE,
      titleSnapshot: title,
      year: 2026,
    })
  );
  await addIdentity(media, tmdbId);
  await getRepository(CanonicalMediaIdentity).save(
    new CanonicalMediaIdentity({
      canonicalMediaId: media.id,
      mediaType: media.mediaType,
      provider: 'jellyfin',
      sourceScope: 'jf',
      value: jellyfinMovieId(tmdbId),
    })
  );
  const presence = await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: media.id,
      sourceSystem: 'radarr',
      sourceScope: 'service:1',
      sourceItemId: `movie:${tmdbId}`,
      addedAt: new Date(importedAt),
      firstObservedAt: new Date(importedAt),
      servarrHasFile: true,
      isCurrent: true,
      logicalSizeBytes: String(size),
    })
  );
  await getRepository(LibraryFile).save(
    new LibraryFile({
      libraryPresenceId: presence.id,
      sourceSystem: 'radarr',
      sourceScope: '1',
      sourceFileId: `file-${tmdbId}`,
      sizeBytes: String(size),
      importedAt: new Date(importedAt),
      firstObservedAt: new Date(importedAt),
      isCurrent: true,
    })
  );
  await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: media.id,
      sourceSystem: 'jellyfin',
      sourceScope: 'jf',
      sourceItemId: `movie:${jellyfinMovieId(tmdbId)}`,
      firstObservedAt: new Date(importedAt),
      logicalSizeBytes: String(size),
      jellyfinVisible: true,
      isCurrent: true,
    })
  );
  return media;
};

const closeLibraryMedia = async (canonicalMediaId: number) => {
  const removedAt = new Date('2026-05-01T00:00:00.000Z');
  const presences = await getRepository(LibraryPresence).findBy({
    canonicalMediaId,
    isCurrent: true,
  });
  for (const presence of presences) {
    presence.isCurrent = false;
    presence.servarrHasFile = false;
    presence.jellyfinVisible = false;
    presence.removedAt = removedAt;
    await getRepository(LibraryPresence).save(presence);
    const files = await getRepository(LibraryFile).findBy({
      libraryPresenceId: presence.id,
      isCurrent: true,
    });
    for (const file of files) {
      file.isCurrent = false;
      file.removedAt = removedAt;
    }
    await getRepository(LibraryFile).save(files);
  }
};

beforeEach(async () => {
  getSettings().main.mediaServerType = MediaServerType.JELLYFIN;
  getSettings().jellyfin.serverId = 'jf';
  getSettings().jellyfin.externalHostname = 'https://jellyfin.example';
  getSettings().radarr = [
    {
      id: 1,
      name: 'Library test Radarr',
      hostname: 'radarr',
      port: 7878,
      apiKey: 'test',
      useSsl: false,
      is4k: false,
      isDefault: true,
    } as RadarrSettings,
  ];
  getSettings().sonarr = [
    {
      id: 2,
      name: 'Library test Sonarr',
      hostname: 'sonarr',
      port: 8989,
      apiKey: 'test',
      useSsl: false,
      is4k: false,
      isDefault: true,
    } as SonarrSettings,
  ];
  const admin = await getRepository(User).findOneByOrFail({ id: 1 });
  admin.username = 'Moni';
  admin.avatar = '/avatar/moni';
  admin.includeInUserMetrics = false;
  await getRepository(User).save(admin);
  secondUser = await getRepository(User).save(
    new User({
      email: 'second@example.test',
      username: 'Bogdan',
      avatar: '/avatar/bogdan',
      userType: UserType.LOCAL,
      permissions: 0,
      includeInUserMetrics: false,
    })
  );
  adminViewer = await getRepository(Viewer).save(
    new Viewer({
      source: 'jellyfin',
      sourceScope: 'jf',
      sourceUserId: 'private-admin-id',
      userId: admin.id,
      user: admin,
    })
  );
  secondViewer = await getRepository(Viewer).save(
    new Viewer({
      source: 'jellyfin',
      sourceScope: 'jf',
      sourceUserId: 'private-second-id',
      userId: secondUser.id,
      user: secondUser,
    })
  );
  await getRepository(SourceCheckpoint).save(
    new SourceCheckpoint({
      source: 'jellyfin',
      sourceScope: 'jf',
      sourceGeneration: jellyfinLibraryGeneration,
      stage: 'current-library',
      status: SourceCheckpointStatus.CURRENT,
      lastSuccessfulAt: new Date('2026-03-13T12:00:00.000Z'),
    })
  );

  const completed = await addCurrentMovie(
    'The Completed Movie',
    101,
    10 * 1024 ** 3,
    '2026-01-10T00:00:00.000Z'
  );
  completedMovieId = completed.id;
  const partial = await addCurrentMovie(
    'A Spy Among Friends',
    102,
    5 * 1024 ** 3,
    '2026-02-10T00:00:00.000Z'
  );
  partialMovieId = partial.id;
  await getRepository(ViewingEvidence).save([
    new ViewingEvidence({
      source: 'jellyfin',
      sourceScope: 'jf',
      sourceClass: 'history',
      sourceActivityId: 'completed-movie',
      viewerId: adminViewer.id,
      viewer: adminViewer,
      canonicalMediaId: completed.id,
      observedAt: new Date('2026-03-01T12:00:00.000Z'),
      completionClassification: ViewingCompletionClassification.CONFIRMED,
    }),
    new ViewingEvidence({
      source: 'jellyfin',
      sourceScope: 'jf',
      sourceClass: 'history',
      sourceActivityId: 'historical-partial',
      viewerId: adminViewer.id,
      viewer: adminViewer,
      canonicalMediaId: partial.id,
      observedAt: new Date('2026-02-15T12:00:00.000Z'),
      progressBasisPoints: 7000,
      playbackDurationSeconds: 900,
      completionClassification: ViewingCompletionClassification.LIKELY,
    }),
  ]);
  await getRepository(CurrentViewingState).save([
    new CurrentViewingState({
      viewerId: adminViewer.id,
      viewer: adminViewer,
      sourceScope: 'jf',
      sourceItemId: jellyfinMovieId(101),
      mediaType: 'movie',
      canonicalMediaId: completed.id,
      played: true,
      progressBasisPoints: 10_000,
      lastPlayedAt: new Date('2026-03-01T12:00:00.000Z'),
      observedAt: new Date('2026-03-03T12:00:00.000Z'),
    }),
    new CurrentViewingState({
      viewerId: secondViewer.id,
      viewer: secondViewer,
      sourceScope: 'jf',
      sourceItemId: jellyfinMovieId(102),
      mediaType: 'movie',
      canonicalMediaId: partial.id,
      played: false,
      progressBasisPoints: 6500,
      lastPlayedAt: new Date('2026-03-02T12:00:00.000Z'),
      observedAt: new Date('2026-03-03T12:00:00.000Z'),
    }),
    new CurrentViewingState({
      viewerId: adminViewer.id,
      viewer: adminViewer,
      sourceScope: 'jf',
      sourceItemId: jellyfinMovieId(102),
      mediaType: 'movie',
      canonicalMediaId: partial.id,
      played: false,
      progressBasisPoints: 0,
      lastPlayedAt: null,
      observedAt: new Date('2026-04-01T12:00:00.000Z'),
    }),
  ]);
  await getRepository(Watchlist).save(
    new Watchlist({
      ratingKey: '101',
      mediaType: MediaType.MOVIE,
      title: 'The Completed Movie',
      tmdbId: 101,
      requestedBy: secondUser,
    })
  );

  const series = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.SERIES,
      titleSnapshot: 'The Underground Railroad',
      year: 2021,
    })
  );
  seriesId = series.id;
  await addIdentity(series, 80039);
  await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: series.id,
      sourceSystem: 'jellyfin',
      sourceScope: 'jf',
      sourceItemId: `series:${jellyfinMovieId(80039)}`,
      firstObservedAt: new Date('2025-12-01T00:00:00.000Z'),
      jellyfinVisible: true,
      isCurrent: true,
    })
  );
  const season = await getRepository(CanonicalSeason).save(
    new CanonicalSeason({ seriesId: series.id, seasonNumber: 1 })
  );
  await getRepository(CanonicalSeasonIdentity).save(
    new CanonicalSeasonIdentity({
      canonicalSeasonId: season.id,
      provider: 'sonarr',
      sourceScope: '2',
      value: '80039:1',
    })
  );
  const presence = await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: series.id,
      sourceSystem: 'sonarr',
      sourceScope: 'service:2',
      sourceItemId: 'series:80039',
      addedAt: new Date('2025-12-01T00:00:00.000Z'),
      firstObservedAt: new Date('2025-12-01T00:00:00.000Z'),
      servarrHasFile: true,
      isCurrent: true,
    })
  );
  for (let episodeNumber = 1; episodeNumber <= 10; episodeNumber++) {
    const episode = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({
        seasonId: season.id,
        episodeNumber,
        isSpecial: false,
      })
    );
    const episodeSourceId = jellyfinEpisodeId(episodeNumber);
    await getRepository(CanonicalEpisodeIdentity).save([
      new CanonicalEpisodeIdentity({
        canonicalEpisodeId: episode.id,
        provider: 'jellyfin',
        sourceScope: 'jf',
        value: episodeSourceId,
        lastSeenSourceGeneration: jellyfinLibraryGeneration,
      }),
      new CanonicalEpisodeIdentity({
        canonicalEpisodeId: episode.id,
        provider: 'sonarr',
        sourceScope: '2',
        value: String(episodeNumber),
      }),
    ]);
    const file = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: presence.id,
        sourceSystem: 'sonarr',
        sourceScope: '2',
        sourceFileId: `series-file-${episodeNumber}`,
        sizeBytes: String(1024 ** 3),
        importedAt: new Date(
          `2025-12-${String(episodeNumber).padStart(2, '0')}T00:00:00.000Z`
        ),
        firstObservedAt: new Date('2025-12-01T00:00:00.000Z'),
        isCurrent: true,
      })
    );
    await getRepository(LibraryFileEpisode).save(
      new LibraryFileEpisode({
        libraryFileId: file.id,
        canonicalEpisodeId: episode.id,
      })
    );
    if (episodeNumber === 1) {
      await getRepository(CurrentViewingState).save(
        new CurrentViewingState({
          viewerId: adminViewer.id,
          viewer: adminViewer,
          sourceScope: 'jf',
          sourceItemId: episodeSourceId,
          mediaType: 'episode',
          canonicalMediaId: series.id,
          canonicalEpisodeId: episode.id,
          played: false,
          progressBasisPoints: 1133,
          lastPlayedAt: new Date('2026-03-10T12:00:00.000Z'),
          observedAt: new Date('2026-03-11T12:00:00.000Z'),
        })
      );
    } else {
      await getRepository(CurrentViewingState).save(
        new CurrentViewingState({
          viewerId: adminViewer.id,
          viewer: adminViewer,
          sourceScope: 'jf',
          sourceItemId: episodeSourceId,
          mediaType: 'episode',
          canonicalMediaId: series.id,
          canonicalEpisodeId: episode.id,
          played: true,
          progressBasisPoints: 10_000,
          lastPlayedAt: new Date(
            `2026-03-${String(episodeNumber).padStart(2, '0')}T12:00:00.000Z`
          ),
          observedAt: new Date('2026-03-11T12:00:00.000Z'),
        })
      );
      await getRepository(ViewingEvidence).save(
        new ViewingEvidence({
          source: 'jellyfin',
          sourceScope: 'jf',
          sourceClass: 'history',
          sourceActivityId: `underground-e${episodeNumber}`,
          viewerId: adminViewer.id,
          viewer: adminViewer,
          canonicalMediaId: series.id,
          canonicalEpisodeId: episode.id,
          observedAt: new Date(
            `2026-03-${String(episodeNumber).padStart(2, '0')}T12:00:00.000Z`
          ),
          completionClassification: ViewingCompletionClassification.CONFIRMED,
        })
      );
      if (episodeNumber <= 4) {
        await getRepository(CurrentViewingState).save(
          new CurrentViewingState({
            viewerId: secondViewer.id,
            viewer: secondViewer,
            sourceScope: 'jf',
            sourceItemId: episodeSourceId,
            mediaType: 'episode',
            canonicalMediaId: series.id,
            canonicalEpisodeId: episode.id,
            played: true,
            progressBasisPoints: 10_000,
            lastPlayedAt: new Date('2026-03-05T12:00:00.000Z'),
            observedAt: new Date('2026-03-06T12:00:00.000Z'),
          })
        );
      }
    }
  }
  const specials = await getRepository(CanonicalSeason).save(
    new CanonicalSeason({ seriesId: series.id, seasonNumber: 0 })
  );
  await getRepository(CanonicalSeasonIdentity).save(
    new CanonicalSeasonIdentity({
      canonicalSeasonId: specials.id,
      provider: 'sonarr',
      sourceScope: '2',
      value: '80039:0',
    })
  );
  const special = await getRepository(CanonicalEpisode).save(
    new CanonicalEpisode({
      seasonId: specials.id,
      episodeNumber: 1,
      isSpecial: true,
    })
  );
  const specialSourceId = 'ff'.padStart(32, '0');
  await getRepository(CanonicalEpisodeIdentity).save(
    new CanonicalEpisodeIdentity({
      canonicalEpisodeId: special.id,
      provider: 'jellyfin',
      sourceScope: 'jf',
      value: specialSourceId,
      lastSeenSourceGeneration: jellyfinLibraryGeneration,
    })
  );
  const specialFile = await getRepository(LibraryFile).save(
    new LibraryFile({
      libraryPresenceId: presence.id,
      sourceSystem: 'sonarr',
      sourceScope: '2',
      sourceFileId: 'series-special-1',
      sizeBytes: String(512 * 1024 ** 2),
      importedAt: new Date('2025-12-11T00:00:00.000Z'),
      firstObservedAt: new Date('2025-12-11T00:00:00.000Z'),
      isCurrent: true,
    })
  );
  await getRepository(LibraryFileEpisode).save(
    new LibraryFileEpisode({
      libraryFileId: specialFile.id,
      canonicalEpisodeId: special.id,
    })
  );
  await getRepository(ViewingEvidence).save(
    new ViewingEvidence({
      source: 'jellyfin',
      sourceScope: 'jf',
      sourceClass: 'history',
      sourceActivityId: 'underground-special-1',
      viewerId: adminViewer.id,
      viewer: adminViewer,
      canonicalMediaId: series.id,
      canonicalEpisodeId: special.id,
      observedAt: new Date('2026-03-12T12:00:00.000Z'),
      completionClassification: ViewingCompletionClassification.CONFIRMED,
    })
  );
  await getRepository(CurrentViewingState).save(
    new CurrentViewingState({
      viewerId: adminViewer.id,
      viewer: adminViewer,
      sourceScope: 'jf',
      sourceItemId: specialSourceId,
      mediaType: 'episode',
      canonicalMediaId: series.id,
      canonicalEpisodeId: special.id,
      played: true,
      progressBasisPoints: 10_000,
      lastPlayedAt: new Date('2026-03-12T12:00:00.000Z'),
      observedAt: new Date('2026-03-13T12:00:00.000Z'),
    })
  );

  const removed = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.MOVIE,
      titleSnapshot: 'Removed Movie',
      year: 2020,
    })
  );
  removedMovieId = removed.id;
  await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: removed.id,
      sourceSystem: 'radarr',
      sourceScope: '1',
      sourceItemId: 'removed-movie',
      firstObservedAt: new Date('2025-01-01T00:00:00.000Z'),
      removedAt: new Date('2026-01-01T00:00:00.000Z'),
      servarrHasFile: true,
      isCurrent: false,
    })
  );
});

describe('Library factual administrator API', () => {
  it('keeps availability execution independent from the main Library request', async () => {
    let availabilityCalls = 0;
    const isolatedApp = express();
    isolatedApp.use((req, _res, next) => {
      req.user = {
        id: 1,
        hasPermission: () => true,
      } as unknown as Express.Request['user'];
      next();
    });
    isolatedApp.use(
      '/library',
      createLibraryRouter({
        query: async () => ({
          pageInfo: { pages: 0, page: 1, results: 0, pageSize: 25 },
          results: [],
          storageLocations: [],
          sourceStatus: {
            library: 'current',
            currentViewing: 'current',
            historicalViewing: 'current',
            historicalImport: {
              state: 'accepted',
              observedRange: null,
              contentHash: null,
            },
          },
        }),
        userAvailability: async () => {
          availabilityCalls++;
          return { users: [] };
        },
        seriesDetail: async () => null,
      })
    );

    assert.equal((await request(isolatedApp).get('/library')).status, 200);
    assert.equal(availabilityCalls, 0);
    assert.equal(
      (await request(isolatedApp).get('/library/user-availability')).status,
      200
    );
    assert.equal(availabilityCalls, 1);
  });

  it('projects only uniform confirmed 1080p or 2160p file resolutions', async () => {
    const moviePresence = await getRepository(LibraryPresence).findOneByOrFail({
      canonicalMediaId: completedMovieId,
      sourceSystem: 'radarr',
      isCurrent: true,
    });
    const movieFile = await getRepository(LibraryFile).findOneByOrFail({
      libraryPresenceId: moviePresence.id,
      isCurrent: true,
    });
    movieFile.resolution = 2160;
    await getRepository(LibraryFile).save(movieFile);

    const seriesPresence = await getRepository(LibraryPresence).findOneByOrFail(
      {
        canonicalMediaId: seriesId,
        sourceSystem: 'sonarr',
        isCurrent: true,
      }
    );
    const seriesFiles = await getRepository(LibraryFile).findBy({
      libraryPresenceId: seriesPresence.id,
      isCurrent: true,
    });
    for (const file of seriesFiles) file.resolution = 1080;
    await getRepository(LibraryFile).save(seriesFiles);

    const movie = await request(app)
      .get('/library?search=completed movie')
      .set('x-test-role', 'admin');
    assert.equal(movie.body.results[0].resolution, 2160);

    const series = await request(app)
      .get('/library?search=underground railroad')
      .set('x-test-role', 'admin');
    assert.equal(series.body.results[0].resolution, 1080);
    assert.equal(
      series.body.results[0].seasonSummaries.every(
        (season: { resolution: number | null }) => season.resolution === 1080
      ),
      true
    );
    const uniformDetail = await request(app)
      .get(`/library/${seriesId}/series-detail`)
      .set('x-test-role', 'admin');
    assert.equal(
      uniformDetail.body.seasons.every(
        (season: { resolution: number | null }) => season.resolution === 1080
      ),
      true
    );

    const mixedFile = seriesFiles.find(
      (file) => file.sourceFileId === 'series-file-1'
    );
    assert.ok(mixedFile);
    mixedFile.resolution = 2160;
    await getRepository(LibraryFile).save(mixedFile);
    const mixed = await request(app)
      .get('/library?search=underground railroad')
      .set('x-test-role', 'admin');
    assert.equal(mixed.body.results[0].resolution, null);
    assert.equal(
      mixed.body.results[0].seasonSummaries.find(
        (season: { seasonNumber: number }) => season.seasonNumber === 1
      ).resolution,
      null
    );
    assert.equal(
      mixed.body.results[0].seasonSummaries.some(
        (season: { seasonNumber: number }) => season.seasonNumber === 0
      ),
      false
    );

    mixedFile.resolution = null;
    await getRepository(LibraryFile).save(mixedFile);
    const unknown = await request(app)
      .get('/library?search=underground railroad')
      .set('x-test-role', 'admin');
    assert.equal(unknown.body.results[0].resolution, null);

    const lowerResolutionPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({
      canonicalMediaId: partialMovieId,
      sourceSystem: 'radarr',
      isCurrent: true,
    });
    const lowerResolutionFile = await getRepository(
      LibraryFile
    ).findOneByOrFail({
      libraryPresenceId: lowerResolutionPresence.id,
      isCurrent: true,
    });
    lowerResolutionFile.resolution = 720;
    await getRepository(LibraryFile).save(lowerResolutionFile);
    const lowerResolution = await request(app)
      .get('/library?search=spy among friends')
      .set('x-test-role', 'admin');
    assert.equal(lowerResolution.body.results[0].resolution, null);

    await closeLibraryMedia(completedMovieId);
    const archivedMovie = await request(app)
      .get('/library?scope=archive&search=completed movie')
      .set('x-test-role', 'admin');
    assert.equal(archivedMovie.body.results[0].resolution, 2160);
  });

  it('builds only verified deterministic links from the existing Media relationship', () => {
    const media = new Media();
    media.serviceUrl = 'https://radarr.example/movie/proven-slug';
    media.serviceUrl4k = 'https://radarr-4k.example/movie/proven-slug';
    media.mediaUrl =
      'https://jellyfin.example/web/index.html#!/details?id=proven-id';
    assert.deepEqual(
      buildLibraryExternalLinks(
        LibraryMediaType.MOVIE,
        media,
        'https://jellyfin.example/web/index.html#!/details?id=fallback-id'
      ),
      [
        {
          service: 'radarr',
          label: 'Radarr',
          url: 'https://radarr.example/movie/proven-slug',
        },
        {
          service: 'radarr',
          label: 'Radarr 4K',
          url: 'https://radarr-4k.example/movie/proven-slug',
        },
        {
          service: 'jellyfin',
          label: 'Jellyfin',
          url: 'https://jellyfin.example/web/index.html#!/details?id=proven-id',
        },
      ]
    );
    assert.deepEqual(
      buildLibraryExternalLinks(LibraryMediaType.SERIES, null),
      []
    );
  });

  it('resolves one exact Jellyfin identity for the configured server and fails closed otherwise', () => {
    const itemId = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const otherItemId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    assert.equal(
      resolveLibraryJellyfinUrl({
        identities: [
          { sourceScope: 'other-server', value: otherItemId },
          { sourceScope: 'jf', value: itemId },
        ],
        serverId: 'jf',
        hostname: 'https://jellyfin.example',
        pageName: 'details',
      }),
      `https://jellyfin.example/web/index.html#!/details?id=${itemId}&context=home&serverId=jf`
    );
    assert.equal(
      resolveLibraryJellyfinUrl({
        identities: [
          { sourceScope: 'jf', value: itemId },
          { sourceScope: 'jf', value: otherItemId },
        ],
        serverId: 'jf',
        hostname: 'https://jellyfin.example',
        pageName: 'details',
      }),
      null,
      'multiple current IDs for one configured server are ambiguous'
    );
    assert.equal(
      resolveLibraryJellyfinUrl({
        identities: [{ sourceScope: 'jf', value: 'not-a-jellyfin-id' }],
        serverId: 'jf',
        hostname: 'https://jellyfin.example',
        pageName: 'details',
      }),
      null
    );
    assert.equal(
      resolveLibraryJellyfinUrl({
        identities: [{ sourceScope: 'jf', value: itemId }],
        serverId: 'jf',
        hostname: 'https://user:secret@jellyfin.example',
        pageName: 'details',
      }),
      null,
      'credentials are never exposed in projected URLs'
    );
    assert.equal(
      resolveLibraryJellyfinUrl({
        identities: [{ sourceScope: 'jf', value: itemId }],
        serverId: 'jf',
        hostname: 'https://jellyfin.example/base?api_key=secret',
        pageName: 'details',
      }),
      null,
      'query parameters are never exposed in projected URLs'
    );
    assert.equal(
      resolveLibraryJellyfinUrl({
        identities: [{ sourceScope: 'jf', value: itemId }],
        serverId: 'jf',
        hostname: 'https://jellyfin.example/base#secret',
        pageName: 'details',
      }),
      null,
      'fragments are never exposed in projected URLs'
    );
    assert.equal(
      resolveLibraryJellyfinUrl({
        identities: [{ sourceScope: 'jf', value: itemId }],
        serverId: 'jf',
        hostname: 'https://jellyfin.example/base/',
        pageName: 'details',
      }),
      `https://jellyfin.example/base/web/index.html#!/details?id=${itemId}&context=home&serverId=jf`,
      'valid path-based base URLs remain supported'
    );
  });

  it('projects current visible Jellyfin identities for Animation Movies and Series without guessing', async () => {
    const seriesJellyfinId = jellyfinMovieId(80039);
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: seriesId,
        mediaType: LibraryMediaType.SERIES,
        provider: 'jellyfin',
        sourceScope: 'jf',
        value: seriesJellyfinId,
      })
    );
    const nonAnimationMovie = await request(app)
      .get('/library?animation=no&search=completed%20movie')
      .set('x-test-role', 'admin');
    const nonAnimationSeries = await request(app)
      .get('/library?animation=no&search=underground%20railroad')
      .set('x-test-role', 'admin');
    for (const response of [nonAnimationMovie, nonAnimationSeries]) {
      assert.equal(response.status, 200);
      assert.equal(response.body.results.length, 1);
      assert.equal(response.body.results[0].externalLinks.length, 1);
      assert.equal(
        response.body.results[0].externalLinks[0].service,
        'jellyfin'
      );
    }

    const movieRoot = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'radarr',
        serviceId: 1,
        sourceRootId: 901,
        nameSnapshot: 'Animation Movies',
        pathSnapshot: '/library/animation/movies',
        isAnimation: true,
      })
    );
    const seriesRoot = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'sonarr',
        serviceId: 2,
        sourceRootId: 902,
        nameSnapshot: 'Animation Series',
        pathSnapshot: '/library/animation/series',
        isAnimation: true,
      })
    );
    const moviePresence = await getRepository(LibraryPresence).findOneByOrFail({
      canonicalMediaId: completedMovieId,
      sourceSystem: 'radarr',
      isCurrent: true,
    });
    moviePresence.storageRootId = movieRoot.id;
    await getRepository(LibraryPresence).save(moviePresence);
    const seriesPresence = await getRepository(LibraryPresence).findOneByOrFail(
      {
        canonicalMediaId: seriesId,
        sourceSystem: 'sonarr',
        isCurrent: true,
      }
    );
    seriesPresence.storageRootId = seriesRoot.id;
    await getRepository(LibraryPresence).save(seriesPresence);

    const movie = await request(app)
      .get('/library?animation=yes&search=completed%20movie')
      .set('x-test-role', 'admin');
    const series = await request(app)
      .get('/library?animation=yes&search=underground%20railroad')
      .set('x-test-role', 'admin');
    for (const response of [movie, series]) {
      assert.equal(response.status, 200);
      assert.equal(response.body.results.length, 1);
      assert.equal(
        response.body.results[0].externalLinks.filter(
          (link: { service: string }) => link.service === 'jellyfin'
        ).length,
        1
      );
      assert.equal(
        JSON.stringify(response.body.results[0].externalLinks).includes(
          'apiKey'
        ),
        false
      );
    }
    assert.match(
      movie.body.results[0].externalLinks[0].url,
      new RegExp(jellyfinMovieId(101))
    );
    assert.match(
      series.body.results[0].externalLinks[0].url,
      new RegExp(seriesJellyfinId)
    );

    const otherServerItemId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: completedMovieId,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'jellyfin',
        sourceScope: 'other-server',
        value: otherServerItemId,
      })
    );
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: completedMovieId,
        sourceSystem: 'jellyfin',
        sourceScope: 'other-server',
        sourceItemId: `movie:${otherServerItemId}`,
        jellyfinVisible: true,
        isCurrent: true,
      })
    );
    const multipleServers = await request(app)
      .get('/library?search=completed%20movie')
      .set('x-test-role', 'admin');
    assert.match(
      multipleServers.body.results[0].externalLinks[0].url,
      new RegExp(jellyfinMovieId(101))
    );

    const ambiguousItemId = 'cccccccccccccccccccccccccccccccc';
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: completedMovieId,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'jellyfin',
        sourceScope: 'jf',
        value: ambiguousItemId,
      })
    );
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: completedMovieId,
        sourceSystem: 'jellyfin',
        sourceScope: 'jf',
        sourceItemId: `movie:${ambiguousItemId}`,
        jellyfinVisible: true,
        isCurrent: true,
      })
    );
    const ambiguous = await request(app)
      .get('/library?search=completed%20movie')
      .set('x-test-role', 'admin');
    assert.deepEqual(ambiguous.body.results[0].externalLinks, []);

    const jellyfinPresences = await getRepository(LibraryPresence).findBy({
      canonicalMediaId: completedMovieId,
      sourceSystem: 'jellyfin',
      isCurrent: true,
    });
    for (const presence of jellyfinPresences) {
      presence.isCurrent = false;
      presence.jellyfinVisible = false;
    }
    await getRepository(LibraryPresence).save(jellyfinPresences);
    const servarrOnly = await request(app)
      .get('/library?search=completed%20movie')
      .set('x-test-role', 'admin');
    assert.deepEqual(servarrOnly.body.results[0].externalLinks, []);
  });

  it('enforces administrator authorization', async () => {
    assert.equal(
      (await request(app).get('/library').set('x-test-role', 'user')).status,
      403
    );
    assert.equal(
      (await request(app).get('/library').set('x-test-role', 'admin')).status,
      200
    );
    assert.equal(
      (
        await request(app)
          .get('/library/user-availability')
          .set('x-test-role', 'user')
      ).status,
      403
    );
    assert.equal(
      (
        await request(app)
          .get('/library/user-availability')
          .set('x-test-role', 'admin')
      ).status,
      200
    );
  });

  it('keeps presentation batch status administrator-only and validates its identity', async () => {
    const batchId = '11111111-1111-4111-8111-111111111111';
    assert.equal(
      (
        await request(app)
          .get(`/library/presentation-status/${batchId}`)
          .set('x-test-role', 'user')
      ).status,
      403
    );
    const expired = await request(app)
      .get(`/library/presentation-status/${batchId}`)
      .set('x-test-role', 'admin');
    assert.equal(expired.status, 200);
    assert.equal(expired.body.state, 'expired');
    assert.equal(
      (
        await request(app)
          .get('/library/presentation-status/not-a-uuid')
          .set('x-test-role', 'admin')
      ).status,
      400
    );
  });

  it('defaults to Current and derives Archive and All as a distinct canonical union', async () => {
    const current = await request(app)
      .get('/library?sort=title&sortDirection=asc')
      .set('x-test-role', 'admin');
    const explicitCurrent = await request(app)
      .get('/library?scope=current&sort=title&sortDirection=asc')
      .set('x-test-role', 'admin');
    const archive = await request(app)
      .get('/library?scope=archive&sort=title&sortDirection=asc')
      .set('x-test-role', 'admin');
    const all = await request(app)
      .get('/library?scope=all&sort=title&sortDirection=asc')
      .set('x-test-role', 'admin');

    assert.deepEqual(current.body, explicitCurrent.body);
    assert.equal('users' in current.body, false);
    assert.equal(current.body.pageInfo.results, 3);
    assert.equal(archive.body.pageInfo.results, 1);
    assert.equal(all.body.pageInfo.results, 4);
    assert.deepEqual(
      archive.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [removedMovieId]
    );
    assert.equal(
      new Set(
        all.body.results.map(
          (item: { canonicalMediaId: number }) => item.canonicalMediaId
        )
      ).size,
      4
    );
    assert.deepEqual(archive.body.results[0].watchedUsers, []);
    assert.equal(archive.body.results[0].lastActiveAt, null);
    assert.equal(archive.body.results[0].addedAt, null);
    assert.equal(archive.body.results[0].removedAt, '2026-01-01T00:00:00.000Z');
    assert.equal(archive.body.results[0].removalSource, 'unknown');
    assert.equal(archive.body.results[0].logicalSizeBytes, null);
    assert.deepEqual(archive.body.results[0].storageRoots, []);
    assert.deepEqual(archive.body.results[0].externalLinks, []);
  });

  it('excludes closed inventory that never had physical media from Archive and All', async () => {
    const fileless = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Always Fileless Historical Movie',
        year: 2021,
      })
    );
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: fileless.id,
        sourceSystem: 'radarr',
        sourceScope: 'fileless-history',
        sourceItemId: 'fileless-history',
        firstObservedAt: new Date('2025-01-01T00:00:00.000Z'),
        removedAt: new Date('2026-01-01T00:00:00.000Z'),
        servarrHasFile: false,
        isCurrent: false,
      })
    );

    for (const scope of ['archive', 'all']) {
      const response = await request(app)
        .get(
          `/library?scope=${scope}&search=always%20fileless%20historical%20movie`
        )
        .set('x-test-role', 'admin');
      assert.equal(response.status, 200);
      assert.equal(response.body.pageInfo.results, 0);
      assert.deepEqual(response.body.results, []);
    }
  });

  it('filters durable Movie collection membership before totals, sorting, pagination, and presentation', async () => {
    const canonicalRepository = getRepository(CanonicalMedia);
    await canonicalRepository.update(completedMovieId, {
      tmdbCollectionId: 501,
      collectionMembershipHydratedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    await canonicalRepository.update(partialMovieId, {
      tmdbCollectionId: null,
      collectionMembershipHydratedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const alphaMember = await addCurrentMovie(
      'Alpha Collection Member',
      104,
      2 * 1024 ** 3,
      '2026-03-01T00:00:00.000Z'
    );
    await canonicalRepository.update(alphaMember.id, {
      tmdbCollectionId: 777,
      collectionMembershipHydratedAt: new Date('2026-10-01T00:00:00.000Z'),
    });
    const unknown = await addCurrentMovie(
      'Unknown Collection Movie',
      105,
      1024 ** 3,
      '2026-03-02T00:00:00.000Z'
    );

    const any = await request(app)
      .get('/library?collectionMembership=any&sort=title&sortDirection=asc')
      .set('x-test-role', 'admin');
    assert.equal(any.status, 200);
    assert.equal(any.body.pageInfo.results, 5);
    assert.equal('collectionMembershipUnknownCount' in any.body, false);

    const inCollection = await request(app)
      .get(
        '/library?collectionMembership=in&mediaType=series&sort=title&sortDirection=asc&take=1&skip=1'
      )
      .set('x-test-role', 'admin');
    assert.equal(inCollection.status, 200);
    assert.equal(inCollection.body.pageInfo.results, 2);
    assert.equal(inCollection.body.pageInfo.pages, 2);
    assert.deepEqual(
      inCollection.body.results.map(
        (item: { canonicalMediaId: number; mediaType: string }) => [
          item.canonicalMediaId,
          item.mediaType,
        ]
      ),
      [[completedMovieId, 'movie']]
    );
    assert.equal(inCollection.body.collectionMembershipUnknownCount, 1);

    const noCollection = await request(app)
      .get(
        '/library?collectionMembership=none&mediaType=series&sort=title&sortDirection=asc'
      )
      .set('x-test-role', 'admin');
    assert.equal(noCollection.status, 200);
    assert.equal(noCollection.body.pageInfo.results, 1);
    assert.deepEqual(
      noCollection.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [partialMovieId]
    );
    assert.equal(noCollection.body.collectionMembershipUnknownCount, 1);
    assert.equal(
      noCollection.body.results.some(
        (item: { canonicalMediaId: number }) =>
          item.canonicalMediaId === unknown.id ||
          item.canonicalMediaId === seriesId
      ),
      false
    );

    const combined = await request(app)
      .get(
        '/library?collectionMembership=in&watchlist=yes&sort=title&sortDirection=asc'
      )
      .set('x-test-role', 'admin');
    assert.equal(combined.status, 200);
    assert.deepEqual(
      combined.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [completedMovieId]
    );
    assert.equal(combined.body.collectionMembershipUnknownCount, 0);

    const availableWithMember = await request(app)
      .get(
        `/library/user-availability?collectionMembership=in&watchlist=yes&userIds=${secondUser.id}`
      )
      .set('x-test-role', 'admin');
    assert.equal(
      availableWithMember.body.users.find(
        (user: { id: number }) => user.id === secondUser.id
      )?.available,
      true
    );
    const unavailableWithoutMember = await request(app)
      .get(
        `/library/user-availability?collectionMembership=none&watchlist=yes&userIds=${secondUser.id}`
      )
      .set('x-test-role', 'admin');
    assert.equal(
      unavailableWithoutMember.body.users.find(
        (user: { id: number }) => user.id === secondUser.id
      )?.available,
      false
    );

    const candidate = await request(candidateApp)
      .get('/library?collectionMembership=in&sort=title&sortDirection=asc')
      .set('x-test-role', 'admin');
    const legacy = await request(app)
      .get('/library?collectionMembership=in&sort=title&sortDirection=asc')
      .set('x-test-role', 'admin');
    assert.equal(candidate.status, 200);
    assert.deepEqual(candidate.body, legacy.body);

    const seriesOnly = await request(app)
      .get('/library?collectionMembership=any&mediaType=series')
      .set('x-test-role', 'admin');
    assert.deepEqual(
      seriesOnly.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [seriesId]
    );
  });

  it('uses durable CONFIRMED Movie evidence in Archive while excluding stale current state', async () => {
    await closeLibraryMedia(completedMovieId);
    const archive = await request(app)
      .get('/library?scope=archive&search=completed movie')
      .set('x-test-role', 'admin');
    assert.equal(archive.body.results.length, 1);
    assert.deepEqual(
      archive.body.results[0].watchedUsers.map(
        (viewer: { displayName: string; watchedPercentage: number }) => [
          viewer.displayName,
          viewer.watchedPercentage,
        ]
      ),
      [['Moni', 100]]
    );
    assert.equal(archive.body.results[0].addedAt, '2026-01-10T00:00:00.000Z');
    assert.equal(archive.body.results[0].logicalSizeBytes, null);
    assert.deepEqual(
      archive.body.results[0].watchlistUsers.map(
        (user: { displayName: string }) => user.displayName
      ),
      ['Bogdan']
    );
    assert.equal(
      (
        await request(app)
          .get('/library?scope=current&search=completed movie')
          .set('x-test-role', 'admin')
      ).body.results.length,
      0
    );
  });

  it('defensively ignores persisted exact-epoch activity without losing completion or legitimate old dates', async () => {
    await closeLibraryMedia(completedMovieId);
    const evidence = await getRepository(ViewingEvidence).findOneByOrFail({
      canonicalMediaId: completedMovieId,
      completionClassification: ViewingCompletionClassification.CONFIRMED,
    });
    evidence.observedAt = new Date(0);
    evidence.observedEndAt = new Date(0);
    await getRepository(ViewingEvidence).save(evidence);
    let archive = await request(app)
      .get('/library?scope=archive&search=completed movie')
      .set('x-test-role', 'admin');
    assert.equal(archive.body.results[0].watchedUsers.length, 1);
    assert.equal(archive.body.results[0].lastActiveAt, null);

    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'native',
        sourceActivityId: 'legitimate-pre-epoch-activity',
        sourceUserId: adminViewer.sourceUserId,
        sourceItemId: jellyfinMovieId(101),
        viewerId: adminViewer.id,
        canonicalMediaId: completedMovieId,
        completionClassification: ViewingCompletionClassification.PARTIAL,
        observedAt: new Date('1969-12-31T23:00:00.000Z'),
        observedEndAt: new Date('1969-12-31T23:30:00.000Z'),
      })
    );
    archive = await request(app)
      .get('/library?scope=archive&search=completed movie')
      .set('x-test-role', 'admin');
    assert.equal(
      archive.body.results[0].lastActiveAt,
      '1969-12-31T23:30:00.000Z'
    );
  });

  it('derives native Archive membership from a retained file when managed presence remains current', async () => {
    const presences = await getRepository(LibraryPresence).findBy({
      canonicalMediaId: completedMovieId,
      isCurrent: true,
    });
    for (const presence of presences) {
      presence.servarrHasFile = false;
      presence.jellyfinVisible = false;
    }
    await getRepository(LibraryPresence).save(presences);
    const file = await getRepository(LibraryFile)
      .createQueryBuilder('file')
      .innerJoin('file.libraryPresence', 'presence')
      .where('presence.canonicalMediaId = :canonicalMediaId', {
        canonicalMediaId: completedMovieId,
      })
      .getOneOrFail();
    file.isCurrent = false;
    file.removedAt = new Date('2026-05-01T00:00:00.000Z');
    await getRepository(LibraryFile).save(file);

    const archive = await request(app)
      .get('/library?scope=archive&search=completed movie')
      .set('x-test-role', 'admin');
    assert.equal(archive.body.results.length, 1);
    assert.equal(archive.body.results[0].addedAt, '2026-01-10T00:00:00.000Z');
    assert.equal(archive.body.results[0].logicalSizeBytes, null);
  });

  it('keeps partial-only Archive Movie activity out of Watched and outlives mutable state', async () => {
    await closeLibraryMedia(partialMovieId);
    const archive = await request(app)
      .get('/library?scope=archive&search=spy among friends')
      .set('x-test-role', 'admin');
    assert.equal(archive.body.results.length, 1);
    assert.deepEqual(archive.body.results[0].watchedUsers, []);
    assert.equal(
      archive.body.results[0].lastActiveAt,
      '2026-02-15T12:00:00.000Z'
    );
    assert.deepEqual(
      archive.body.results[0].lastActiveUsers.map(
        (user: { displayName: string }) => user.displayName
      ),
      ['Moni']
    );
    assert.equal(archive.body.results[0].logicalSizeBytes, null);
  });

  it('makes Current win over historical generations and keeps All canonically unique', async () => {
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: completedMovieId,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceItemId: 'movie-101-old-generation',
        sourceGeneration: 'old',
        addedAt: new Date('2020-01-01T00:00:00.000Z'),
        firstObservedAt: new Date('2020-01-01T00:00:00.000Z'),
        removedAt: new Date('2021-01-01T00:00:00.000Z'),
        removalSource: LibraryRemovalSource.MANUAL,
        servarrHasFile: false,
        isCurrent: false,
      })
    );
    await getRepository(CurrentViewingState).update(
      {
        viewerId: adminViewer.id,
        sourceScope: 'jf',
        sourceItemId: jellyfinMovieId(101),
      },
      { played: false, progressBasisPoints: 0 }
    );
    const current = await request(app)
      .get('/library?scope=current&search=completed movie')
      .set('x-test-role', 'admin');
    const archive = await request(app)
      .get('/library?scope=archive&search=completed movie')
      .set('x-test-role', 'admin');
    const all = await request(app)
      .get('/library?scope=all&search=completed movie')
      .set('x-test-role', 'admin');
    assert.equal(current.body.results.length, 1);
    assert.equal(current.body.results[0].removedAt, null);
    assert.equal(current.body.results[0].removalSource, null);
    assert.deepEqual(current.body.results[0].watchedUsers, []);
    assert.equal(archive.body.results.length, 0);
    assert.equal(all.body.results.length, 1);
    assert.deepEqual(all.body.results[0].watchedUsers, []);
    assert.equal(all.body.results[0].removedAt, null);
    assert.equal(all.body.results[0].removalSource, null);
    assert.equal(
      (
        await getRepository(LibraryPresence).findOneByOrFail({
          sourceItemId: 'movie-101-old-generation',
        })
      ).removalSource,
      LibraryRemovalSource.MANUAL
    );
    assert.equal(
      await getRepository(ViewingEvidence).countBy({
        canonicalMediaId: completedMovieId,
        completionClassification: ViewingCompletionClassification.CONFIRMED,
      }),
      1
    );
  });

  it('pairs Added, Removed, and source from the terminal physical tenure across scopes', async () => {
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Generation Pairing Fixture',
      })
    );
    const addEndedPresence = async ({
      sourceScope,
      sourceGeneration,
      addedAt,
      removedAt,
      removalSource,
    }: {
      sourceScope: string;
      sourceGeneration: string;
      addedAt: string;
      removedAt: string;
      removalSource: LibraryRemovalSource;
    }) => {
      const presence = await getRepository(LibraryPresence).save(
        new LibraryPresence({
          canonicalMediaId: canonical.id,
          sourceSystem: 'radarr',
          sourceScope,
          sourceItemId: `movie:${sourceGeneration}`,
          sourceGeneration,
          addedAt: new Date(addedAt),
          firstObservedAt: new Date(addedAt),
          removedAt: new Date(removedAt),
          removalSource,
          servarrHasFile: false,
          isCurrent: false,
        })
      );
      await getRepository(LibraryFile).save(
        new LibraryFile({
          libraryPresenceId: presence.id,
          sourceSystem: 'radarr',
          sourceScope,
          sourceFileId: `movie-file:${sourceGeneration}`,
          sourceGeneration,
          importedAt: new Date(addedAt),
          firstObservedAt: new Date(addedAt),
          removedAt: new Date(removedAt),
          removalSource,
          isCurrent: false,
        })
      );
    };
    await addEndedPresence({
      sourceScope: 'service:1',
      sourceGeneration: '1',
      addedAt: '2020-01-01T00:00:00.000Z',
      removedAt: '2021-01-01T00:00:00.000Z',
      removalSource: LibraryRemovalSource.MANUAL,
    });
    await addEndedPresence({
      sourceScope: 'service:2',
      sourceGeneration: '2',
      addedAt: '2024-02-03T00:00:00.000Z',
      removedAt: '2025-04-05T00:00:00.000Z',
      removalSource: LibraryRemovalSource.SCHEDULED,
    });
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: canonical.id,
        sourceSystem: 'jellyfin',
        sourceScope: 'jf',
        sourceItemId: 'movie:generation-pairing',
        sourceGeneration: '1',
        addedAt: new Date('2019-01-01T00:00:00.000Z'),
        firstObservedAt: new Date('2019-01-01T00:00:00.000Z'),
        removedAt: new Date('2026-01-01T00:00:00.000Z'),
        removalSource: LibraryRemovalSource.EXTERNAL,
        jellyfinVisible: false,
        isCurrent: false,
      })
    );

    const query = () =>
      request(app)
        .get('/library?scope=archive&search=generation pairing fixture')
        .set('x-test-role', 'admin');
    const first = await query();
    const second = await query();
    assert.equal(first.body.results.length, 1);
    assert.equal(first.body.results[0].addedAt, '2024-02-03T00:00:00.000Z');
    assert.equal(first.body.results[0].removedAt, '2025-04-05T00:00:00.000Z');
    assert.equal(
      first.body.results[0].removalSource,
      LibraryRemovalSource.SCHEDULED
    );
    assert.deepEqual(first.body.results[0], second.body.results[0]);
  });

  it('projects removed Series from retained historical files with confirmed-only Season detail', async () => {
    const firstEpisode = await getRepository(CanonicalEpisode)
      .createQueryBuilder('episode')
      .innerJoinAndSelect('episode.season', 'season')
      .where('season.seriesId = :seriesId', { seriesId })
      .andWhere('season.seasonNumber = 1')
      .andWhere('episode.episodeNumber = 1')
      .getOneOrFail();
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'history',
        sourceActivityId: 'underground-e1-partial',
        viewerId: adminViewer.id,
        viewer: adminViewer,
        canonicalMediaId: seriesId,
        canonicalEpisodeId: firstEpisode.id,
        observedAt: new Date('2026-03-20T12:00:00.000Z'),
        progressBasisPoints: 5000,
        completionClassification: ViewingCompletionClassification.PARTIAL,
      })
    );
    const historicalPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: seriesId,
        sourceSystem: 'sonarr',
        sourceScope: '2',
        sourceItemId: 'series-80039-old-generation',
        sourceGeneration: 'old',
        addedAt: new Date('2024-01-01T00:00:00.000Z'),
        firstObservedAt: new Date('2024-01-01T00:00:00.000Z'),
        removedAt: new Date('2025-01-01T00:00:00.000Z'),
        servarrHasFile: false,
        isCurrent: false,
      })
    );
    const duplicateFile = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: historicalPresence.id,
        sourceSystem: 'sonarr',
        sourceScope: '2',
        sourceFileId: 'duplicate-e1',
        sourceGeneration: 'old',
        sizeBytes: String(1024 ** 3),
        importedAt: new Date('2024-01-01T00:00:00.000Z'),
        firstObservedAt: new Date('2024-01-01T00:00:00.000Z'),
        removedAt: new Date('2025-01-01T00:00:00.000Z'),
        isCurrent: false,
      })
    );
    await getRepository(LibraryFileEpisode).save(
      new LibraryFileEpisode({
        libraryFileId: duplicateFile.id,
        canonicalEpisodeId: firstEpisode.id,
      })
    );
    await closeLibraryMedia(seriesId);

    const archive = await request(app)
      .get('/library?scope=archive&search=underground railroad')
      .set('x-test-role', 'admin');
    const series = archive.body.results[0];
    assert.deepEqual(
      series.watchedUsers.map(
        (viewer: {
          displayName: string;
          watchedEpisodeCount: number;
          availableEpisodeCount: number;
          watchedPercentage: number;
        }) => [
          viewer.displayName,
          viewer.watchedEpisodeCount,
          viewer.availableEpisodeCount,
          viewer.watchedPercentage,
        ]
      ),
      [['Moni', 9, 10, 90]]
    );
    assert.equal(series.hasWatchedDetail, true);
    assert.equal(series.logicalSizeBytes, null);
    assert.equal(series.lastActiveAt, '2026-03-20T12:00:00.000Z');
    assert.equal(series.removedAt, '2026-05-01T00:00:00.000Z');
    assert.equal(series.removalSource, LibraryRemovalSource.UNKNOWN);

    const detail = await request(app)
      .get(`/library/${seriesId}/series-detail`)
      .set('x-test-role', 'admin');
    const regular = detail.body.seasons.find(
      (season: { seasonNumber: number }) => season.seasonNumber === 1
    );
    assert.equal(regular.availableEpisodeCount, 10);
    assert.equal(regular.sizeBytes, String(11 * 1024 ** 3));
    assert.equal(regular.removedAt, '2026-05-01T00:00:00.000Z');
    assert.equal(regular.removalSource, LibraryRemovalSource.UNKNOWN);
    assert.deepEqual(
      regular.users.map(
        (viewer: {
          displayName: string;
          watchedEpisodeCount: number;
          watchedPercentage: number;
        }) => [
          viewer.displayName,
          viewer.watchedEpisodeCount,
          viewer.watchedPercentage,
        ]
      ),
      [['Moni', 9, 90]]
    );
    const special = detail.body.seasons.find(
      (season: { isSpecial: boolean }) => season.isSpecial
    );
    assert.equal(special.availableEpisodeCount, 1);
    assert.equal(special.sizeBytes, String(512 * 1024 ** 2));
    assert.deepEqual(
      special.users.map(
        (viewer: { displayName: string }) => viewer.displayName
      ),
      ['Moni']
    );
  });

  it('suppresses Archive Series detail when retained Episodes have no confirmed watches', async () => {
    await closeLibraryMedia(seriesId);
    await getRepository(ViewingEvidence).delete({ canonicalMediaId: seriesId });
    const episode = await getRepository(CanonicalEpisode)
      .createQueryBuilder('episode')
      .innerJoin('episode.season', 'season')
      .where('season.seriesId = :seriesId', { seriesId })
      .andWhere('season.seasonNumber = 1')
      .andWhere('episode.episodeNumber = 1')
      .getOneOrFail();
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'history',
        sourceActivityId: 'archive-series-partial-only',
        viewerId: adminViewer.id,
        viewer: adminViewer,
        canonicalMediaId: seriesId,
        canonicalEpisodeId: episode.id,
        observedAt: new Date('2026-03-20T12:00:00.000Z'),
        progressBasisPoints: 4000,
        completionClassification: ViewingCompletionClassification.PARTIAL,
      })
    );
    const archive = await request(app)
      .get('/library?scope=archive&search=underground railroad')
      .set('x-test-role', 'admin');
    assert.deepEqual(archive.body.results[0].watchedUsers, []);
    assert.equal(archive.body.results[0].hasWatchedDetail, false);
    assert.equal(
      archive.body.results[0].lastActiveAt,
      '2026-03-20T12:00:00.000Z'
    );
  });

  it('applies Archive search, watched, user, Watchlist, null sorting, and pagination before enrichment', async () => {
    await closeLibraryMedia(completedMovieId);
    await closeLibraryMedia(partialMovieId);
    const watched = await request(app)
      .get('/library?scope=archive&watched=yes&sort=added&sortDirection=asc')
      .set('x-test-role', 'admin');
    assert.deepEqual(
      watched.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [completedMovieId]
    );
    const partialByUser = await request(app)
      .get(
        `/library?scope=archive&watched=no&userId=${adminViewer.userId}&search=spy among friends`
      )
      .set('x-test-role', 'admin');
    assert.deepEqual(
      partialByUser.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [partialMovieId]
    );
    const watchlisted = await request(app)
      .get('/library?scope=archive&watchlist=yes')
      .set('x-test-role', 'admin');
    assert.deepEqual(
      watchlisted.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [completedMovieId]
    );
    const page = await request(app)
      .get('/library?scope=archive&sort=size&sortDirection=desc&take=1&skip=1')
      .set('x-test-role', 'admin');
    assert.equal(page.body.pageInfo.results, 3);
    assert.equal(page.body.results.length, 1);
    assert.equal(page.body.results[0].logicalSizeBytes, null);
  });

  it('does not infer physical Archive membership from imported viewing history alone', async () => {
    secondUser.jellyfinUserId = 'private-second-id';
    await getRepository(User).save(secondUser);
    await historicalDataImport.import(
      createWholphinHistoryArtifact({
        schema: 'wholphin-history-v1',
        jellyfinServerScope: 'jf',
        coverage: {},
        viewers: [
          { id: 'viewer:imported', jellyfinUserId: 'private-second-id' },
        ],
        media: [
          {
            id: 'media:imported',
            mediaType: 'movie',
            title: 'Imported Archive Movie',
            year: 2019,
            identities: [
              { provider: 'tmdb', sourceScope: '', value: '991001' },
              {
                provider: 'jellyfin',
                sourceScope: 'jf',
                value: 'imported-movie-item',
              },
            ],
          },
        ],
        seasons: [],
        episodes: [],
        libraryFacts: [
          {
            id: 'presence:imported',
            mediaId: 'media:imported',
            jellyfinItemId: 'imported-movie-item',
            addedAt: '2019-02-03T00:00:00.000Z',
          },
        ],
        viewingFacts: [
          {
            id: 'activity:imported',
            viewerId: 'viewer:imported',
            mediaId: 'media:imported',
            jellyfinItemId: 'imported-movie-item',
            sourceClass: 'historical-session',
            observedAt: '2020-01-01T00:00:00.000Z',
            observedEndAt: '2020-01-01T01:30:00.000Z',
            playbackDurationSeconds: 5400,
            completion: 'confirmed',
          },
        ],
      })
    );
    const archive = await request(app)
      .get('/library?scope=archive&search=imported archive movie')
      .set('x-test-role', 'admin');
    assert.equal(archive.body.pageInfo.results, 0);
    assert.deepEqual(archive.body.results, []);
  });

  it('returns current physical Movie facts without Retention or private source data', async () => {
    const response = await request(app)
      .get('/library?search=completed movie&sort=title&sortDirection=asc')
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.results.length, 1);
    const movie = response.body.results[0];
    assert.equal(movie.canonicalMediaId, completedMovieId);
    assert.equal(movie.removedAt, null);
    assert.equal(movie.removalSource, null);
    assert.equal(movie.logicalSizeBytes, String(10 * 1024 ** 3));
    assert.deepEqual(
      movie.watchlistUsers.map(
        (user: { displayName: string }) => user.displayName
      ),
      ['Bogdan']
    );
    assert.deepEqual(movie.watchedUsers, [
      {
        key: `user:1`,
        userId: 1,
        displayName: 'Moni',
        avatar: '/avatar/moni',
        watchedEpisodeCount: null,
        availableEpisodeCount: null,
        watchedPercentage: 100,
        lastViewedAt: '2026-03-01T12:00:00.000Z',
      },
    ]);
    assert.equal(movie.hasWatchedDetail, false);
    assert.equal('viewingUsers' in movie, false);
    const serialized = JSON.stringify(response.body);
    for (const forbidden of [
      'retention',
      'reason',
      'private-admin-id',
      'private-second-id',
      '@example.test',
      'pathSnapshot',
      'sourceActivityId',
    ])
      assert.equal(
        serialized.toLowerCase().includes(forbidden.toLowerCase()),
        false
      );
  });

  it('lets active current unplayed override historical completion only in current Watched', async () => {
    await getRepository(CurrentViewingState).update(
      {
        viewerId: adminViewer.id,
        sourceScope: 'jf',
        sourceItemId: jellyfinMovieId(101),
      },
      {
        played: false,
        progressBasisPoints: 0,
        observedAt: new Date('2026-03-06T12:00:00.000Z'),
      }
    );
    await getRepository(CurrentViewingState).save(
      new CurrentViewingState({
        viewerId: secondViewer.id,
        viewer: secondViewer,
        sourceScope: 'jf',
        sourceItemId: jellyfinMovieId(101),
        mediaType: 'movie',
        canonicalMediaId: completedMovieId,
        played: true,
        progressBasisPoints: 10_000,
        lastPlayedAt: new Date('2026-03-05T12:00:00.000Z'),
        observedAt: new Date('2026-03-05T12:00:00.000Z'),
      })
    );
    const response = await request(app)
      .get('/library?search=completed movie')
      .set('x-test-role', 'admin');
    assert.deepEqual(
      response.body.results[0].watchedUsers.map(
        (viewer: { displayName: string; watchedPercentage: number }) => [
          viewer.displayName,
          viewer.watchedPercentage,
        ]
      ),
      [['Bogdan', 100]]
    );
    const watchedByMoni = await request(app)
      .get(`/library?watched=yes&userId=${adminViewer.userId}`)
      .set('x-test-role', 'admin');
    assert.equal(
      watchedByMoni.body.results.some(
        (item: { canonicalMediaId: number }) =>
          item.canonicalMediaId === completedMovieId
      ),
      false
    );
    const watchedByBogdan = await request(app)
      .get(`/library?watched=yes&userId=${secondViewer.userId}`)
      .set('x-test-role', 'admin');
    assert.equal(
      watchedByBogdan.body.results.some(
        (item: { canonicalMediaId: number }) =>
          item.canonicalMediaId === completedMovieId
      ),
      true
    );
    assert.equal(
      await getRepository(ViewingEvidence).countBy({
        canonicalMediaId: completedMovieId,
        completionClassification: ViewingCompletionClassification.CONFIRMED,
      }),
      1
    );
  });

  it('keeps partial and LIKELY Movie activity out of Watched without losing Last active or evidence', async () => {
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'history',
        sourceActivityId: 'historical-partial-bogdan',
        viewerId: secondViewer.id,
        viewer: secondViewer,
        canonicalMediaId: partialMovieId,
        observedAt: new Date('2026-02-20T12:00:00.000Z'),
        progressBasisPoints: 2500,
        playbackDurationSeconds: 300,
        completionClassification: ViewingCompletionClassification.PARTIAL,
      })
    );
    const response = await request(app)
      .get('/library?search=spy among friends')
      .set('x-test-role', 'admin');
    const movie = response.body.results[0];
    assert.equal(movie.canonicalMediaId, partialMovieId);
    assert.deepEqual(movie.watchedUsers, []);
    assert.equal(movie.lastActiveAt, '2026-03-02T12:00:00.000Z');
    assert.deepEqual(
      movie.lastActiveUsers.map(
        (user: { displayName: string }) => user.displayName
      ),
      ['Bogdan']
    );
    assert.equal(
      await getRepository(ViewingEvidence).countBy({
        canonicalMediaId: partialMovieId,
      }),
      2
    );
  });

  it('does not substitute a newer unattributed Last active timestamp for a watched user timestamp', async () => {
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'manual',
        sourceScope: 'history',
        sourceClass: 'historical-manual-activity',
        sourceActivityId: 'completed-movie-unattributed-activity',
        canonicalMediaId: completedMovieId,
        observedAt: new Date('2026-03-09T15:30:00.000Z'),
        completionClassification: ViewingCompletionClassification.UNKNOWN,
      })
    );

    const response = await request(app)
      .get('/library?search=completed movie')
      .set('x-test-role', 'admin');
    const movie = response.body.results[0];
    assert.equal(movie.lastActiveAt, '2026-03-09T15:30:00.000Z');
    assert.deepEqual(movie.lastActiveUsers, []);
    assert.equal(
      movie.watchedUsers[0].lastViewedAt,
      '2026-03-01T12:00:00.000Z'
    );
  });

  it('attributes every linked user tied at the authoritative Last active timestamp', async () => {
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'history',
        sourceActivityId: 'last-active-tie-moni',
        viewerId: adminViewer.id,
        viewer: adminViewer,
        canonicalMediaId: partialMovieId,
        observedAt: new Date('2026-03-02T12:00:00.000Z'),
        progressBasisPoints: 100,
        completionClassification: ViewingCompletionClassification.PARTIAL,
      })
    );

    const response = await request(app)
      .get('/library?search=spy among friends')
      .set('x-test-role', 'admin');
    const movie = response.body.results[0];
    assert.equal(movie.lastActiveAt, '2026-03-02T12:00:00.000Z');
    assert.deepEqual(
      movie.lastActiveUsers.map((user: { id: number; displayName: string }) => [
        user.id,
        user.displayName,
      ]),
      [
        [adminViewer.userId, 'Moni'],
        [secondViewer.userId, 'Bogdan'],
      ]
    );
  });

  it('keeps a newer unattributed authoritative timestamp without borrowing an older user', async () => {
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'manual',
        sourceScope: 'history',
        sourceClass: 'historical-manual-activity',
        sourceActivityId: 'unattributed-last-active',
        canonicalMediaId: partialMovieId,
        observedAt: new Date('2026-03-04T12:00:00.000Z'),
        completionClassification: ViewingCompletionClassification.UNKNOWN,
      })
    );

    const response = await request(app)
      .get('/library?search=spy among friends')
      .set('x-test-role', 'admin');
    const movie = response.body.results[0];
    assert.equal(movie.lastActiveAt, '2026-03-04T12:00:00.000Z');
    assert.deepEqual(movie.lastActiveUsers, []);
  });

  it('projects authoritative Series percentages and Season-first detail while omitting partial-only users', async () => {
    const response = await request(app)
      .get('/library?search=underground railroad')
      .set('x-test-role', 'admin');
    const series = response.body.results[0];
    assert.equal(series.canonicalMediaId, seriesId);
    assert.equal(series.hasWatchedDetail, true);
    assert.equal(series.lastActiveAt, '2026-03-12T12:00:00.000Z');
    assert.deepEqual(
      series.lastActiveUsers.map(
        (user: { displayName: string }) => user.displayName
      ),
      ['Moni']
    );
    assert.deepEqual(
      series.watchedUsers.map(
        (viewer: {
          displayName: string;
          watchedEpisodeCount: number;
          availableEpisodeCount: number;
          watchedPercentage: number;
        }) => [
          viewer.displayName,
          viewer.watchedEpisodeCount,
          viewer.availableEpisodeCount,
          viewer.watchedPercentage,
        ]
      ),
      [
        ['Bogdan', 3, 10, 30],
        ['Moni', 9, 10, 90],
      ]
    );
    assert.deepEqual(
      series.watchedUsers.map(
        (viewer: { displayName: string; lastViewedAt: string | null }) => [
          viewer.displayName,
          viewer.lastViewedAt,
        ]
      ),
      [
        ['Bogdan', '2026-03-05T12:00:00.000Z'],
        ['Moni', '2026-03-12T12:00:00.000Z'],
      ]
    );
    const detail = await request(app)
      .get(`/library/${seriesId}/series-detail`)
      .set('x-test-role', 'admin');
    assert.equal(detail.status, 200);
    assert.equal('viewers' in detail.body, false);
    const regularSeason = detail.body.seasons.find(
      (season: { seasonNumber: number }) => season.seasonNumber === 1
    );
    assert.deepEqual(
      regularSeason.users.map(
        (viewer: { displayName: string; lastViewedAt: string | null }) => [
          viewer.displayName,
          viewer.lastViewedAt,
        ]
      ),
      [
        ['Bogdan', '2026-03-05T12:00:00.000Z'],
        ['Moni', '2026-03-10T12:00:00.000Z'],
      ]
    );
    assert.equal(regularSeason.availableEpisodeCount, 10);
    assert.deepEqual(
      regularSeason.users.map(
        (viewer: {
          displayName: string;
          watchedEpisodeCount: number;
          watchedPercentage: number;
        }) => [
          viewer.displayName,
          viewer.watchedEpisodeCount,
          viewer.watchedPercentage,
        ]
      ),
      [
        ['Bogdan', 3, 30],
        ['Moni', 9, 90],
      ]
    );
    const specialSeason = detail.body.seasons.find(
      (season: { isSpecial: boolean }) => season.isSpecial
    );
    assert.equal(specialSeason.availableEpisodeCount, 1);
    assert.deepEqual(
      specialSeason.users.map(
        (viewer: { displayName: string; watchedPercentage: number }) => [
          viewer.displayName,
          viewer.watchedPercentage,
        ]
      ),
      [['Moni', 100]]
    );
  });

  it('derives expandability from Season Watched content, including Specials but excluding partial-only activity', async () => {
    const media = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.SERIES,
        titleSnapshot: 'Expansion Detail Series',
        year: 2026,
      })
    );
    await addIdentity(media, 999001);
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: media.id,
        sourceSystem: 'jellyfin',
        sourceScope: 'jf',
        sourceItemId: `series:${jellyfinMovieId(999001)}`,
        firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
        jellyfinVisible: true,
        isCurrent: true,
      })
    );
    const presence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: media.id,
        sourceSystem: 'sonarr',
        sourceScope: '2',
        sourceItemId: 'series-expansion-detail',
        addedAt: new Date('2026-01-01T00:00:00.000Z'),
        firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
        servarrHasFile: true,
        isCurrent: true,
      })
    );
    const addPhysicalEpisode = async (
      seasonNumber: number,
      episodeNumber: number,
      isSpecial: boolean
    ) => {
      const season = await getRepository(CanonicalSeason).save(
        new CanonicalSeason({ seriesId: media.id, seasonNumber })
      );
      const episode = await getRepository(CanonicalEpisode).save(
        new CanonicalEpisode({
          seasonId: season.id,
          episodeNumber,
          isSpecial,
        })
      );
      const jellyfinItemId = (900000 + seasonNumber * 1000 + episodeNumber)
        .toString(16)
        .padStart(32, '0');
      await getRepository(CanonicalEpisodeIdentity).save(
        new CanonicalEpisodeIdentity({
          canonicalEpisodeId: episode.id,
          provider: 'jellyfin',
          sourceScope: 'jf',
          value: jellyfinItemId,
          lastSeenSourceGeneration: jellyfinLibraryGeneration,
        })
      );
      const file = await getRepository(LibraryFile).save(
        new LibraryFile({
          libraryPresenceId: presence.id,
          sourceSystem: 'sonarr',
          sourceScope: '2',
          sourceFileId: `expansion-s${seasonNumber}e${episodeNumber}`,
          sizeBytes: String(1024 ** 3),
          importedAt: new Date('2026-01-01T00:00:00.000Z'),
          firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
          isCurrent: true,
        })
      );
      await getRepository(LibraryFileEpisode).save(
        new LibraryFileEpisode({
          libraryFileId: file.id,
          canonicalEpisodeId: episode.id,
        })
      );
      return { episode, jellyfinItemId };
    };
    const regular = await addPhysicalEpisode(1, 1, false);
    await getRepository(CurrentViewingState).save(
      new CurrentViewingState({
        viewerId: adminViewer.id,
        viewer: adminViewer,
        sourceScope: 'jf',
        sourceItemId: regular.jellyfinItemId,
        mediaType: 'episode',
        canonicalMediaId: media.id,
        canonicalEpisodeId: regular.episode.id,
        played: false,
        progressBasisPoints: 5000,
        lastPlayedAt: new Date('2026-02-01T00:00:00.000Z'),
        observedAt: new Date('2026-02-01T00:00:00.000Z'),
      })
    );

    const partialOnly = await request(app)
      .get('/library?search=expansion detail series')
      .set('x-test-role', 'admin');
    assert.equal(partialOnly.body.results[0].hasWatchedDetail, false);
    assert.deepEqual(partialOnly.body.results[0].watchedUsers, []);
    const emptyDetail = await request(app)
      .get(`/library/${media.id}/series-detail`)
      .set('x-test-role', 'admin');
    assert.equal(
      emptyDetail.body.seasons.some(
        (season: { users: unknown[] }) => season.users.length > 0
      ),
      false
    );

    const special = await addPhysicalEpisode(0, 1, true);
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'current',
        sourceActivityId: 'expansion-special-confirmed',
        viewerId: adminViewer.id,
        viewer: adminViewer,
        canonicalMediaId: media.id,
        canonicalEpisodeId: special.episode.id,
        observedAt: new Date('2026-02-02T00:00:00.000Z'),
        completionClassification: ViewingCompletionClassification.CONFIRMED,
      })
    );
    await getRepository(CurrentViewingState).save(
      new CurrentViewingState({
        viewerId: adminViewer.id,
        viewer: adminViewer,
        sourceScope: 'jf',
        sourceItemId: special.jellyfinItemId,
        mediaType: 'episode',
        canonicalMediaId: media.id,
        canonicalEpisodeId: special.episode.id,
        played: true,
        progressBasisPoints: 10000,
        lastPlayedAt: new Date('2026-02-02T00:00:00.000Z'),
        observedAt: new Date('2026-02-02T00:00:00.000Z'),
      })
    );
    const specialOnly = await request(app)
      .get('/library?search=expansion detail series')
      .set('x-test-role', 'admin');
    assert.deepEqual(specialOnly.body.results[0].watchedUsers, []);
    assert.equal(specialOnly.body.results[0].hasWatchedDetail, true);
    const topLevelWatched = await request(app)
      .get('/library?search=expansion detail series&watched=yes')
      .set('x-test-role', 'admin');
    assert.deepEqual(topLevelWatched.body.results, []);
    const usefulDetail = await request(app)
      .get(`/library/${media.id}/series-detail`)
      .set('x-test-role', 'admin');
    assert.equal(
      usefulDetail.body.seasons.some(
        (season: { users: unknown[] }) => season.users.length > 0
      ),
      true
    );
  });

  it('keeps Watchlist and Watched independent and supports Any/Yes/No user scoping', async () => {
    const watchlisted = await request(app)
      .get('/library?watchlist=yes')
      .set('x-test-role', 'admin');
    assert.deepEqual(
      watchlisted.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [completedMovieId]
    );
    const watched = await request(app)
      .get('/library?watched=yes')
      .set('x-test-role', 'admin');
    assert.deepEqual(
      new Set(
        watched.body.results.map(
          (item: { canonicalMediaId: number }) => item.canonicalMediaId
        )
      ),
      new Set([completedMovieId, seriesId])
    );
    const notWatched = await request(app)
      .get('/library?watched=no')
      .set('x-test-role', 'admin');
    assert.deepEqual(
      notWatched.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [partialMovieId]
    );
    const byUser = await request(app)
      .get(`/library?userId=${secondUser.id}`)
      .set('x-test-role', 'admin');
    assert.deepEqual(
      new Set(
        byUser.body.results.map(
          (item: { canonicalMediaId: number }) => item.canonicalMediaId
        )
      ),
      new Set([completedMovieId, partialMovieId, seriesId])
    );
    const watchedByUser = await request(app)
      .get(`/library?watched=yes&userId=${secondUser.id}`)
      .set('x-test-role', 'admin');
    assert.deepEqual(
      watchedByUser.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [seriesId]
    );
    const notWatchedByUser = await request(app)
      .get(`/library?watched=no&userId=${secondUser.id}`)
      .set('x-test-role', 'admin');
    assert.deepEqual(
      new Set(
        notWatchedByUser.body.results.map(
          (item: { canonicalMediaId: number }) => item.canonicalMediaId
        )
      ),
      new Set([completedMovieId, partialMovieId])
    );
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    await getRepository(Watchlist).save(
      new Watchlist({
        ratingKey: '102',
        mediaType: MediaType.MOVIE,
        title: 'A Spy Among Friends',
        tmdbId: 102,
        requestedBy: admin,
      })
    );
    const multiUserWatchlist = await request(app)
      .get(`/library?watchlist=yes&userIds=1,${secondUser.id}`)
      .set('x-test-role', 'admin');
    assert.deepEqual(
      new Set(
        multiUserWatchlist.body.results.map(
          (item: { canonicalMediaId: number }) => item.canonicalMediaId
        )
      ),
      new Set([completedMovieId, partialMovieId])
    );
    const multiUserWatched = await request(app)
      .get(`/library?watched=yes&userIds=1,${secondUser.id}`)
      .set('x-test-role', 'admin');
    assert.deepEqual(
      new Set(
        multiUserWatched.body.results.map(
          (item: { canonicalMediaId: number }) => item.canonicalMediaId
        )
      ),
      new Set([completedMovieId, seriesId])
    );
    const inactiveUsers = await request(app)
      .get(`/library?userIds=${secondUser.id}`)
      .set('x-test-role', 'admin');
    assert.equal(inactiveUsers.body.pageInfo.results, 3);
    for (const sort of ['title', 'added', 'lastActive', 'size']) {
      const sorted = await request(app)
        .get(`/library?sort=${sort}&sortDirection=asc&take=1&skip=1`)
        .set('x-test-role', 'admin');
      assert.equal(sorted.status, 200, sort);
      assert.equal(sorted.body.pageInfo.results, 3, sort);
      assert.equal(sorted.body.results.length, 1, sort);
    }
    const movies = await request(app)
      .get('/library?mediaType=movie')
      .set('x-test-role', 'admin');
    assert.ok(
      movies.body.results.every(
        (item: { mediaType: string }) => item.mediaType === 'movie'
      )
    );
  });

  it('supports strict multiword, literal-plus, and unmatched searches', async () => {
    for (const search of ['spy', 'a%20spy', 'A%20Spy%20Among%20Friends']) {
      const response = await request(app)
        .get(`/library?search=${search}`)
        .set('x-test-role', 'admin');
      assert.equal(response.status, 200, search);
      assert.deepEqual(
        response.body.results.map(
          (item: { canonicalMediaId: number }) => item.canonicalMediaId
        ),
        [partialMovieId],
        search
      );
    }
    for (const search of ['a%20%2B%20spy', 'no%20such%20library%20title']) {
      const response = await request(app)
        .get(`/library?search=${search}`)
        .set('x-test-role', 'admin');
      assert.equal(response.status, 200, search);
      assert.deepEqual(response.body.results, [], search);
    }
  });

  it('filters durable request history by typed media identity and selected users', async () => {
    const requestedMedia = await getRepository(Media).save(
      new Media({ mediaType: MediaType.MOVIE, tmdbId: 102 })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        status: MediaRequestStatus.COMPLETED,
        media: requestedMedia,
        requestedBy: secondUser,
        type: MediaType.MOVIE,
      })
    );
    const requested = await request(app)
      .get('/library?requested=yes')
      .set('x-test-role', 'admin');
    assert.equal(requested.status, 200);
    assert.deepEqual(
      requested.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [partialMovieId]
    );
    const selected = await request(app)
      .get(`/library?requested=yes&userIds=${secondUser.id}`)
      .set('x-test-role', 'admin');
    assert.deepEqual(
      selected.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [partialMovieId]
    );
    const otherUser = await request(app)
      .get('/library?requested=yes&userIds=1')
      .set('x-test-role', 'admin');
    assert.deepEqual(otherUser.body.results, []);
    const notRequested = await request(app)
      .get('/library?requested=no')
      .set('x-test-role', 'admin');
    assert.deepEqual(
      new Set(
        notRequested.body.results.map(
          (item: { canonicalMediaId: number }) => item.canonicalMediaId
        )
      ),
      new Set([completedMovieId, seriesId])
    );
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    const otherRequestedMedia = await getRepository(Media).save(
      new Media({ mediaType: MediaType.MOVIE, tmdbId: 101 })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        status: MediaRequestStatus.DECLINED,
        media: otherRequestedMedia,
        requestedBy: admin,
        type: MediaType.MOVIE,
      })
    );
    const multiUser = await request(app)
      .get(`/library?requested=yes&userIds=1,${secondUser.id}`)
      .set('x-test-role', 'admin');
    assert.deepEqual(
      new Set(
        multiUser.body.results.map(
          (item: { canonicalMediaId: number }) => item.canonicalMediaId
        )
      ),
      new Set([completedMovieId, partialMovieId])
    );
  });

  it('projects distinct requesters with complete standard, 4K, and Season request facts', async () => {
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    const requestedMedia = await getRepository(Media).save(
      new Media({ mediaType: MediaType.TV, tmdbId: 80039 })
    );
    const standard = await getRepository(MediaRequest).save(
      new MediaRequest({
        status: MediaRequestStatus.COMPLETED,
        media: requestedMedia,
        requestedBy: secondUser,
        type: MediaType.TV,
        is4k: false,
        isAutoRequest: true,
        createdAt: new Date('2025-01-02T03:04:05.000Z'),
      })
    );
    await getRepository(MediaRequest).update(standard.id, {
      status: MediaRequestStatus.APPROVED,
    });
    await getRepository(SeasonRequest).save(
      new SeasonRequest({
        request: standard,
        seasonNumber: 1,
        status: MediaRequestStatus.COMPLETED,
        createdAt: new Date('2025-01-02T03:04:06.000Z'),
      })
    );
    await getRepository(MediaRequest).save([
      new MediaRequest({
        status: MediaRequestStatus.COMPLETED,
        media: requestedMedia,
        requestedBy: secondUser,
        type: MediaType.TV,
        is4k: true,
        createdAt: new Date('2025-02-03T04:05:06.000Z'),
      }),
      new MediaRequest({
        status: MediaRequestStatus.DECLINED,
        media: requestedMedia,
        requestedBy: admin,
        type: MediaType.TV,
        is4k: false,
        createdAt: new Date('2025-03-04T05:06:07.000Z'),
      }),
    ]);

    const response = await request(app)
      .get('/library?search=underground railroad')
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200);
    const { requesters } = response.body.results[0];
    assert.deepEqual(
      requesters.map((requester: { id: number }) => requester.id),
      [admin.id, secondUser.id]
    );
    const bogdan = requesters.find(
      (requester: { id: number }) => requester.id === secondUser.id
    );
    assert.deepEqual(
      bogdan.requests.map(
        (requestFact: {
          type: string;
          status: number;
          is4k: boolean;
          isAutoRequest: boolean;
          createdAt: string;
        }) => [
          requestFact.type,
          requestFact.status,
          requestFact.is4k,
          requestFact.isAutoRequest,
          requestFact.createdAt,
        ]
      ),
      [
        [
          MediaType.TV,
          MediaRequestStatus.APPROVED,
          false,
          true,
          '2025-01-02T03:04:05.000Z',
        ],
        [
          MediaType.TV,
          MediaRequestStatus.COMPLETED,
          true,
          false,
          '2025-02-03T04:05:06.000Z',
        ],
      ]
    );
    assert.deepEqual(
      bogdan.requests[0].seasons.map(
        (seasonFact: {
          seasonNumber: number;
          status: number;
          createdAt: string;
        }) => [seasonFact.seasonNumber, seasonFact.status, seasonFact.createdAt]
      ),
      [[1, MediaRequestStatus.COMPLETED, '2025-01-02T03:04:06.000Z']]
    );
    const moni = requesters.find(
      (requester: { id: number }) => requester.id === admin.id
    );
    assert.deepEqual(
      moni.requests.map((requestFact: { status: number; is4k: boolean }) => [
        requestFact.status,
        requestFact.is4k,
      ]),
      [[MediaRequestStatus.DECLINED, false]]
    );
    const requestability = new Map<number, boolean>(
      response.body.results[0].seasonSummaries.map(
        (season: { seasonNumber: number; requestable: boolean }) => [
          season.seasonNumber,
          season.requestable,
        ]
      )
    );
    assert.equal(requestability.get(1), true);
    assert.equal(requestability.has(0), false);
  });

  it('reports independent unpaginated per-user availability without applying the current user selection', async () => {
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    admin.includeInUserMetrics = true;
    secondUser.includeInUserMetrics = true;
    await getRepository(User).save([admin, secondUser]);

    const response = await request(app)
      .get(`/library?watchlist=yes&userIds=${admin.id}&take=1`)
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.pageInfo.results, 0);
    assert.equal('users' in response.body, false);
    const usersResponse = await request(app)
      .get(
        `/library/user-availability?watchlist=yes&userIds=${admin.id}&take=1`
      )
      .set('x-test-role', 'admin');
    assert.equal(usersResponse.status, 200);
    const availability = new Map(
      usersResponse.body.users.map(
        (user: { id: number; available: boolean }) => [user.id, user.available]
      )
    );
    assert.equal(availability.get(admin.id), false);
    assert.equal(availability.get(secondUser.id), true);

    const noCandidates = await request(app)
      .get(
        '/library/user-availability?watchlist=yes&search=no-such-library-title&take=1'
      )
      .set('x-test-role', 'admin');
    assert.equal(noCandidates.status, 200);
    assert.equal(
      noCandidates.body.users.every(
        (user: { available: boolean }) => user.available === false
      ),
      true
    );
  });

  it('filters Added and factual activity ranges before pagination', async () => {
    const response = await request(app)
      .get(
        '/library?addedFrom=2026-02-01&addedTo=2026-02-28&activity=present&activityFrom=2026-03-02&activityTo=2026-03-02&take=1'
      )
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.pageInfo.results, 1);
    assert.deepEqual(
      response.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [partialMovieId]
    );
    const neverActive = await request(app)
      .get('/library?activity=none')
      .set('x-test-role', 'admin');
    assert.deepEqual(neverActive.body.results, []);
  });

  it('uses inclusive UTC calendar-day bounds for single, open, and combined date ranges', async () => {
    const endOfJune = await addCurrentMovie(
      'UTC End Of June',
      901,
      1024,
      '2026-06-30T23:59:59.999Z'
    );
    const startOfJuly = await addCurrentMovie(
      'UTC Start Of July',
      902,
      1024,
      '2026-07-01T00:00:00.000Z'
    );

    const ids = async (query: string) => {
      const response = await request(app)
        .get(`/library?${query}`)
        .set('x-test-role', 'admin');
      assert.equal(response.status, 200, query);
      return response.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      );
    };

    assert.deepEqual(await ids('addedFrom=2026-06-30&addedTo=2026-06-30'), [
      endOfJune.id,
    ]);
    assert.deepEqual(await ids('addedFrom=2026-07-01'), [startOfJuly.id]);
    assert.equal(
      (await ids('addedTo=2026-06-30')).includes(endOfJune.id),
      true
    );
    assert.equal(
      (await ids('addedTo=2026-06-30')).includes(startOfJuly.id),
      false
    );

    assert.deepEqual(
      await ids('activityFrom=2026-03-02&activityTo=2026-03-02'),
      [partialMovieId]
    );
    assert.deepEqual(await ids('activityTo=2026-03-01'), [completedMovieId]);
    assert.deepEqual(
      new Set(await ids('activityFrom=2026-03-02')),
      new Set([partialMovieId, seriesId])
    );
  });

  it('sorts watched-user counts using only users included in metrics', async () => {
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    admin.includeInUserMetrics = true;
    secondUser.includeInUserMetrics = true;
    await getRepository(User).save([admin, secondUser]);
    const withBoth = await request(app)
      .get('/library?sort=watchedUsers&sortDirection=desc')
      .set('x-test-role', 'admin');
    assert.equal(withBoth.body.results[0].canonicalMediaId, seriesId);
    assert.equal(withBoth.body.results[0].watchedUserCount, 2);
    secondUser.includeInUserMetrics = false;
    await getRepository(User).save(secondUser);
    const defaults = await request(app)
      .get('/library/user-availability?take=1')
      .set('x-test-role', 'admin');
    const defaultUserIds = defaults.body.users.map(
      (user: { id: number }) => user.id
    );
    assert.ok(defaultUserIds.includes(admin.id));
    assert.equal(defaultUserIds.includes(secondUser.id), false);
    const withoutExcluded = await request(app)
      .get('/library?sort=watchedUsers&sortDirection=desc')
      .set('x-test-role', 'admin');
    assert.equal(
      withoutExcluded.body.results[0].canonicalMediaId,
      completedMovieId
    );
    const series = withoutExcluded.body.results.find(
      (item: { canonicalMediaId: number }) => item.canonicalMediaId === seriesId
    );
    assert.equal(series.watchedUserCount, 1);
    assert.equal(series.watchedUsers.length, 2);
    const users = await request(app)
      .get(`/library/user-availability?userIds=${secondUser.id}`)
      .set('x-test-role', 'admin');
    assert.ok(
      users.body.users.some((user: { id: number }) => user.id === secondUser.id)
    );
  });

  it('filters by a safe storage-root identity without exposing its path', async () => {
    const root = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'radarr',
        serviceId: 1,
        sourceRootId: 7,
        nameSnapshot: 'Movies',
        pathSnapshot: '/private/movies',
        displayName: 'Primary Movies',
        color: '#60a5fa',
      })
    );
    const presence = await getRepository(LibraryPresence).findOneByOrFail({
      canonicalMediaId: completedMovieId,
      sourceSystem: 'radarr',
      isCurrent: true,
    });
    presence.storageRootId = root.id;
    await getRepository(LibraryPresence).save(presence);
    const secondRoot = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'radarr',
        serviceId: 1,
        sourceRootId: 8,
        nameSnapshot: 'Movies',
        pathSnapshot: '/private/more-movies',
        displayName: 'Movies Overflow',
        color: '#fb923c',
      })
    );
    const secondPresence = await getRepository(LibraryPresence).findOneByOrFail(
      {
        canonicalMediaId: partialMovieId,
        sourceSystem: 'radarr',
        isCurrent: true,
      }
    );
    secondPresence.storageRootId = secondRoot.id;
    await getRepository(LibraryPresence).save(secondPresence);
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: completedMovieId,
        sourceSystem: 'radarr',
        sourceScope: 'second-copy',
        sourceItemId: 'movie:101-copy',
        sourceGeneration: 'second-copy',
        storageRootId: secondRoot.id,
        firstObservedAt: new Date('2026-01-10T00:00:00.000Z'),
        servarrHasFile: true,
        isCurrent: true,
      })
    );
    const response = await request(app)
      .get(`/library?storageRootId=${root.id}`)
      .set('x-test-role', 'admin');
    assert.deepEqual(
      response.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [completedMovieId]
    );
    assert.deepEqual(response.body.storageLocations, [
      { id: secondRoot.id, label: 'Movies Overflow' },
      { id: root.id, label: 'Primary Movies' },
    ]);
    assert.deepEqual(response.body.results[0].storageRoots, [
      { id: secondRoot.id, label: 'Movies Overflow', color: '#fb923c' },
      { id: root.id, label: 'Primary Movies', color: '#60a5fa' },
    ]);
    const multi = await request(app)
      .get(`/library?storageRootIds=${root.id},${secondRoot.id}`)
      .set('x-test-role', 'admin');
    assert.deepEqual(
      new Set(
        multi.body.results.map(
          (item: { canonicalMediaId: number }) => item.canonicalMediaId
        )
      ),
      new Set([completedMovieId, partialMovieId])
    );
    assert.equal(
      JSON.stringify(response.body).includes('/private/movies'),
      false
    );
    assert.equal(
      JSON.stringify(response.body).includes('/private/more-movies'),
      false
    );
  });

  it('filters Animation by applicable stable roots with mixed-root and Current-wins semantics', async () => {
    const animationRoot = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'radarr',
        serviceId: 1,
        sourceRootId: 71,
        pathSnapshot: '/private/animation',
        isAnimation: true,
      })
    );
    const normalRoot = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'radarr',
        serviceId: 1,
        sourceRootId: 72,
        pathSnapshot: '/private/movies',
        isAnimation: false,
      })
    );
    const completedPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({
      canonicalMediaId: completedMovieId,
      sourceSystem: 'radarr',
      isCurrent: true,
    });
    completedPresence.storageRootId = animationRoot.id;
    await getRepository(LibraryPresence).save(completedPresence);
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: completedMovieId,
        sourceSystem: 'radarr',
        sourceScope: 'mixed-copy',
        sourceItemId: 'movie-101-normal-copy',
        sourceGeneration: 'mixed-copy',
        storageRootId: normalRoot.id,
        firstObservedAt: new Date('2026-01-11T00:00:00.000Z'),
        servarrHasFile: true,
        isCurrent: true,
      })
    );

    const partialPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({
      canonicalMediaId: partialMovieId,
      sourceSystem: 'radarr',
      isCurrent: true,
    });
    partialPresence.storageRootId = normalRoot.id;
    await getRepository(LibraryPresence).save(partialPresence);
    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: partialMovieId,
        sourceSystem: 'radarr',
        sourceScope: 'historical-animation',
        sourceItemId: 'movie-102-old-animation-copy',
        sourceGeneration: 'old-animation',
        storageRootId: animationRoot.id,
        firstObservedAt: new Date('2020-01-01T00:00:00.000Z'),
        removedAt: new Date('2021-01-01T00:00:00.000Z'),
        servarrHasFile: false,
        isCurrent: false,
      })
    );

    const removedPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({
      canonicalMediaId: removedMovieId,
      isCurrent: false,
    });
    removedPresence.storageRootId = animationRoot.id;
    await getRepository(LibraryPresence).save(removedPresence);

    const ids = async (query: string) => {
      const response = await request(app)
        .get(`/library?sort=title&sortDirection=asc&${query}`)
        .set('x-test-role', 'admin');
      assert.equal(response.status, 200, query);
      return {
        ids: response.body.results.map(
          (item: { canonicalMediaId: number }) => item.canonicalMediaId
        ),
        total: response.body.pageInfo.results,
      };
    };

    assert.deepEqual((await ids('scope=current&animation=yes')).ids, [
      completedMovieId,
    ]);
    assert.deepEqual(
      new Set((await ids('scope=current&animation=no')).ids),
      new Set([partialMovieId, seriesId])
    );
    assert.deepEqual((await ids('scope=archive&animation=yes')).ids, [
      removedMovieId,
    ]);
    assert.deepEqual(
      new Set((await ids('scope=all&animation=yes')).ids),
      new Set([completedMovieId, removedMovieId])
    );
    assert.deepEqual(
      new Set((await ids('scope=all&animation=no')).ids),
      new Set([partialMovieId, seriesId])
    );
    const bounded = await ids(
      'scope=all&mediaType=movie&animation=yes&take=1&skip=0'
    );
    assert.equal(bounded.ids.length, 1);
    assert.equal(bounded.total, 2);
  });

  it('falls back to canonical presentation when metadata enrichment fails', async () => {
    const result = await new LibraryService({
      fetchPresentation: async () => {
        throw new Error('provider unavailable');
      },
    }).query({
      take: 25,
      skip: 0,
      search: 'a spy among friends',
      watchlist: 'any',
      watched: 'any',
      sort: 'title',
      sortDirection: 'asc',
    });
    assert.equal(result.results[0].title, 'A Spy Among Friends');
    assert.equal(result.results[0].posterPath, null);
    assert.equal(result.results[0].backdropPath, null);
    assert.equal(result.results[0].collection, null);
  });

  it('batch-projects Fresh, TMDB rating, and truthful Current/Archive/known-missing Season summaries', async () => {
    const now = new Date('2026-04-01T00:00:00.000Z');
    await getRepository(FreshMedia).save(
      new FreshMedia({
        mediaType: 'movie',
        tmdbId: 101,
        active: true,
        firstSeenAt: now,
        lastSeenAt: now,
        resolvedAt: now,
        metadataRefreshedAt: now,
        displayTitle: 'The Completed Movie',
        sortTitle: 'completed movie',
      })
    );
    const relatedMedia = await getRepository(Media).save(
      new Media({
        mediaType: MediaType.MOVIE,
        tmdbId: 101,
        jellyfinMediaId: 'verified-jellyfin-item',
      })
    );
    const completedCanonical = await getRepository(
      CanonicalMedia
    ).findOneByOrFail({ id: completedMovieId });
    completedCanonical.currentMediaId = relatedMedia.id;
    await getRepository(CanonicalMedia).save(completedCanonical);
    const knownMissing = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId, seasonNumber: 2 })
    );
    await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({
        seasonId: knownMissing.id,
        episodeNumber: 1,
        isSpecial: false,
      })
    );
    const archivedSeason = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId, seasonNumber: 3 })
    );
    const archivedEpisode = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({
        seasonId: archivedSeason.id,
        episodeNumber: 1,
        isSpecial: false,
      })
    );
    const archivedPresence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: seriesId,
        sourceSystem: 'sonarr',
        sourceScope: 'archive',
        sourceItemId: 'series:80039-archive',
        sourceGeneration: 'archive',
        firstObservedAt: new Date('2024-01-01T00:00:00.000Z'),
        removedAt: new Date('2025-01-01T00:00:00.000Z'),
        servarrHasFile: false,
        isCurrent: false,
      })
    );
    const archivedFile = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: archivedPresence.id,
        sourceSystem: 'sonarr',
        sourceScope: 'archive',
        sourceFileId: 'archived-season-3-episode-1',
        sourceGeneration: 'archive',
        firstObservedAt: new Date('2024-01-01T00:00:00.000Z'),
        removedAt: new Date('2025-01-01T00:00:00.000Z'),
        isCurrent: false,
      })
    );
    await getRepository(LibraryFileEpisode).save(
      new LibraryFileEpisode({
        libraryFileId: archivedFile.id,
        canonicalEpisodeId: archivedEpisode.id,
      })
    );
    const partiallyAvailableSeason = await getRepository(
      CanonicalSeason
    ).findOneByOrFail({ seriesId, seasonNumber: 1 });
    await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({
        seasonId: partiallyAvailableSeason.id,
        episodeNumber: 11,
        isSpecial: false,
      })
    );
    const duplicateSourceEpisode = await getRepository(
      CanonicalEpisode
    ).findOneByOrFail({
      seasonId: partiallyAvailableSeason.id,
      episodeNumber: 1,
    });
    assert.equal(
      await getRepository(CanonicalEpisodeIdentity).countBy({
        canonicalEpisodeId: duplicateSourceEpisode.id,
      }),
      2,
      'Sonarr and Jellyfin aliases must still count as one canonical Episode'
    );
    const unknownTotalSeason = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId, seasonNumber: 4 })
    );
    const unknownTotalEpisode = await getRepository(CanonicalEpisode).save(
      new CanonicalEpisode({
        seasonId: unknownTotalSeason.id,
        episodeNumber: 1,
        isSpecial: false,
      })
    );
    const currentSeriesPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({
      canonicalMediaId: seriesId,
      sourceSystem: 'sonarr',
      sourceScope: 'service:2',
      isCurrent: true,
    });
    const unknownTotalFile = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: currentSeriesPresence.id,
        sourceSystem: 'sonarr',
        sourceScope: '2',
        sourceFileId: 'unknown-total-season-4-episode-1',
        firstObservedAt: new Date('2026-01-01T00:00:00.000Z'),
        isCurrent: true,
      })
    );
    await getRepository(LibraryFileEpisode).save(
      new LibraryFileEpisode({
        libraryFileId: unknownTotalFile.id,
        canonicalEpisodeId: unknownTotalEpisode.id,
      })
    );

    const movie = await request(app)
      .get('/library?search=completed movie')
      .set('x-test-role', 'admin');
    assert.equal(movie.body.results[0].fresh, true);
    assert.equal(movie.body.results[0].backdropPath, '/backdrop-101.jpg');
    assert.deepEqual(movie.body.results[0].tmdbRating, {
      voteAverage: 7.5,
      voteCount: 100,
    });
    assert.deepEqual(movie.body.results[0].collection, {
      id: 501,
      name: 'The Completed Collection',
      posterPath: '/collection-poster.jpg',
      backdropPath: '/collection-backdrop.jpg',
    });
    assert.deepEqual(movie.body.results[0].seasonSummaries, []);
    assert.deepEqual(
      movie.body.results[0].externalLinks.map(
        (link: { service: string; label: string }) => [link.service, link.label]
      ),
      [['jellyfin', 'Jellyfin']]
    );
    assert.equal(
      movie.body.results[0].externalLinks[0].url.includes(
        'verified-jellyfin-item'
      ),
      true
    );
    assert.equal(
      JSON.stringify(movie.body.results[0].externalLinks).includes('apiKey'),
      false
    );

    const series = await request(app)
      .get('/library?search=underground railroad')
      .set('x-test-role', 'admin');
    const summaries = series.body.results[0].seasonSummaries;
    assert.equal(series.body.results[0].collection, null);
    assert.deepEqual(
      summaries.map(
        (season: {
          seasonNumber: number;
          state: string;
          availableEpisodeCount: number;
          knownEpisodeCount: number | null;
        }) => [
          season.seasonNumber,
          season.state,
          season.availableEpisodeCount,
          season.knownEpisodeCount,
        ]
      ),
      [
        [1, 'current', 10, 11],
        [2, 'known_missing', 0, null],
        [3, 'archive', 1, null],
        [4, 'current', 1, null],
      ]
    );
    assert.equal(summaries[0].key, `season:${seriesId}:1`);
    assert.equal(summaries[0].isSpecial, false);

    await closeLibraryMedia(completedMovieId);
    const archivedMovie = await request(app)
      .get('/library?scope=archive&search=completed movie')
      .set('x-test-role', 'admin');
    assert.deepEqual(archivedMovie.body.results[0].externalLinks, []);
  });

  it('filters and sorts Archive removal facts and exposes factual Library state', async () => {
    const response = await request(app)
      .get(
        '/library?scope=archive&removedFrom=2026-01-01&removedTo=2026-01-01&removalSources=unknown&sort=removed&sortDirection=desc'
      )
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [removedMovieId]
    );
    assert.equal(response.body.results[0].libraryState, 'archive');
    const multiSource = await request(app)
      .get('/library?scope=archive&removalSources=manual,unknown')
      .set('x-test-role', 'admin');
    assert.deepEqual(
      multiSource.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [removedMovieId]
    );
    const current = await request(app)
      .get('/library?scope=current&take=1')
      .set('x-test-role', 'admin');
    assert.equal(current.body.results[0].libraryState, 'current');
  });

  it('does not let an older partial observation override a fully completed Series', async () => {
    const episodes = await getRepository(CanonicalEpisode)
      .createQueryBuilder('episode')
      .innerJoinAndSelect('episode.season', 'season')
      .where('season.seriesId = :seriesId', { seriesId })
      .andWhere('season.seasonNumber = 1')
      .orderBy('episode.episodeNumber', 'ASC')
      .getMany();
    for (const episode of episodes.filter(
      (candidate) =>
        candidate.episodeNumber === 1 || candidate.episodeNumber >= 5
    )) {
      await getRepository(CurrentViewingState).save(
        new CurrentViewingState({
          viewerId: secondViewer.id,
          viewer: secondViewer,
          sourceScope: 'jf',
          sourceItemId: jellyfinEpisodeId(episode.episodeNumber),
          mediaType: 'episode',
          canonicalMediaId: seriesId,
          canonicalEpisodeId: episode.id,
          played: true,
          progressBasisPoints: 10_000,
          lastPlayedAt: new Date('2026-03-20T12:00:00.000Z'),
          observedAt: new Date('2026-03-20T12:00:00.000Z'),
        })
      );
    }
    await getRepository(ViewingEvidence).save(
      new ViewingEvidence({
        source: 'jellyfin',
        sourceScope: 'jf',
        sourceClass: 'history',
        sourceActivityId: 'bogdan-older-partial',
        viewerId: secondViewer.id,
        viewer: secondViewer,
        canonicalMediaId: seriesId,
        canonicalEpisodeId: episodes[1].id,
        observedAt: new Date('2026-02-01T12:00:00.000Z'),
        progressBasisPoints: 4000,
        playbackDurationSeconds: 600,
        completionClassification: ViewingCompletionClassification.PARTIAL,
      })
    );
    const response = await request(app)
      .get('/library?search=underground railroad')
      .set('x-test-role', 'admin');
    const bogdan = response.body.results[0].watchedUsers.find(
      (viewer: { displayName: string }) => viewer.displayName === 'Bogdan'
    );
    assert.equal(bogdan.watchedEpisodeCount, 10);
    assert.equal(bogdan.availableEpisodeCount, 10);
    assert.equal(bogdan.watchedPercentage, 100);
  });

  it('derives changing Series and Season denominators from distinct Episodes linked to current physical files', async () => {
    const presence = await getRepository(LibraryPresence).findOneByOrFail({
      canonicalMediaId: seriesId,
      sourceSystem: 'sonarr',
      isCurrent: true,
    });
    const season = await getRepository(CanonicalSeason).save(
      new CanonicalSeason({ seriesId, seasonNumber: 2 })
    );
    const episodes = await getRepository(CanonicalEpisode).save([
      new CanonicalEpisode({
        seasonId: season.id,
        episodeNumber: 1,
        isSpecial: false,
      }),
      new CanonicalEpisode({
        seasonId: season.id,
        episodeNumber: 2,
        isSpecial: false,
      }),
    ]);
    const multiEpisodeFile = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: presence.id,
        sourceSystem: 'sonarr',
        sourceScope: '2',
        sourceFileId: 'series-s02-multi-episode-file',
        sizeBytes: String(2 * 1024 ** 3),
        importedAt: new Date('2026-04-01T00:00:00.000Z'),
        firstObservedAt: new Date('2026-04-01T00:00:00.000Z'),
        isCurrent: true,
      })
    );
    await getRepository(LibraryFileEpisode).save(
      episodes.map(
        (episode) =>
          new LibraryFileEpisode({
            libraryFileId: multiEpisodeFile.id,
            canonicalEpisodeId: episode.id,
          })
      )
    );
    const replacedFile = await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: presence.id,
        sourceSystem: 'sonarr',
        sourceScope: '2',
        sourceFileId: 'series-s02-replaced-file',
        importedAt: new Date('2026-03-01T00:00:00.000Z'),
        firstObservedAt: new Date('2026-03-01T00:00:00.000Z'),
        removedAt: new Date('2026-03-15T00:00:00.000Z'),
        removalSource: LibraryRemovalSource.EXTERNAL,
        isCurrent: false,
      })
    );
    await getRepository(LibraryFileEpisode).save(
      new LibraryFileEpisode({
        libraryFileId: replacedFile.id,
        canonicalEpisodeId: episodes[0].id,
      })
    );
    await getRepository(CanonicalEpisodeIdentity).save(
      episodes.map(
        (episode, index) =>
          new CanonicalEpisodeIdentity({
            canonicalEpisodeId: episode.id,
            provider: 'jellyfin',
            sourceScope: 'jf',
            value: jellyfinEpisodeId(index + 1, 2),
            lastSeenSourceGeneration: jellyfinLibraryGeneration,
          })
      )
    );
    await getRepository(CurrentViewingState).save(
      new CurrentViewingState({
        viewerId: adminViewer.id,
        viewer: adminViewer,
        sourceScope: 'jf',
        sourceItemId: jellyfinEpisodeId(1, 2),
        mediaType: 'episode',
        canonicalMediaId: seriesId,
        canonicalEpisodeId: episodes[0].id,
        played: true,
        progressBasisPoints: 10_000,
        lastPlayedAt: new Date('2026-04-02T12:00:00.000Z'),
        observedAt: new Date('2026-04-02T12:00:00.000Z'),
      })
    );

    const response = await request(app)
      .get('/library?search=underground railroad')
      .set('x-test-role', 'admin');
    const moni = response.body.results[0].watchedUsers.find(
      (viewer: { displayName: string }) => viewer.displayName === 'Moni'
    );
    assert.deepEqual(
      [
        moni.watchedEpisodeCount,
        moni.availableEpisodeCount,
        moni.watchedPercentage,
      ],
      [10, 12, 83]
    );
    const detail = await request(app)
      .get(`/library/${seriesId}/series-detail`)
      .set('x-test-role', 'admin');
    const secondSeason = detail.body.seasons.find(
      (candidate: { seasonNumber: number }) => candidate.seasonNumber === 2
    );
    assert.equal(secondSeason.availableEpisodeCount, 2);
    assert.equal(
      secondSeason.sizeBytes,
      String(2 * 1024 ** 3),
      'a multi-episode file contributes to the Season size exactly once'
    );
    assert.equal(secondSeason.removedAt, null);
    assert.equal(secondSeason.removalSource, null);
    assert.deepEqual(
      secondSeason.users.map(
        (viewer: {
          displayName: string;
          watchedEpisodeCount: number;
          watchedPercentage: number;
        }) => [
          viewer.displayName,
          viewer.watchedEpisodeCount,
          viewer.watchedPercentage,
        ]
      ),
      [['Moni', 1, 50]]
    );
  });

  it('enriches only the selected database page', async () => {
    const enriched: number[][] = [];
    class PageProbeService extends LibraryService {
      protected override async loadFacts(
        rows: { canonicalMediaId: string | number }[],
        canonicalIds: number[]
      ): Promise<PageFacts> {
        enriched.push(canonicalIds);
        assert.deepEqual(
          canonicalIds,
          rows.map((row) => Number(row.canonicalMediaId))
        );
        return {
          states: [],
          evidence: [],
          episodes: [],
          watchlists: [],
          requesters: new Map(),
        };
      }
    }
    const result = await new PageProbeService({
      fetchPresentation: async (_mediaType, tmdbId) => ({
        title: `Title ${tmdbId}`,
        year: null,
        posterPath: null,
        backdropPath: null,
      }),
    }).query({
      take: 1,
      skip: 1,
      watchlist: 'any',
      watched: 'any',
      sort: 'title',
      sortDirection: 'asc',
    });
    assert.equal(result.pageInfo.results, 3);
    assert.equal(result.results.length, 1);
    assert.equal(enriched.length, 1);
    assert.equal(enriched[0].length, 1);
  });

  it('locks the cross-feature SQL optimization parity matrix', async () => {
    const admin = await getRepository(User).findOneByOrFail({ id: 1 });
    admin.includeInUserMetrics = true;
    secondUser.includeInUserMetrics = true;
    await getRepository(User).save([admin, secondUser]);

    const requestedMedia = await getRepository(Media).save(
      new Media({ mediaType: MediaType.MOVIE, tmdbId: 102 })
    );
    await getRepository(MediaRequest).save(
      new MediaRequest({
        status: MediaRequestStatus.COMPLETED,
        media: requestedMedia,
        requestedBy: secondUser,
        type: MediaType.MOVIE,
      })
    );

    const root = await getRepository(StorageRoot).save(
      new StorageRoot({
        servarrType: 'radarr',
        serviceId: 1,
        sourceRootId: 77,
        nameSnapshot: 'Parity Root',
        pathSnapshot: '/private/parity',
        displayName: 'Parity Storage',
        isAnimation: true,
      })
    );
    const partialPresence = await getRepository(
      LibraryPresence
    ).findOneByOrFail({
      canonicalMediaId: partialMovieId,
      sourceSystem: 'radarr',
    });
    partialPresence.storageRootId = root.id;
    await getRepository(LibraryPresence).save(partialPresence);

    await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: completedMovieId,
        sourceSystem: 'radarr',
        sourceScope: 'old-service',
        sourceItemId: 'movie-101-parity-old-generation',
        sourceGeneration: 'old',
        addedAt: new Date('2020-01-01T00:00:00.000Z'),
        firstObservedAt: new Date('2020-01-01T00:00:00.000Z'),
        removedAt: new Date('2021-01-01T00:00:00.000Z'),
        removalSource: LibraryRemovalSource.MANUAL,
        servarrHasFile: false,
        isCurrent: false,
      })
    );

    const scheduled = await request(app)
      .post(`/library/${completedMovieId}/removal-schedules`)
      .set('x-test-role', 'admin')
      .send({ targetType: 'movie' });
    assert.equal(scheduled.status, 201);

    const get = async (query: string) => {
      const response = await request(app)
        .get(`/library?${query}`)
        .set('x-test-role', 'admin');
      assert.equal(response.status, 200, query);
      const candidate = await request(candidateApp)
        .get(`/library?${query}`)
        .set('x-test-role', 'admin');
      assert.equal(candidate.status, 200, `candidate: ${query}`);
      assert.deepEqual(
        response.body,
        candidate.body,
        `candidate parity: ${query}`
      );
      return response.body;
    };
    const ids = async (query: string) =>
      (await get(query)).results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      );

    const matrix: [string, number[]][] = [
      [
        'scope=current&sort=title&sortDirection=asc&take=2&skip=0',
        [partialMovieId, completedMovieId],
      ],
      ['scope=current&sort=title&sortDirection=asc&take=2&skip=2', [seriesId]],
      ['scope=archive&sort=removed&sortDirection=desc', [removedMovieId]],
      [
        'scope=all&sort=title&sortDirection=asc',
        [partialMovieId, removedMovieId, completedMovieId, seriesId],
      ],
      [
        'scope=current&mediaType=movie&sort=title&sortDirection=asc',
        [partialMovieId, completedMovieId],
      ],
      [
        'scope=current&mediaType=series&sort=title&sortDirection=asc',
        [seriesId],
      ],
      [
        'scope=current&watchlist=yes&sort=title&sortDirection=asc',
        [completedMovieId],
      ],
      [
        'scope=current&watched=yes&sort=title&sortDirection=asc',
        [completedMovieId, seriesId],
      ],
      [
        'scope=current&watched=no&sort=title&sortDirection=asc',
        [partialMovieId],
      ],
      [
        'scope=current&requested=yes&sort=title&sortDirection=asc',
        [partialMovieId],
      ],
      [
        'scope=current&activity=present&sort=lastActive&sortDirection=desc',
        [seriesId, partialMovieId, completedMovieId],
      ],
      [
        'scope=current&scheduled=yes&sort=title&sortDirection=asc',
        [completedMovieId],
      ],
      [
        `scope=current&storageRootIds=${root.id}&sort=title&sortDirection=asc`,
        [partialMovieId],
      ],
      [
        'scope=current&animation=yes&sort=title&sortDirection=asc',
        [partialMovieId],
      ],
      [
        'scope=current&animation=no&sort=title&sortDirection=asc',
        [completedMovieId, seriesId],
      ],
      [
        `scope=current&watchlist=yes&userIds=${secondUser.id}&sort=title&sortDirection=asc`,
        [completedMovieId],
      ],
      [
        `scope=current&watched=yes&userIds=${secondUser.id}&sort=title&sortDirection=asc`,
        [seriesId],
      ],
      [
        `scope=current&requested=yes&userIds=${secondUser.id}&sort=title&sortDirection=asc`,
        [partialMovieId],
      ],
      [
        `scope=current&watchlist=yes&watched=yes&userIds=${secondUser.id}&sort=title&sortDirection=asc`,
        [],
      ],
      [
        'scope=current&addedFrom=2026-01-01&addedTo=2026-01-31&sort=title&sortDirection=asc',
        [completedMovieId],
      ],
      [
        'scope=current&activityFrom=2026-03-12&activityTo=2026-03-12&sort=title&sortDirection=asc',
        [seriesId],
      ],
      [
        'scope=current&sort=added&sortDirection=asc',
        [seriesId, completedMovieId, partialMovieId],
      ],
      [
        'scope=current&sort=size&sortDirection=desc',
        [seriesId, completedMovieId, partialMovieId],
      ],
      [
        'scope=current&sort=watchedUsers&sortDirection=desc',
        [seriesId, completedMovieId, partialMovieId],
      ],
    ];
    for (const [query, expected] of matrix)
      assert.deepEqual(await ids(query), expected, query);

    const firstPage = await get(
      'scope=current&sort=title&sortDirection=asc&take=2&skip=0'
    );
    const secondPage = await get(
      'scope=current&sort=title&sortDirection=asc&take=2&skip=2'
    );
    assert.deepEqual(firstPage.pageInfo, {
      pages: 2,
      page: 1,
      results: 3,
      pageSize: 2,
    });
    assert.deepEqual(secondPage.pageInfo, {
      pages: 2,
      page: 2,
      results: 3,
      pageSize: 2,
    });

    const projection = await get(
      'scope=all&sort=title&sortDirection=asc&take=100'
    );
    const byId = new Map<number, LibraryItem>(
      projection.results.map((item: LibraryItem) => [
        item.canonicalMediaId,
        item,
      ])
    );
    const summarize = (canonicalMediaId: number) => {
      const item = byId.get(canonicalMediaId);
      assert.ok(item);
      return {
        libraryState: item.libraryState,
        addedAt: item.addedAt,
        removedAt: item.removedAt,
        removalSource: item.removalSource,
        logicalSizeBytes: item.logicalSizeBytes,
        lastActiveAt: item.lastActiveAt,
        watchedUserCount: item.watchedUserCount,
        watchlistUsers: item.watchlistUsers.map(
          (user: { displayName: string }) => user.displayName
        ),
        watchedUsers: item.watchedUsers.map(
          (user: {
            displayName: string;
            watchedEpisodeCount: number | null;
            availableEpisodeCount: number | null;
            watchedPercentage: number;
          }) => [
            user.displayName,
            user.watchedEpisodeCount,
            user.availableEpisodeCount,
            user.watchedPercentage,
          ]
        ),
        seasonSummaries: item.seasonSummaries.map(
          (season: {
            seasonNumber: number;
            state: string;
            availableEpisodeCount: number;
            knownEpisodeCount: number | null;
          }) => [
            season.seasonNumber,
            season.state,
            season.availableEpisodeCount,
            season.knownEpisodeCount,
          ]
        ),
        removalSchedules: (item.removalSchedules ?? []).map(
          (schedule: {
            targetType: string;
            seasonNumber: number | null;
            origin: string;
            status: string;
          }) => [
            schedule.targetType,
            schedule.seasonNumber,
            schedule.origin,
            schedule.status,
          ]
        ),
      };
    };
    assert.deepEqual(summarize(completedMovieId), {
      libraryState: 'current',
      addedAt: '2026-01-10T00:00:00.000Z',
      removedAt: null,
      removalSource: null,
      logicalSizeBytes: String(10 * 1024 ** 3),
      lastActiveAt: '2026-03-01T12:00:00.000Z',
      watchedUserCount: 1,
      watchlistUsers: ['Bogdan'],
      watchedUsers: [['Moni', null, null, 100]],
      seasonSummaries: [],
      removalSchedules: [['movie', null, 'manual', 'active']],
    });
    assert.deepEqual(summarize(partialMovieId), {
      libraryState: 'current',
      addedAt: '2026-02-10T00:00:00.000Z',
      removedAt: null,
      removalSource: null,
      logicalSizeBytes: String(5 * 1024 ** 3),
      lastActiveAt: '2026-03-02T12:00:00.000Z',
      watchedUserCount: 0,
      watchlistUsers: [],
      watchedUsers: [],
      seasonSummaries: [],
      removalSchedules: [],
    });
    assert.deepEqual(summarize(seriesId), {
      libraryState: 'current',
      addedAt: '2025-12-01T00:00:00.000Z',
      removedAt: null,
      removalSource: null,
      logicalSizeBytes: String(10.5 * 1024 ** 3),
      lastActiveAt: '2026-03-12T12:00:00.000Z',
      watchedUserCount: 2,
      watchlistUsers: [],
      watchedUsers: [
        ['Bogdan', 3, 10, 30],
        ['Moni', 9, 10, 90],
      ],
      seasonSummaries: [[1, 'current', 10, 10]],
      removalSchedules: [],
    });
    assert.deepEqual(summarize(removedMovieId), {
      libraryState: 'archive',
      addedAt: null,
      removedAt: '2026-01-01T00:00:00.000Z',
      removalSource: 'unknown',
      logicalSizeBytes: null,
      lastActiveAt: null,
      watchedUserCount: 0,
      watchlistUsers: [],
      watchedUsers: [],
      seasonSummaries: [],
      removalSchedules: [],
    });

    const detail = await request(app)
      .get(`/library/${seriesId}/series-detail`)
      .set('x-test-role', 'admin');
    assert.equal(detail.status, 200);
    assert.deepEqual(
      detail.body.seasons.map(
        (season: {
          seasonNumber: number;
          availableEpisodeCount: number;
          users: {
            displayName: string;
            watchedEpisodeCount: number;
            watchedPercentage: number;
          }[];
        }) => ({
          seasonNumber: season.seasonNumber,
          availableEpisodeCount: season.availableEpisodeCount,
          users: season.users.map((user) => [
            user.displayName,
            user.watchedEpisodeCount,
            user.watchedPercentage,
          ]),
        })
      ),
      [
        {
          seasonNumber: 0,
          availableEpisodeCount: 1,
          users: [['Moni', 1, 100]],
        },
        {
          seasonNumber: 1,
          availableEpisodeCount: 10,
          users: [
            ['Bogdan', 3, 30],
            ['Moni', 9, 90],
          ],
        },
      ]
    );
  });

  it('creates, projects, filters, and cancels one manual schedule without changing Library facts', async () => {
    const unauthorized = await request(app)
      .post(`/library/${completedMovieId}/removal-schedules`)
      .set('x-test-role', 'user')
      .send({ targetType: 'movie' });
    assert.equal(unauthorized.status, 403);

    const created = await request(app)
      .post(`/library/${completedMovieId}/removal-schedules`)
      .set('x-test-role', 'admin')
      .send({ targetType: 'movie' });
    assert.equal(created.status, 201);
    assert.equal(created.body.origin, 'manual');
    assert.equal(created.body.status, 'active');

    const duplicate = await request(app)
      .post(`/library/${completedMovieId}/removal-schedules`)
      .set('x-test-role', 'admin')
      .send({ targetType: 'movie' });
    assert.equal(duplicate.status, 201);
    assert.equal(duplicate.body.id, created.body.id);

    const scheduled = await request(app)
      .get('/library?scheduled=yes')
      .set('x-test-role', 'admin');
    assert.equal(scheduled.status, 200);
    assert.deepEqual(
      scheduled.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [completedMovieId]
    );
    assert.equal(scheduled.body.results[0].removalSchedules.length, 1);
    const unscheduled = await request(app)
      .get('/library?scheduled=no')
      .set('x-test-role', 'admin');
    assert.equal(unscheduled.body.pageInfo.results, 2);

    const dueDate = String(created.body.removeAt).slice(0, 10);
    const due = await request(app)
      .get(
        `/library?scope=current&removalDueFrom=${dueDate}&removalDueTo=${dueDate}`
      )
      .set('x-test-role', 'admin');
    assert.deepEqual(
      due.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [completedMovieId]
    );

    const unauthorizedCancel = await request(app)
      .delete(`/library/removal-schedules/${created.body.id}`)
      .set('x-test-role', 'user');
    assert.equal(unauthorizedCancel.status, 403);

    const leasedSchedule = await getRepository(RemovalSchedule).findOneByOrFail(
      { id: created.body.id }
    );
    leasedSchedule.leaseToken = 'processing';
    leasedSchedule.leaseUntil = new Date(Date.now() + 60_000);
    await getRepository(RemovalSchedule).save(leasedSchedule);
    const inProgress = await request(app)
      .delete(`/library/removal-schedules/${created.body.id}`)
      .set('x-test-role', 'admin');
    assert.equal(inProgress.status, 409);
    assert.equal(
      (
        await getRepository(RemovalSchedule).findOneByOrFail({
          id: created.body.id,
        })
      ).status,
      'active'
    );
    leasedSchedule.leaseToken = null;
    leasedSchedule.leaseUntil = null;
    await getRepository(RemovalSchedule).save(leasedSchedule);

    const cancelled = await request(app)
      .delete(`/library/removal-schedules/${created.body.id}`)
      .set('x-test-role', 'admin');
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, 'cancelled');

    const after = await request(app)
      .get('/library?scheduled=yes')
      .set('x-test-role', 'admin');
    assert.equal(after.body.pageInfo.results, 0);
    assert.equal(after.body.results.length, 0);
  });

  it('allows independent Season schedules and makes a whole-Series schedule supersede them', async () => {
    const seasonOne = await request(app)
      .post(`/library/${seriesId}/removal-schedules`)
      .set('x-test-role', 'admin')
      .send({ targetType: 'season', seasonNumber: 1 });
    const seasonTwo = await request(app)
      .post(`/library/${seriesId}/removal-schedules`)
      .set('x-test-role', 'admin')
      .send({ targetType: 'season', seasonNumber: 0 });
    assert.equal(seasonOne.status, 201);
    assert.equal(seasonTwo.status, 201);
    assert.notEqual(seasonOne.body.id, seasonTwo.body.id);
    const firstSchedule = await getRepository(RemovalSchedule).findOneByOrFail({
      id: seasonOne.body.id,
    });
    const secondSchedule = await getRepository(RemovalSchedule).findOneByOrFail(
      { id: seasonTwo.body.id }
    );
    firstSchedule.removeAt = new Date('2027-01-10T00:00:00.000Z');
    secondSchedule.removeAt = new Date('2027-02-10T00:00:00.000Z');
    await getRepository(RemovalSchedule).save([firstSchedule, secondSchedule]);
    const earliestDue = await request(app)
      .get(
        '/library?scope=current&removalDueFrom=2027-01-01&removalDueTo=2027-01-31'
      )
      .set('x-test-role', 'admin');
    assert.deepEqual(
      earliestDue.body.results.map(
        (item: { canonicalMediaId: number }) => item.canonicalMediaId
      ),
      [seriesId]
    );

    const wholeSeries = await request(app)
      .post(`/library/${seriesId}/removal-schedules`)
      .set('x-test-role', 'admin')
      .send({ targetType: 'series' });
    assert.equal(wholeSeries.status, 201);

    const detail = await request(app)
      .get(`/library/${seriesId}/series-detail`)
      .set('x-test-role', 'admin');
    assert.deepEqual(
      detail.body.removalSchedules.map(
        (schedule: { targetType: string }) => schedule.targetType
      ),
      ['series']
    );

    const conflictingSeason = await request(app)
      .post(`/library/${seriesId}/removal-schedules`)
      .set('x-test-role', 'admin')
      .send({ targetType: 'season', seasonNumber: 1 });
    assert.equal(conflictingSeason.status, 409);
  });
});
