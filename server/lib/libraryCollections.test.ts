import type {
  TmdbCollection,
  TmdbMovieDetails,
} from '@server/api/themoviedb/interfaces';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import { MediaStatus, MediaType } from '@server/constants/media';
import { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import { LibraryFile, LibraryPresence } from '@server/entity/LibraryHistory';
import Media from '@server/entity/Media';
import {
  LibraryCollectionsService,
  type LibraryCollectionsDependencies,
  type LibraryCollectionsQuery,
} from '@server/lib/libraryCollections';
import { classifyMovieLibraryStatusByTmdbIds } from '@server/lib/watchlistLibraryStatus';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const query: LibraryCollectionsQuery = {
  take: 20,
  skip: 0,
  completeness: 'all',
  sort: 'name',
  sortDirection: 'asc',
  locale: 'en',
};

const collection = (
  id: number,
  name: string,
  memberIds: number[]
): TmdbCollection =>
  ({
    id,
    name,
    overview: `${name} overview`,
    poster_path: `/${id}.jpg`,
    backdrop_path: `/${id}-backdrop.jpg`,
    parts: memberIds.map((memberId) => ({ id: memberId })),
  }) as TmdbCollection;

const createService = (
  dependencies: Partial<LibraryCollectionsDependencies>
): LibraryCollectionsService =>
  new LibraryCollectionsService({
    fetchMovie: async (id) => ({ id, status: 'Released' }) as TmdbMovieDetails,
    fetchPhysicalMovieIds: async () => new Set(),
    ...dependencies,
  });

const settle = async (
  service: LibraryCollectionsService,
  input: LibraryCollectionsQuery = query
) => {
  const pending = await service.query(input);
  assert.equal(pending.status, 'pending');
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const result = await service.query(input);
    if (result.status !== 'pending') return result;
  }
  throw new Error('Collection snapshot did not settle');
};

