import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  R11_BACKEND_REPETITIONS,
  R11_BULK_SIZES,
  R11_PERFORMANCE_TARGETS,
  r11BulkFixtureCase,
} from './fixtures';

interface QueryMeasurement {
  targetCount: number;
  queryCount: number;
  queryCategories: Record<string, number>;
  latencyMilliseconds: {
    samples: number[];
    median: number;
    p95: number;
    minimum: number;
    maximum: number;
  };
  outcomeCounts: Record<string, number>;
  exactReasons: string[];
}

interface LibraryPresentationMeasurement {
  targetCount: number;
  initialLatencyMilliseconds: ReturnType<typeof summarizeLatencies>;
  initialProviderCalls: number;
  enrichedLatencyMilliseconds: number;
  totalProviderCalls: number;
  warmAdditionalProviderCalls: number;
  collectionPreserved: boolean;
  localizedTitlePreserved: boolean;
}

let libraryPresentationMeasurement: LibraryPresentationMeasurement | undefined;

const rounded = (value: number) => Math.round(value * 1000) / 1000;

const percentile = (values: number[], fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1];
};

const summarizeLatencies = (values: number[]) => ({
  samples: values.map(rounded),
  median: rounded(percentile(values, 0.5)),
  p95: rounded(percentile(values, 0.95)),
  minimum: rounded(Math.min(...values)),
  maximum: rounded(Math.max(...values)),
});

const categorizeQuery = (query: string): string => {
  const normalized = query.toLowerCase().replaceAll('`', '"');
  if (normalized.includes('from "canonical_media"')) return 'canonical-media';
  if (normalized.includes('from "canonical_season"')) return 'canonical-season';
  if (normalized.includes('from "removal_schedule"')) return 'removal-schedule';
  if (normalized.includes('from "removal_execution_claim"'))
    return 'removal-execution-claim';
  if (normalized.includes('from "library_presence"')) return 'library-presence';
  if (normalized.includes('from "library_file"'))
    return 'season-file-membership';
  if (normalized.includes('from "media"')) return 'seerr-media';
  if (normalized.includes('from "season"')) return 'seerr-season-relation';
  return normalized.trimStart().split(/\s+/, 1)[0] || 'other';
};