describe('Library collection discovery', () => {
  it('does not build a cold snapshot before hydration and retains last-good data while paused', async () => {
    let discoveries = 0;
    let collections = 0;
    const service = new LibraryCollectionsService(
      {
        discoverCollectionIds: async () => {
          discoveries++;
          return [770];
        },
        fetchCollection: async () => {
          collections++;
          return collection(770, 'Ready Collection', [771]);
        },
        fetchMovie: async (id) =>
          ({ id, status: 'Released' }) as TmdbMovieDetails,
        fetchPhysicalMovieIds: async () => new Set(),
        fetchAvailability: async () => new Map([[771, true]]),
      },
      false
    );
    assert.equal((await service.query(query)).status, 'pending');
    assert.equal(service.lookupById(770, 'en').availableMovies, null);
    assert.equal(discoveries, 0);
    assert.equal(collections, 0);
    service.setRefreshReady(true);
    assert.equal((await settle(service)).results[0].availableMovies, 1);
    service.setRefreshReady(false);
    const held = await service.query(query);
    assert.equal(held.status, 'partial');
    assert.equal(held.stale, true);
    assert.equal(held.results[0].availableMovies, 1);
    assert.equal(service.lookupById(770, 'en').countStale, true);
    assert.equal(collections, 1);
  });
  it('looks up authoritative counts by ID without rebuilding a warm snapshot', async () => {
    let collectionCalls = 0;
    const service = createService({
      discoverCollectionIds: async () => [770],
      fetchCollection: async () => {
        collectionCalls++;
        return collection(770, 'Lookup Collection', [771, 772]);
      },
      fetchAvailability: async () =>
        new Map([
          [771, true],
          [772, false],
        ]),
    });
    assert.equal(service.lookupById(770, 'en', false).availableMovies, null);
    await settle(service);
    const found = service.lookupById(770, 'en');
    assert.equal(found.availableMovies, 1);
    assert.equal(found.totalMovies, 2);
    assert.equal(found.countStatus, 'complete');
    assert.equal(found.countStale, false);
    assert.equal(service.lookupById(999, 'en').availableMovies, null);
    assert.equal(service.lookupById(770, 'ro', false).availableMovies, null);
    assert.equal(collectionCalls, 1);
  });

  it('reuses a snapshot before six hours and refreshes after the safety TTL', async () => {
    let now = new Date('2026-11-19T00:00:00.000Z');
    let collectionCalls = 0;
    const service = createService({
      discoverCollectionIds: async () => [775],
      fetchCollection: async () => {
        collectionCalls++;
        return collection(775, 'TTL Collection', [776]);
      },
      fetchAvailability: async () => new Map([[776, true]]),
      now: () => now,
      snapshotTtlMs: 6 * 60 * 60 * 1000,
    });
    await settle(service);
    now = new Date('2026-11-19T05:59:59.000Z');
    assert.equal((await service.query(query)).status, 'complete');
    assert.equal(collectionCalls, 1);
    now = new Date('2026-11-19T06:00:00.000Z');
    assert.equal((await service.query(query)).status, 'pending');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(collectionCalls, 2);
  });

  it('retains last-good counts when a member-status request fails after invalidation', async () => {
    let failMovie = false;
    const service = createService({
      discoverCollectionIds: async () => [780],
      fetchCollection: async () =>
        collection(780, 'Retained Collection', [781]),
      fetchMovie: async (id) => {
        if (failMovie) throw new Error('TMDb member failure');
        return { id, status: 'Released' } as TmdbMovieDetails;
      },
      fetchAvailability: async () => new Map([[781, true]]),
    });
    await settle(service);
    failMovie = true;
    service.invalidate();
    assert.equal(service.lookupById(780, 'en').availableMovies, 1);
    assert.equal(service.lookupById(780, 'en').countStale, true);
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      const state = await service.query(query);
      if (state.status === 'partial') {
        assert.equal(state.results[0].availableMovies, 1);
        assert.equal(service.lookupById(780, 'en').countStale, true);
        return;
      }
    }
    throw new Error('Partial collection refresh did not settle');
  });

  it('retries a missing collection without waiting for the six-hour snapshot TTL', async () => {
    let calls = 0;
    const service = createService({
      discoverCollectionIds: async () => [785],
      fetchCollection: async () => {
        calls++;
        if (calls === 1)
          throw Object.assign(new Error('missing collection'), {
            response: { status: 404 },
          });
        return collection(785, 'Recovered Collection', [786]);
      },
      fetchAvailability: async () => new Map([[786, true]]),
      missingCollectionRetryMs: 30,
      unavailableRetryMs: 10,
      snapshotTtlMs: 6 * 60 * 60 * 1000,
    });
    assert.equal((await settle(service)).status, 'unavailable');
    for (let attempt = 0; attempt < 50; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const state = await service.query(query);
      if (state.status === 'complete') {
        assert.equal(calls, 2);
        assert.equal(state.results[0].availableMovies, 1);
        return;
      }
    }
    throw new Error('Missing collection retry did not settle');
  });

  it('does not publish an older in-flight build after a new generation is requested', async () => {
    let releaseFirst!: (value: TmdbCollection) => void;
    const first = new Promise<TmdbCollection>((resolve) => {
      releaseFirst = resolve;
    });
    let fetches = 0;
    const service = createService({
      discoverCollectionIds: async () => [790],
      fetchCollection: async () => {
        fetches++;
        return fetches === 1
          ? first
          : collection(790, 'Current Collection', [791, 792]);
      },
      fetchAvailability: async () =>
        new Map([
          [791, true],
          [792, false],
        ]),
    });
    assert.equal((await service.query(query)).status, 'pending');
    service.invalidate();
    releaseFirst(collection(790, 'Old Collection', [791]));
    for (let attempt = 0; attempt < 30; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      const state = await service.query(query);
      if (state.status === 'complete') {
        assert.equal(fetches, 2);
        assert.equal(state.results[0].totalMovies, 2);
        assert.equal(service.lookupById(790, 'en').totalMovies, 2);
        return;
      }
    }
    throw new Error('Generation-safe collection refresh did not settle');
  });

  it('counts only Released or physically historical Movies and keeps one eligible member', async () => {
    const metadata = new Map([
      [40, collection(40, 'Mixed Collection', [401, 402, 403, 404])],
      [41, collection(41, 'Single Collection', [411])],
      [42, collection(42, 'Future Collection', [421])],
    ]);
    const statuses = new Map<number, string | null>([
      [401, 'Released'],
      [402, 'In Production'],
      [403, null],
      [404, 'Planned'],
      [411, 'Released'],
      [421, 'Post Production'],
    ]);
    const service = createService({
      discoverCollectionIds: async () => [40, 41, 42],
      fetchCollection: async (id) => metadata.get(id)!,
      fetchMovie: async (id) =>
        ({ id, status: statuses.get(id) ?? undefined }) as TmdbMovieDetails,
      fetchPhysicalMovieIds: async () => new Set([404]),
      fetchAvailability: async (ids) =>
        new Map(ids.map((id) => [id, id === 401 || id === 411])),
    });

    const result = await settle(service);
    assert.deepEqual(
      result.results.map((item) => [
        item.id,
        item.availableMovies,
        item.totalMovies,
      ]),
      [
        [40, 1, 2],
        [41, 1, 1],
      ]
    );
  });

  it('uses retained Library files only as a visibility override for historical members', async () => {
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Historical member',
      })
    );
    await getRepository(CanonicalMediaIdentity).save(
      new CanonicalMediaIdentity({
        canonicalMediaId: canonical.id,
        mediaType: LibraryMediaType.MOVIE,
        provider: 'tmdb',
        sourceScope: '',
        value: '991',
      })
    );
    const presence = await getRepository(LibraryPresence).save(
      new LibraryPresence({
        canonicalMediaId: canonical.id,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceItemId: 'historical-member',
        isCurrent: false,
        servarrHasFile: false,
        removedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
    );
    await getRepository(LibraryFile).save(
      new LibraryFile({
        libraryPresenceId: presence.id,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceFileId: 'historical-member-file',
        isCurrent: false,
        removedAt: new Date('2026-01-01T00:00:00.000Z'),
      })
    );
    assert.equal(
      (await classifyMovieLibraryStatusByTmdbIds([991])).get(991),
      'archived'
    );

    const service = new LibraryCollectionsService({
      discoverCollectionIds: async () => [99],
      fetchCollection: async () =>
        collection(99, 'Historical Collection', [991, 992]),
      fetchMovie: async (id) =>
        ({ id, status: 'In Production' }) as TmdbMovieDetails,
      fetchAvailability: async () => new Map(),
    });

    let result = await service.query(query);
    for (
      let attempt = 0;
      result.status === 'pending' && attempt < 20;
      attempt++
    ) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      result = await service.query(query);
    }
    assert.equal(result.status, 'complete', JSON.stringify(result));
    assert.deepEqual(
      result.results.map((item) => [item.id, item.totalMovies]),
      [[99, 1]]
    );
  });

  it('discovers distinct confirmed collections from current Movie presence and resolves strict availability', async () => {
    const canonicalRepository = getRepository(CanonicalMedia);
    const presenceRepository = getRepository(LibraryPresence);
    const represented = await canonicalRepository.save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Represented',
        tmdbCollectionId: 10,
        collectionMembershipHydratedAt: new Date(),
      })
    );
    const duplicate = await canonicalRepository.save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Duplicate collection',
        tmdbCollectionId: 10,
        collectionMembershipHydratedAt: new Date(),
      })
    );
    const archived = await canonicalRepository.save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Archived',
        tmdbCollectionId: 11,
        collectionMembershipHydratedAt: new Date(),
      })
    );
    const unknown = await canonicalRepository.save(
      new CanonicalMedia({
        mediaType: LibraryMediaType.MOVIE,
        titleSnapshot: 'Unhydrated',
        tmdbCollectionId: 12,
        collectionMembershipHydratedAt: null,
      })
    );
    await presenceRepository.save([
      new LibraryPresence({
        canonicalMediaId: represented.id,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceItemId: 'represented-a',
        isCurrent: true,
        servarrHasFile: true,
      }),
      new LibraryPresence({
        canonicalMediaId: represented.id,
        sourceSystem: 'jellyfin',
        sourceScope: '1',
        sourceItemId: 'represented-b',
        isCurrent: true,
        jellyfinVisible: true,
      }),
      new LibraryPresence({
        canonicalMediaId: duplicate.id,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceItemId: 'duplicate',
        isCurrent: true,
        servarrHasFile: true,
      }),
      new LibraryPresence({
        canonicalMediaId: archived.id,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceItemId: 'archived',
        isCurrent: false,
        servarrHasFile: true,
      }),
      new LibraryPresence({
        canonicalMediaId: unknown.id,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceItemId: 'unknown',
        isCurrent: true,
        servarrHasFile: true,
      }),
    ]);
    await getRepository(Media).save([
      new Media({
        tmdbId: 101,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.AVAILABLE,
      }),
      new Media({
        tmdbId: 102,
        mediaType: MediaType.MOVIE,
        status: MediaStatus.PROCESSING,
      }),
    ]);

    const fetched: number[] = [];
    const service = createService({
      fetchCollection: async (id) => {
        fetched.push(id);
        return collection(id, 'Only Collection', [101, 101, 102]);
      },
    });
    const result = await settle(service);
    assert.deepEqual(fetched, [10]);
    assert.equal(result.discoveredCollections, 1);
    assert.equal(result.pageInfo.results, 1);
    assert.deepEqual(
      result.results.map((item) => ({
        id: item.id,
        available: item.availableMovies,
        total: item.totalMovies,
        completeness: item.completeness,
      })),
      [{ id: 10, available: 1, total: 2, completeness: 'incomplete' }]
    );
  });

  it('uses the same physical-current presence semantics as the main Library', async () => {
    const canonicalRepository = getRepository(CanonicalMedia);
    const presenceRepository = getRepository(LibraryPresence);
    const createCanonical = (title: string, tmdbCollectionId: number) =>
      canonicalRepository.save(
        new CanonicalMedia({
          mediaType: LibraryMediaType.MOVIE,
          titleSnapshot: title,
          tmdbCollectionId,
          collectionMembershipHydratedAt: new Date(),
        })
      );

    const radarrWithFile = await createCanonical('Radarr with file', 20);
    const radarrWithoutFile = await createCanonical('Radarr without file', 21);
    const visibleJellyfin = await createCanonical('Visible Jellyfin', 22);
    const hiddenJellyfin = await createCanonical('Hidden Jellyfin', 23);
    const historical = await createCanonical('Historical', 24);
    const multipleSources = await createCanonical('Multiple sources', 25);
    const removable = await createCanonical('Last physical presence', 26);
    await createCanonical('Request or watchlist only', 27);

    const removablePresence = await presenceRepository.save(
      new LibraryPresence({
        canonicalMediaId: removable.id,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceItemId: 'removable',
        isCurrent: true,
        servarrHasFile: true,
      })
    );
    await presenceRepository.save([
      new LibraryPresence({
        canonicalMediaId: radarrWithFile.id,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceItemId: 'radarr-with-file',
        isCurrent: true,
        servarrHasFile: true,
      }),
      new LibraryPresence({
        canonicalMediaId: radarrWithoutFile.id,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceItemId: 'radarr-without-file',
        isCurrent: true,
        servarrHasFile: false,
      }),
      new LibraryPresence({
        canonicalMediaId: visibleJellyfin.id,
        sourceSystem: 'jellyfin',
        sourceScope: '1',
        sourceItemId: 'visible-jellyfin',
        isCurrent: true,
        jellyfinVisible: true,
      }),
      new LibraryPresence({
        canonicalMediaId: hiddenJellyfin.id,
        sourceSystem: 'jellyfin',
        sourceScope: '1',
        sourceItemId: 'hidden-jellyfin',
        isCurrent: true,
        jellyfinVisible: false,
      }),
      new LibraryPresence({
        canonicalMediaId: historical.id,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceItemId: 'historical',
        isCurrent: false,
        servarrHasFile: true,
      }),
      new LibraryPresence({
        canonicalMediaId: multipleSources.id,
        sourceSystem: 'radarr',
        sourceScope: '1',
        sourceItemId: 'multiple-fileless',
        isCurrent: true,
        servarrHasFile: false,
      }),
      new LibraryPresence({
        canonicalMediaId: multipleSources.id,
        sourceSystem: 'jellyfin',
        sourceScope: '1',
        sourceItemId: 'multiple-visible',
        isCurrent: true,
        jellyfinVisible: true,
      }),
    ]);

    const fetched: number[] = [];
    const service = createService({
      fetchCollection: async (id) => {
        fetched.push(id);
        return collection(id, `Collection ${id}`, [id * 10]);
      },
      fetchAvailability: async () => new Map(),
    });
    const result = await settle(service);
    assert.deepEqual(fetched, [20, 22, 25, 26]);
    assert.equal(result.discoveredCollections, 4);

    removablePresence.servarrHasFile = false;
    await presenceRepository.save(removablePresence);
    const afterRemoval = await settle(
      createService({
        fetchCollection: async (id) =>
          collection(id, `Collection ${id}`, [id * 10]),
        fetchAvailability: async () => new Map(),
      })
    );
    assert.equal(afterRemoval.discoveredCollections, 3);
    assert.deepEqual(
      afterRemoval.results.map((item) => item.id),
      [20, 22, 25]
    );
  });

  it('chooses collection and existing member poster artwork without extra provider calls', async () => {
    const collections = new Map<number, TmdbCollection>([
      [
        31,
        {
          id: 31,
          name: 'Collection artwork',
          poster_path: '/collection.jpg',
          parts: [{ id: 311, poster_path: '/member.jpg' }],
        } as unknown as TmdbCollection,
      ],
      [
        32,
        {
          id: 32,
          name: 'Available member artwork',
          parts: [
            { id: 321, poster_path: '/unavailable-first.jpg' },
            { id: 322, poster_path: '/available-first.jpg' },
            { id: 323, poster_path: '/available-second.jpg' },
          ],
        } as unknown as TmdbCollection,
      ],
      [
        33,
        {
          id: 33,
          name: 'Other member artwork',
          parts: [
            { id: 331, poster_path: null },
            { id: 332, poster_path: '/other-member.jpg' },
          ],
        } as unknown as TmdbCollection,
      ],
      [
        34,
        {
          id: 34,
          name: 'No artwork',
          backdrop_path: '/landscape-only.jpg',
          parts: [{ id: 341, poster_path: null }],
        } as unknown as TmdbCollection,
      ],
    ]);
    let metadataCalls = 0;
    let availabilityCalls = 0;
    const service = createService({
      discoverCollectionIds: async () => [31, 32, 33, 34],
      fetchCollection: async (id) => {
        metadataCalls++;
        return collections.get(id)!;
      },
      fetchAvailability: async () => {
        availabilityCalls++;
        return new Map([
          [311, true],
          [321, false],
          [322, true],
          [323, true],
          [331, false],
          [332, false],
          [341, false],
        ]);
      },
    });
    const result = await settle(service);

    assert.equal(metadataCalls, 4);
    assert.equal(availabilityCalls, 1);
    assert.deepEqual(
      result.results.map((item) => [item.id, item.posterPath]),
      [
        [32, '/available-first.jpg'],
        [31, '/collection.jpg'],
        [34, null],
        [33, '/other-member.jpg'],
      ]
    );
  });

  it('filters before pagination and hides collections without eligible Movies', async () => {
    const metadata = new Map([
      [1, collection(1, 'Zulu', [11])],
      [2, collection(2, 'Alpha', [21, 22])],
      [3, collection(3, 'Unknown', [])],
    ]);
    const service = createService({
      discoverCollectionIds: async () => [1, 2, 3],
      fetchCollection: async (id) => metadata.get(id)!,
      fetchAvailability: async () =>
        new Map([
          [11, true],
          [21, true],
          [22, false],
        ]),
    });
    await settle(service);
    const incomplete = await service.query({
      ...query,
      completeness: 'incomplete',
      take: 1,
    });
    assert.equal(incomplete.pageInfo.results, 1);
    assert.equal(incomplete.pageInfo.pages, 1);
    assert.equal(incomplete.results[0].id, 2);
    const sorted = await service.query({
      ...query,
      sort: 'completeness',
      sortDirection: 'asc',
    });
    assert.deepEqual(
      sorted.results.map((item) => item.id),
      [2, 1]
    );
  });

  it('sorts API results by the exact completion ratio before pagination', async () => {
    const members = (start: number, count: number) =>
      Array.from({ length: count }, (_, index) => start + index);
    const metadata = new Map([
      [1, collection(1, 'Bravo', members(101, 10))],
      [2, collection(2, 'Zulu', members(201, 3))],
      [3, collection(3, 'Delta', members(301, 6))],
      [4, collection(4, 'Echo', members(401, 3))],
      [5, collection(5, 'Charlie', members(501, 27))],
      [6, collection(6, 'Foxtrot', [])],
      [7, collection(7, 'Alpha', members(701, 6))],
    ]);
    const availableIds = new Set([
      ...members(101, 1),
      ...members(201, 2),
      ...members(301, 5),
      ...members(401, 3),
      ...members(501, 10),
      ...members(701, 4),
    ]);
    const service = createService({
      discoverCollectionIds: async () => [...metadata.keys()],
      fetchCollection: async (id) => metadata.get(id)!,
      fetchAvailability: async (ids) =>
        new Map(ids.map((id) => [id, availableIds.has(id)])),
    });

    const ascending = await settle(service, {
      ...query,
      sort: 'completeness',
      sortDirection: 'asc',
    });
    assert.deepEqual(
      ascending.results.map(({ id, availableMovies, totalMovies }) => [
        id,
        availableMovies,
        totalMovies,
      ]),
      [
        [1, 1, 10],
        [5, 10, 27],
        [7, 4, 6],
        [2, 2, 3],
        [3, 5, 6],
        [4, 3, 3],
      ]
    );

    const descending = await service.query({
      ...query,
      sort: 'completeness',
      sortDirection: 'desc',
    });
    assert.deepEqual(
      descending.results.map((item) => item.id),
      [4, 3, 7, 2, 5, 1]
    );

    const paginated = await service.query({
      ...query,
      take: 2,
      skip: 1,
      sort: 'completeness',
      sortDirection: 'asc',
    });
    assert.equal(paginated.pageInfo.results, 6);
    assert.deepEqual(
      paginated.results.map((item) => item.id),
      [5, 7]
    );

    const availableAscending = await service.query({
      ...query,
      sort: 'available',
      sortDirection: 'asc',
    });
    const availableDescending = await service.query({
      ...query,
      sort: 'available',
      sortDirection: 'desc',
    });
    assert.deepEqual(
      availableAscending.results.map((item) => item.id),
      [1, 2, 4, 7, 3, 5]
    );
    assert.deepEqual(
      availableDescending.results.map((item) => item.id),
      [5, 3, 7, 4, 2, 1]
    );

    const nameAscending = await service.query({
      ...query,
      sort: 'name',
      sortDirection: 'asc',
    });
    const nameDescending = await service.query({
      ...query,
      sort: 'name',
      sortDirection: 'desc',
    });
    assert.deepEqual(
      nameAscending.results.map((item) => item.id),
      [7, 1, 5, 3, 4, 2]
    );
    assert.deepEqual(
      nameDescending.results.map((item) => item.id),
      [2, 4, 3, 5, 1, 7]
    );
  });

  it('coalesces concurrent cold refreshes and retains the last-good snapshot after provider failure', async () => {
    let now = new Date('2026-10-21T00:00:00.000Z');
    let calls = 0;
    let fail = false;
    const service = createService({
      discoverCollectionIds: async () => [7],
      fetchCollection: async () => {
        calls++;
        if (fail) throw new Error('provider unavailable');
        return collection(7, 'Snapshot Collection', [71]);
      },
      fetchAvailability: async () => new Map([[71, true]]),
      now: () => now,
      snapshotTtlMs: 1000,
    });
    const [first, second] = await Promise.all([
      service.query(query),
      service.query(query),
    ]);
    assert.equal(first.status, 'pending');
    assert.equal(second.status, 'pending');
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(calls, 1);
    const complete = await service.query(query);
    assert.equal(complete.status, 'complete');
    assert.equal(complete.results[0].availableMovies, 1);

    fail = true;
    now = new Date('2026-10-21T00:00:02.000Z');
    const refreshing = await service.query(query);
    assert.equal(refreshing.status, 'pending');
    assert.equal(refreshing.stale, true);
    assert.equal(refreshing.results[0].availableMovies, 1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const partial = await service.query(query);
    assert.equal(partial.status, 'partial');
    assert.equal(partial.failedCollections, 1);
    assert.equal(partial.results[0].availableMovies, 1);
  });

  it('reports cold metadata or availability failures as unavailable instead of zero availability', async () => {
    const metadataFailure = createService({
      discoverCollectionIds: async () => [8],
      fetchCollection: async () => {
        throw new Error('metadata failure');
      },
      fetchAvailability: async () => new Map(),
    });
    const unavailableMetadata = await settle(metadataFailure);
    assert.equal(unavailableMetadata.status, 'unavailable');
    assert.deepEqual(unavailableMetadata.results, []);

    const availabilityFailure = createService({
      discoverCollectionIds: async () => [9],
      fetchCollection: async () => collection(9, 'Strict Availability', [91]),
      fetchAvailability: async () => {
        throw new Error('database failure');
      },
    });
    const unavailableAvailability = await settle(availabilityFailure);
    assert.equal(unavailableAvailability.status, 'unavailable');
    assert.deepEqual(unavailableAvailability.results, []);
  });
});