const increment = (counts: Record<string, number>, key: string) => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const runBulkEligibilityBenchmark = async (): Promise<QueryMeasurement[]> => {
  const [
    { LibraryMediaType },
    { MediaStatus, MediaType },
    { RemovalScheduleOrigin, RemovalScheduleStatus, RemovalTargetType },
    { default: dataSource, getRepository },
    { CanonicalEpisode, CanonicalMedia, CanonicalSeason },
    { LibraryFile, LibraryFileEpisode, LibraryPresence },
    { default: Media },
    { RemovalSchedule },
    { default: libraryBulkActions },
    { getSettings },
  ] = await Promise.all([
    import('@server/constants/libraryHistory'),
    import('@server/constants/media'),
    import('@server/constants/removal'),
    import('@server/datasource'),
    import('@server/entity/CanonicalMedia'),
    import('@server/entity/LibraryHistory'),
    import('@server/entity/Media'),
    import('@server/entity/RemovalSchedule'),
    import('@server/lib/libraryBulkActions'),
    import('@server/lib/settings'),
  ]);

  await dataSource.initialize();
  const settings = getSettings();
  settings.radarr = [
    {
      id: 1,
      name: 'R11 Radarr',
      hostname: '127.0.0.1',
      port: 1,
      apiKey: 'local-mock-only',
      useSsl: false,
      is4k: false,
      isDefault: true,
    } as never,
  ];
  settings.sonarr = [2, 3].map(
    (id) =>
      ({
        id,
        name: `R11 Sonarr ${id}`,
        hostname: '127.0.0.1',
        port: 1,
        apiKey: 'local-mock-only',
        useSsl: false,
        is4k: false,
        isDefault: id === 2,
      }) as never
  );

  const targets: {
    canonicalMediaId: number;
    targetType: 'movie' | 'series' | 'season';
    seasonNumber?: number;
  }[] = [];
  const expectedReasons: string[] = [];
  const now = new Date('2026-10-12T12:00:00.000Z');

  for (let index = 0; index < 100; index += 1) {
    const fixture = r11BulkFixtureCase(index);
    const movie = fixture.targetType === 'movie';
    const media = await getRepository(Media).save(
      new Media({
        mediaType: movie ? MediaType.MOVIE : MediaType.TV,
        tmdbId: 700_000 + index,
        status: MediaStatus.AVAILABLE,
        status4k: MediaStatus.UNKNOWN,
        serviceId: movie ? 1 : 2,
        externalServiceId: 10_000 + index,
        seasons: [],
      })
    );
    const canonical = await getRepository(CanonicalMedia).save(
      new CanonicalMedia({
        mediaType: movie ? LibraryMediaType.MOVIE : LibraryMediaType.SERIES,
        titleSnapshot: `R11 bulk target ${index + 1}`,
        year: 2026,
        currentMediaId: media.id,
      })
    );
    const target = {
      canonicalMediaId: canonical.id,
      targetType: fixture.targetType,
      ...(fixture.targetType === 'season' ? { seasonNumber: 1 } : {}),
    };
    targets.push(target);
    expectedReasons.push(fixture.expectedReason);

    let presence: InstanceType<typeof LibraryPresence> | undefined;
    if (fixture.kind !== 'movie-not-current') {
      const sourceScope =
        fixture.kind === 'season-configuration'
          ? 'service:999'
          : movie
            ? 'service:1'
            : 'service:2';
      presence = await getRepository(LibraryPresence).save(
        new LibraryPresence({
          canonicalMediaId: canonical.id,
          sourceSystem: movie ? 'radarr' : 'sonarr',
          sourceScope,
          sourceItemId: `${movie ? 'movie' : 'series'}:${10_000 + index}`,
          sourceGeneration: 'r11',
          firstObservedAt: now,
          servarrManaged: true,
          servarrHasFile: true,
          isCurrent: true,
        })
      );
      if (fixture.kind === 'series-ambiguous') {
        await getRepository(LibraryPresence).save(
          new LibraryPresence({
            canonicalMediaId: canonical.id,
            sourceSystem: 'sonarr',
            sourceScope: 'service:3',
            sourceItemId: `series:${20_000 + index}`,
            sourceGeneration: 'r11',
            firstObservedAt: now,
            servarrManaged: true,
            servarrHasFile: true,
            isCurrent: true,
          })
        );
      }
    }

    if (fixture.targetType === 'season') {
      const season = await getRepository(CanonicalSeason).save(
        new CanonicalSeason({ seriesId: canonical.id, seasonNumber: 1 })
      );
      const episode = await getRepository(CanonicalEpisode).save(
        new CanonicalEpisode({
          seasonId: season.id,
          episodeNumber: 1,
          isSpecial: false,
        })
      );
      if (presence) {
        const file = await getRepository(LibraryFile).save(
          new LibraryFile({
            libraryPresenceId: presence.id,
            sourceSystem: 'sonarr',
            sourceScope: presence.sourceScope,
            sourceFileId: `episode-file:${index}`,
            sourceGeneration: 'r11',
            sizeBytes: String(1024 ** 3),
            firstObservedAt: now,
            isCurrent: true,
          })
        );
        await getRepository(LibraryFileEpisode).save(
          new LibraryFileEpisode({
            libraryFileId: file.id,
            canonicalEpisodeId: episode.id,
          })
        );
      }
    }

    const scheduleType =
      fixture.kind === 'season-whole-series-scheduled'
        ? RemovalTargetType.SERIES
        : fixture.targetType === 'movie'
          ? RemovalTargetType.MOVIE
          : fixture.targetType === 'series'
            ? RemovalTargetType.SERIES
            : RemovalTargetType.SEASON;
    if (
      fixture.kind === 'movie-scheduled' ||
      fixture.kind === 'series-leased' ||
      fixture.kind === 'season-whole-series-scheduled'
    ) {
      await getRepository(RemovalSchedule).save(
        new RemovalSchedule({
          canonicalMediaId: canonical.id,
          targetType: scheduleType,
          seasonNumber: scheduleType === RemovalTargetType.SEASON ? 1 : null,
          sourceSystem: movie ? 'radarr' : 'sonarr',
          sourceScope: movie ? 'service:1' : 'service:2',
          origin: RemovalScheduleOrigin.MANUAL,
          status: RemovalScheduleStatus.ACTIVE,
          activeKey: `r11:${canonical.id}:${scheduleType}`,
          scheduledAt: now,
          removeAt: new Date('2026-12-12T12:00:00.000Z'),
          leaseToken:
            fixture.kind === 'series-leased' ? `r11-lease-${index}` : null,
          leaseUntil:
            fixture.kind === 'series-leased'
              ? new Date('2099-10-12T13:00:00.000Z')
              : null,
        })
      );
    }
  }

  const originalLogQuery = dataSource.logger.logQuery.bind(dataSource.logger);
  let activeQueries: string[] | undefined;
  dataSource.logger.logQuery = (query, parameters, queryRunner) => {
    activeQueries?.push(query);
    void parameters;
    void queryRunner;
  };

  const measurements: QueryMeasurement[] = [];
  try {
    await libraryBulkActions.previewEligibility(targets.slice(0, 10));
    for (const targetCount of R11_BULK_SIZES) {
      const selectedTargets = targets.slice(0, targetCount);
      const expected = expectedReasons.slice(0, targetCount);
      const latencies: number[] = [];
      const queryCounts: number[] = [];
      let capturedQueries: string[] = [];
      let exactReasons: string[] = [];
      for (let run = 0; run < R11_BACKEND_REPETITIONS; run += 1) {
        activeQueries = [];
        const startedAt = performance.now();
        const response =
          await libraryBulkActions.previewEligibility(selectedTargets);
        latencies.push(performance.now() - startedAt);
        exactReasons = response.results.map(({ reason }) => reason);
        assert.deepEqual(exactReasons, expected);
        queryCounts.push(activeQueries.length);
        if (run === 0) capturedQueries = [...activeQueries];
      }
      activeQueries = undefined;
      assert.equal(
        new Set(queryCounts).size,
        1,
        'SQL count must be deterministic'
      );
      const queryCategories: Record<string, number> = {};
      capturedQueries.forEach((query) =>
        increment(queryCategories, categorizeQuery(query))
      );
      const outcomeCounts: Record<string, number> = {};
      exactReasons.forEach((reason) => increment(outcomeCounts, reason));
      measurements.push({
        targetCount,
        queryCount: queryCounts[0],
        queryCategories,
        latencyMilliseconds: summarizeLatencies(latencies),
        outcomeCounts,
        exactReasons,
      });
    }
    assert.ok(
      measurements.every(
        ({ queryCount }) =>
          queryCount <=
          R11_PERFORMANCE_TARGETS.bulkEligibility.maximumQueriesAt100Targets
      ),
      'Bulk eligibility must stay within the bounded SQL statement budget'
    );
    assert.ok(
      Math.max(...measurements.map(({ queryCount }) => queryCount)) -
        Math.min(...measurements.map(({ queryCount }) => queryCount)) <=
        1,
      'Bulk eligibility SQL count must remain approximately constant'
    );
    const largestMeasurement = measurements.at(-1);
    assert.ok(
      largestMeasurement &&
        largestMeasurement.latencyMilliseconds.p95 <=
          R11_PERFORMANCE_TARGETS.bulkEligibility
            .sqliteP95MillisecondsAt100Targets,
      '100-target bulk eligibility p95 exceeded the SQLite threshold'
    );

    const [
      { LibraryService },
      { LibraryPresentationCoordinator },
      { default: cacheManager },
    ] = await Promise.all([
      import('@server/lib/library'),
      import('@server/lib/libraryPresentation'),
      import('@server/lib/cache'),
    ]);
    cacheManager.getCache('librarypresentation').flush();
    let providerCalls = 0;
    const presentationCoordinator = new LibraryPresentationCoordinator({
      fetchPresentation: async (mediaType, tmdbId, locale) => {
        providerCalls += 1;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
        return {
          title: `${locale} localized ${tmdbId}`,
          year: 2026,
          posterPath: `/poster-${tmdbId}.jpg`,
          backdropPath: `/backdrop-${tmdbId}.jpg`,
          collection:
            mediaType === 'movie'
              ? {
                  id: tmdbId + 1_000_000,
                  name: `${locale} collection ${tmdbId}`,
                  posterPath: `/collection-${tmdbId}.jpg`,
                  backdropPath: `/collection-backdrop-${tmdbId}.jpg`,
                }
              : null,
        };
      },
    });
    const libraryService = new LibraryService({
      fetchPresentation: async () => {
        throw new Error('R11-C must use asynchronous presentation');
      },
      presentationCoordinator,
    });
    const libraryQuery = {
      take: 25,
      skip: 0,
      scope: 'current' as const,
      watchlist: 'any' as const,
      watched: 'any' as const,
      sort: 'title' as const,
      sortDirection: 'asc' as const,
      locale: 'ro',
    };
    const initialLatencies: number[] = [];
    let presentationBatchId = '';
    for (let run = 0; run < R11_BACKEND_REPETITIONS; run += 1) {
      const startedAt = performance.now();
      const initial = await libraryService.query(libraryQuery);
      initialLatencies.push(performance.now() - startedAt);
      assert.equal(initial.results.length, 25);
      assert.equal(initial.presentation?.state, 'pending');
      presentationBatchId = initial.presentation?.batchId as string;
    }
    const initialProviderCalls = providerCalls;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        presentationCoordinator.status(presentationBatchId).state !== 'pending'
      )
        break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    }
    assert.notEqual(
      presentationCoordinator.status(presentationBatchId).state,
      'pending',
      'Library presentation enrichment must settle'
    );
    const enrichedStart = performance.now();
    const enriched = await libraryService.query(libraryQuery);
    const enrichedLatencyMilliseconds = performance.now() - enrichedStart;
    const callsAfterEnriched = providerCalls;
    const warm = await libraryService.query(libraryQuery);
    assert.equal(warm.presentation?.state, 'complete');
    const localizedTitlePreserved = enriched.results.every((item) =>
      item.title.startsWith('ro localized ')
    );
    const collectionPreserved = enriched.results
      .filter((item) => item.mediaType === 'movie')
      .every((item) => item.collection?.name.startsWith('ro collection '));
    const initialLatency = summarizeLatencies(initialLatencies);
    assert.ok(
      initialLatency.p95 < 250,
      '25-item initial Library p95 exceeded the R11-C threshold'
    );
    assert.equal(providerCalls, callsAfterEnriched);
    assert.equal(localizedTitlePreserved, true);
    assert.equal(collectionPreserved, true);
    libraryPresentationMeasurement = {
      targetCount: 25,
      initialLatencyMilliseconds: initialLatency,
      initialProviderCalls,
      enrichedLatencyMilliseconds: rounded(enrichedLatencyMilliseconds),
      totalProviderCalls: callsAfterEnriched,
      warmAdditionalProviderCalls: providerCalls - callsAfterEnriched,
      collectionPreserved,
      localizedTitlePreserved,
    };
    presentationCoordinator.shutdown();
    cacheManager.getCache('librarypresentation').flush();
  } finally {
    dataSource.logger.logQuery = originalLogQuery;
    await dataSource.destroy();
  }
  return measurements;
};

const runTmdbBenchmark = async () => {
  const [
    { default: TheMovieDb, tmdbRequestCoordinator },
    { default: cacheManager },
  ] = await Promise.all([
    import('@server/api/themoviedb'),
    import('@server/lib/cache'),
  ]);
  const counts = new Map<string, number>();
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
    const send = () => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: Number(url.pathname.split('/').at(-1)),
          title: 'R11 mocked movie',
          videos: { results: [] },
          credits: { cast: [], crew: [] },
          external_ids: {},
          keywords: { keywords: [] },
          release_dates: { results: [] },
          'watch/providers': { results: {} },
        })
      );
    };
    const delay =
      url.pathname.endsWith('/930003') || url.pathname.endsWith('/930004')
        ? 75
        : 0;
    setTimeout(send, delay);
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen)
  );
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const expose = (client: InstanceType<typeof TheMovieDb>) => {
    const internal = client as unknown as {
      axios: { defaults: { baseURL?: string; timeout?: number } };
    };
    internal.axios.defaults.baseURL = baseUrl;
    return internal;
  };
  const requestCount = (movieId: number) =>
    counts.get(`/movie/${movieId}`) ?? 0;

  try {
    cacheManager.getCache('tmdb').flush();
    const coldClient = new TheMovieDb();
    const coldInternal = expose(coldClient);
    const coldStart = performance.now();
    await coldClient.getMovie({ movieId: 930001, language: 'en' });
    const coldMilliseconds = performance.now() - coldStart;
    const warmStart = performance.now();
    await coldClient.getMovie({ movieId: 930001, language: 'en' });
    const warmMilliseconds = performance.now() - warmStart;

    cacheManager.getCache('tmdb').flush();
    const duplicateClients = Array.from({ length: 10 }, () => {
      const client = new TheMovieDb();
      expose(client);
      return client;
    });
    const duplicateStart = performance.now();
    await Promise.all(
      duplicateClients.map((client) =>
        client.getMovie({ movieId: 930002, language: 'en' })
      )
    );
    const duplicateMilliseconds = performance.now() - duplicateStart;
    assert.ok(
      requestCount(930002) <= 1,
      'Identical concurrent TMDB cache misses must be coalesced'
    );

    cacheManager.getCache('tmdb').flush();
    const timeoutClient = new TheMovieDb();
    const timeoutInternal = expose(timeoutClient);
    const timeoutStart = performance.now();
    await timeoutClient.getMovie({ movieId: 930003, language: 'en' });
    const timeoutMilliseconds = performance.now() - timeoutStart;

    cacheManager.getCache('tmdb').flush();
    const boundedTimeoutClient = new TheMovieDb();
    const boundedTimeoutInternal = expose(boundedTimeoutClient);
    boundedTimeoutInternal.axios.defaults.timeout = 25;
    const boundedTimeoutStart = performance.now();
    let boundedTimeoutErrorCode: string | null = null;
    try {
      await boundedTimeoutClient.getMovie({
        movieId: 930004,
        language: 'en',
      });
    } catch (error) {
      boundedTimeoutErrorCode =
        typeof error === 'object' && error && 'code' in error
          ? String(error.code)
          : 'unknown';
    }
    const boundedTimeoutMilliseconds = performance.now() - boundedTimeoutStart;
    assert.notEqual(boundedTimeoutErrorCode, null);
    assert.ok(
      (timeoutInternal.axios.defaults.timeout ?? 0) > 0,
      'TMDB must use a finite configured timeout'
    );

    return {
      configuredAxiosTimeoutMilliseconds:
        timeoutInternal.axios.defaults.timeout ?? 0,
      cold: {
        requests: requestCount(930001),
        milliseconds: rounded(coldMilliseconds),
      },
      warm: {
        additionalRequests: requestCount(930001) - 1,
        milliseconds: rounded(warmMilliseconds),
      },
      concurrentDuplicate: {
        callers: duplicateClients.length,
        requests: requestCount(930002),
        milliseconds: rounded(duplicateMilliseconds),
      },
      delayedResponse: {
        serverDelayMilliseconds: 75,
        requests: requestCount(930003),
        completedWithoutTimeout: true,
        milliseconds: rounded(timeoutMilliseconds),
      },
      boundedTimeoutControl: {
        configuredTimeoutMilliseconds:
          boundedTimeoutInternal.axios.defaults.timeout,
        serverDelayMilliseconds: 75,
        requests: requestCount(930004),
        timedOut: true,
        errorCode: boundedTimeoutErrorCode,
        milliseconds: rounded(boundedTimeoutMilliseconds),
      },
      coldClientTimeoutMilliseconds: coldInternal.axios.defaults.timeout ?? 0,
      requestCoordinator: tmdbRequestCoordinator.stats(),
    };
  } finally {
    cacheManager.getCache('tmdb').flush();
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose()))
    );
  }
};

const outputPath = () => {
  const index = process.argv.indexOf('--output');
  return index >= 0 && process.argv[index + 1]
    ? resolve(process.argv[index + 1])
    : undefined;
};

const main = async () => {
  Reflect.set(process.env, 'NODE_ENV', 'test');
  const configDirectory = await mkdtemp(join(tmpdir(), 'seerr-r11-backend-'));
  process.env.CONFIG_DIRECTORY = configDirectory;
  try {
    const result = {
      schemaVersion: 2,
      measuredAt: new Date().toISOString(),
      runtime: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
      },
      bulkEligibility: await runBulkEligibilityBenchmark(),
      libraryPresentation: libraryPresentationMeasurement,
      tmdb: await runTmdbBenchmark(),
    };
    const serialized = `${JSON.stringify(result, null, 2)}\n`;
    const destination = outputPath();
    if (destination) await writeFile(destination, serialized, 'utf8');
    process.stdout.write(serialized);
  } finally {
    await rm(configDirectory, { recursive: true, force: true });
  }
};

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack : String(error)}\n`
  );
  process.exitCode = 1;
});
