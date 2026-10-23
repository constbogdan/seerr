import type { TmdbTvDetails } from '@server/api/themoviedb/interfaces';
import { LibraryMediaType } from '@server/constants/libraryHistory';
import { getRepository } from '@server/datasource';
import {
  CanonicalMedia,
  CanonicalMediaIdentity,
} from '@server/entity/CanonicalMedia';
import { LibraryPresence } from '@server/entity/LibraryHistory';
import {
  QuotaRestrictedError,
  RequestPermissionError,
} from '@server/entity/MediaRequest';
import type { User } from '@server/entity/User';
import type { LibrarySeriesDetailResponse } from '@server/interfaces/api/libraryInterfaces';
import {
  NextSeasonService,
  deriveNextSeasonTriggers,
  isNextSeasonProgressEligible,
  loadActiveNextSeasonSeries,
  type NextSeasonDependencies,
  type SeasonInspection,
} from '@server/lib/nextSeason';
import { setupTestDb } from '@server/test/db';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

setupTestDb();

const now = new Date('2026-10-23T12:00:00.000Z');
const owner = {
  id: 7,
  hasPermission: () => true,
} as unknown as User;

const detail = (
  seasons: {
    seasonNumber: number;
    isSpecial?: boolean;
    availableEpisodeCount: number;
    users: {
      key: string;
      userId: number | null;
      watchedEpisodeCount: number;
    }[];
  }[]
): LibrarySeriesDetailResponse => ({
  canonicalMediaId: 1,
  seasons: seasons.map((season) => ({
    seasonNumber: season.seasonNumber,
    isSpecial: season.isSpecial ?? false,
    availableEpisodeCount: season.availableEpisodeCount,
    resolution: null,
    sizeBytes: null,
    removedAt: null,
    removalSource: null,
    users: season.users.map((user) => ({
      ...user,
      displayName: user.key,
      avatar: null,
      watchedPercentage:
        season.availableEpisodeCount > 0
          ? (user.watchedEpisodeCount / season.availableEpisodeCount) * 100
          : 0,
      lastViewedAt: null,
    })),
  })),
});

const metadata = (
  seasons: { seasonNumber: number; episodes?: number; airDate?: string }[]
) =>
  ({
    id: 101,
    seasons: seasons.map((season) => ({
      id: season.seasonNumber,
      season_number: season.seasonNumber,
      episode_count: season.episodes ?? 8,
      air_date: season.airDate ?? '2026-01-01',
      name: `Season ${season.seasonNumber}`,
      overview: '',
    })),
  }) as TmdbTvDetails;

const qualifyingDetail = detail([
  {
    seasonNumber: 1,
    availableEpisodeCount: 8,
    users: [{ key: 'viewer-1', userId: 1, watchedEpisodeCount: 6 }],
  },
]);

const dependencies = (
  overrides: Partial<NextSeasonDependencies> = {}
): NextSeasonDependencies => ({
  loadActiveSeries: async () => [
    { canonicalMediaId: 1, tmdbId: 101, title: 'Series' },
  ],
  loadSeriesProgress: async () => qualifyingDetail,
  loadTvMetadata: async () =>
    metadata([{ seasonNumber: 1 }, { seasonNumber: 2 }]),
  refreshAcquisitions: async () => ({ authoritative: true }),
  inspectSeason: async (): Promise<SeasonInspection> => ({
    state: 'eligible',
  }),
  isSeriesActive: async () => true,
  isSeasonPresent: async (_canonicalMediaId, seasonNumber) =>
    seasonNumber === 1,
  findRequestOwner: async () => owner,
  submitSeason: async () => ({ id: 101 }),
  requestOwnerUserId: () => owner.id,
  now: () => now,
  ...overrides,
});

const seedActiveSeries = async (tmdbId: number) => {
  const canonical = await getRepository(CanonicalMedia).save(
    new CanonicalMedia({
      mediaType: LibraryMediaType.SERIES,
      titleSnapshot: `Series ${tmdbId}`,
    })
  );
  await getRepository(CanonicalMediaIdentity).save(
    new CanonicalMediaIdentity({
      canonicalMediaId: canonical.id,
      mediaType: LibraryMediaType.SERIES,
      provider: 'tmdb',
      sourceScope: '',
      value: String(tmdbId),
    })
  );
  await getRepository(LibraryPresence).save(
    new LibraryPresence({
      canonicalMediaId: canonical.id,
      sourceSystem: 'sonarr',
      sourceScope: 'next-season-cursor-test',
      sourceItemId: String(tmdbId),
      isCurrent: true,
      servarrHasFile: true,
    })
  );
  return canonical;
};

describe('Next Season progress selection', () => {
  it('uses an inclusive 70 percent threshold with a valid authoritative denominator', () => {
    assert.equal(isNextSeasonProgressEligible(4, 8), false);
    assert.equal(isNextSeasonProgressEligible(5, 8), false);
    assert.equal(isNextSeasonProgressEligible(6, 10), false);
    assert.equal(isNextSeasonProgressEligible(7, 10), true);
    assert.equal(isNextSeasonProgressEligible(6, 8), true);
    assert.equal(isNextSeasonProgressEligible(8, 10), true);
    assert.equal(isNextSeasonProgressEligible(8, 8), true);
    assert.equal(isNextSeasonProgressEligible(0, 0), false);
    assert.equal(isNextSeasonProgressEligible(1, 0), false);
    assert.equal(isNextSeasonProgressEligible(9, 8), false);
    assert.equal(isNextSeasonProgressEligible(5.5, 8), false);
  });

  it('evaluates every physical regular Season and keeps viewers independent', () => {
    const triggers = deriveNextSeasonTriggers(
      detail([
        {
          seasonNumber: 0,
          isSpecial: true,
          availableEpisodeCount: 2,
          users: [{ key: 'one', userId: 1, watchedEpisodeCount: 2 }],
        },
        {
          seasonNumber: 1,
          availableEpisodeCount: 8,
          users: [
            { key: 'one', userId: 1, watchedEpisodeCount: 6 },
            { key: 'two', userId: 2, watchedEpisodeCount: 6 },
          ],
        },
        {
          seasonNumber: 2,
          availableEpisodeCount: 10,
          users: [{ key: 'one', userId: 1, watchedEpisodeCount: 2 }],
        },
      ]),
      new Map([
        [1, 8],
        [2, 10],
      ])
    );

    assert.deepEqual(triggers, [
      { seasonNumber: 1, nextSeasonNumber: 2, qualifyingViewers: 2 },
    ]);
  });

  it('counts multiple viewers who independently qualify on the same Season', () => {
    assert.deepEqual(
      deriveNextSeasonTriggers(
        detail([
          {
            seasonNumber: 2,
            availableEpisodeCount: 10,
            users: [
              { key: 'one', userId: 1, watchedEpisodeCount: 8 },
              { key: 'two', userId: 2, watchedEpisodeCount: 10 },
            ],
          },
        ]),
        new Map([[2, 10]])
      ),
      [{ seasonNumber: 2, nextSeasonNumber: 3, qualifyingViewers: 2 }]
    );
  });

  it('never combines sub-threshold progress from multiple viewers', () => {
    assert.deepEqual(
      deriveNextSeasonTriggers(
        detail([
          {
            seasonNumber: 1,
            availableEpisodeCount: 10,
            users: [
              { key: 'one', userId: 1, watchedEpisodeCount: 4 },
              { key: 'two', userId: 2, watchedEpisodeCount: 4 },
            ],
          },
        ]),
        new Map([[1, 10]])
      ),
      []
    );
  });

  it('selects the immediate following Season with deterministic ordering', () => {
    const triggers = deriveNextSeasonTriggers(
      detail([
        {
          seasonNumber: 3,
          availableEpisodeCount: 10,
          users: [{ key: 'later', userId: 2, watchedEpisodeCount: 8 }],
        },
        {
          seasonNumber: 1,
          availableEpisodeCount: 8,
          users: [{ key: 'earlier', userId: 1, watchedEpisodeCount: 6 }],
        },
      ]),
      new Map([
        [1, 8],
        [3, 10],
      ])
    );
    assert.deepEqual(
      triggers.map((trigger) => trigger.nextSeasonNumber),
      [2, 4]
    );
  });

  it('fails closed when a physical source Season lacks an authoritative Episode total', () => {
    assert.deepEqual(
      deriveNextSeasonTriggers(
        detail([
          {
            seasonNumber: 1,
            availableEpisodeCount: 7,
            users: [{ key: 'viewer', userId: 1, watchedEpisodeCount: 7 }],
          },
        ]),
        new Map()
      ),
      []
    );
  });

  it('accepts partial physical inventory but rejects contradictory Episode totals', () => {
    const triggerCount = (
      availableEpisodeCount: number,
      watchedEpisodeCount: number,
      totalEpisodeCount?: number
    ) =>
      deriveNextSeasonTriggers(
        detail([
          {
            seasonNumber: 1,
            availableEpisodeCount,
            users: [{ key: 'viewer', userId: 1, watchedEpisodeCount }],
          },
        ]),
        totalEpisodeCount === undefined
          ? new Map()
          : new Map([[1, totalEpisodeCount]])
      ).length;

    assert.equal(triggerCount(10, 7, 10), 1);
    assert.equal(triggerCount(8, 7, 10), 1);
    assert.equal(triggerCount(11, 7, 10), 0);
    assert.equal(triggerCount(10, 11, 10), 0);
    assert.equal(triggerCount(10, 7, 0), 0);
    assert.equal(triggerCount(10, 7), 0);
  });
});

describe('Next Season active Library population', () => {
  it('loads only physically current Series and excludes archived, absent, and fileless inventory', async () => {
    const create = async (
      tmdbId: number,
      presence?: Partial<LibraryPresence>
    ) => {
      const canonical = await getRepository(CanonicalMedia).save(
        new CanonicalMedia({
          mediaType: LibraryMediaType.SERIES,
          titleSnapshot: `Series ${tmdbId}`,
        })
      );
      await getRepository(CanonicalMediaIdentity).save(
        new CanonicalMediaIdentity({
          canonicalMediaId: canonical.id,
          mediaType: LibraryMediaType.SERIES,
          provider: 'tmdb',
          sourceScope: '',
          value: String(tmdbId),
        })
      );
      if (presence) {
        await getRepository(LibraryPresence).save(
          new LibraryPresence({
            canonicalMediaId: canonical.id,
            sourceSystem: 'sonarr',
            sourceScope: 'next-season-test',
            sourceItemId: String(tmdbId),
            isCurrent: false,
            ...presence,
          })
        );
      }
      return canonical;
    };
    const active = await create(1001, {
      isCurrent: true,
      servarrHasFile: true,
    });
    await create(1002, { isCurrent: false, servarrHasFile: true });
    await create(1003);
    await create(1004, { isCurrent: true, servarrHasFile: false });
    const jellyfin = await create(1005, {
      sourceSystem: 'jellyfin',
      isCurrent: true,
      jellyfinVisible: true,
    });

    const result = await loadActiveNextSeasonSeries(50, 0);
    assert.deepEqual(
      result.map((item) => item.canonicalMediaId),
      [active.id, jellyfin.id]
    );
    assert.deepEqual(
      result.map((item) => item.tmdbId),
      [1001, 1005]
    );
  });
});

describe('Next Season execution safety', () => {
  it('performs a read-only dry run and reports the requestable Season', async () => {
    let submissions = 0;
    const service = new NextSeasonService(
      dependencies({
        submitSeason: async () => {
          submissions += 1;
          return { id: 1 };
        },
      })
    );
    const result = await service.run({ dryRun: true });
    assert.equal(result.status, 'succeeded');
    assert.equal(result.requested, 0);
    assert.equal(submissions, 0);
    assert.equal(service.status(), undefined);
    assert.deepEqual(result.candidates, [
      {
        canonicalMediaId: 1,
        tmdbId: 101,
        seasonNumber: 2,
        outcome: 'would-request',
      },
    ]);
  });

  it('submits one automatic Season request and rechecks immediately before submission', async () => {
    let inspections = 0;
    let submitted: [number, number, number] | undefined;
    const service = new NextSeasonService(
      dependencies({
        inspectSeason: async () => {
          inspections += 1;
          return { state: 'eligible' };
        },
        submitSeason: async (tmdbId, seasonNumber, requestOwner) => {
          submitted = [tmdbId, seasonNumber, requestOwner.id];
          return { id: 44 };
        },
      })
    );
    const result = await service.run();
    assert.equal(inspections, 2);
    assert.deepEqual(submitted, [101, 2, owner.id]);
    assert.equal(result.requested, 1);
    assert.deepEqual(result.requestIds, [44]);
    assert.equal(result.limitReason, undefined);
  });

  it('requests independently eligible targets across a non-contiguous physical Series', async () => {
    const submitted: number[] = [];
    const progress = detail([
      {
        seasonNumber: 1,
        availableEpisodeCount: 10,
        users: [{ key: 'one', userId: 1, watchedEpisodeCount: 7 }],
      },
      {
        seasonNumber: 3,
        availableEpisodeCount: 10,
        users: [{ key: 'two', userId: 2, watchedEpisodeCount: 7 }],
      },
    ]);
    const serviceDependencies = dependencies({
      loadSeriesProgress: async () => progress,
      loadTvMetadata: async () =>
        metadata(
          [1, 2, 3, 4].map((seasonNumber) => ({
            seasonNumber,
            episodes: 10,
          }))
        ),
      submitSeason: async (_tmdbId, seasonNumber) => {
        submitted.push(seasonNumber);
        return { id: 100 + seasonNumber };
      },
      isSeasonPresent: async (_canonicalMediaId, seasonNumber) =>
        seasonNumber === 1 || seasonNumber === 3,
    });

    const dryRun = await new NextSeasonService(serviceDependencies).run({
      dryRun: true,
    });
    assert.deepEqual(
      dryRun.candidates.map(({ seasonNumber, outcome }) => ({
        seasonNumber,
        outcome,
      })),
      [
        { seasonNumber: 2, outcome: 'would-request' },
        { seasonNumber: 4, outcome: 'would-request' },
      ]
    );
    assert.deepEqual(submitted, []);

    const result = await new NextSeasonService(serviceDependencies).run();
    assert.deepEqual(submitted, [2, 4]);
    assert.equal(result.requested, 2);
    assert.deepEqual(result.requestIds, [102, 104]);
  });

  it('skips an already-present contiguous target and requests the next gap', async () => {
    const submitted: number[] = [];
    const result = await new NextSeasonService(
      dependencies({
        loadSeriesProgress: async () =>
          detail([
            {
              seasonNumber: 1,
              availableEpisodeCount: 10,
              users: [{ key: 'one', userId: 1, watchedEpisodeCount: 7 }],
            },
            {
              seasonNumber: 2,
              availableEpisodeCount: 10,
              users: [{ key: 'two', userId: 2, watchedEpisodeCount: 7 }],
            },
          ]),
        loadTvMetadata: async () =>
          metadata(
            [1, 2, 3].map((seasonNumber) => ({
              seasonNumber,
              episodes: 10,
            }))
          ),
        inspectSeason: async () => ({ state: 'eligible' }),
        isSeasonPresent: async (_canonicalMediaId, seasonNumber) =>
          seasonNumber === 1 || seasonNumber === 2,
        submitSeason: async (_tmdbId, seasonNumber) => {
          submitted.push(seasonNumber);
          return { id: seasonNumber };
        },
      })
    ).run();

    assert.deepEqual(submitted, [3]);
    assert.equal(result.requested, 1);
    assert.equal(result.alreadyAvailable, 1);
    assert.deepEqual(
      result.candidates.map(({ seasonNumber, reason, outcome }) => ({
        seasonNumber,
        reason,
        outcome,
      })),
      [
        {
          seasonNumber: 2,
          reason: 'already-available',
          outcome: 'skipped',
        },
        { seasonNumber: 3, reason: undefined, outcome: 'requested' },
      ]
    );
  });

  it('skips missing and unreleased following Seasons', async () => {
    const missing = await new NextSeasonService(
      dependencies({
        loadTvMetadata: async () => metadata([{ seasonNumber: 1 }]),
      })
    ).run({ dryRun: true });
    assert.equal(missing.candidates[0].reason, 'missing-next-season');

    const unreleased = await new NextSeasonService(
      dependencies({
        loadTvMetadata: async () =>
          metadata([
            { seasonNumber: 1 },
            { seasonNumber: 2, airDate: '2027-01-01' },
          ]),
      })
    ).run({ dryRun: true });
    assert.equal(unreleased.candidates[0].reason, 'unreleased-next-season');
  });

  it('preserves every local availability and acquisition skip state', async () => {
    const states: SeasonInspection['state'][] = [
      'already-available',
      'partially-available',
      'already-requested',
      'failed-request',
      'active-acquisition',
      'blocklisted',
      'partial-requests-disabled',
    ];
    for (const state of states) {
      const result = await new NextSeasonService(
        dependencies({ inspectSeason: async () => ({ state }) })
      ).run({ dryRun: true });
      assert.equal(result.requested, 0);
      assert.equal(result.candidates[0].reason, state);
    }
  });

  it('fails closed without an administrator request owner', async () => {
    let metadataCalls = 0;
    const result = await new NextSeasonService(
      dependencies({
        findRequestOwner: async () => null,
        loadTvMetadata: async () => {
          metadataCalls += 1;
          return metadata([]);
        },
      })
    ).run();
    assert.equal(result.status, 'failed');
    assert.equal(result.limitReason, 'configuration');
    assert.equal(result.candidates[0].reason, 'no-request-owner');
    assert.equal(metadataCalls, 0);
  });

  it('fails closed before candidate loading when acquisition state is not authoritative', async () => {
    let candidateLoads = 0;
    const result = await new NextSeasonService(
      dependencies({
        refreshAcquisitions: async () => ({ authoritative: false }),
        loadActiveSeries: async () => {
          candidateLoads += 1;
          return [];
        },
      })
    ).run();

    assert.equal(result.status, 'failed');
    assert.equal(result.candidates[0].reason, 'acquisition-unavailable');
    assert.equal(candidateLoads, 0);
  });

  it('honors permission and quota rejection from the existing request workflow', async () => {
    for (const error of [
      new QuotaRestrictedError('quota'),
      new RequestPermissionError('permission'),
    ]) {
      const result = await new NextSeasonService(
        dependencies({
          submitSeason: async () => {
            throw error;
          },
        })
      ).run();
      assert.equal(result.requested, 0);
      assert.equal(result.failed, 0);
      assert.equal(result.skipped, 1);
      assert.equal(result.candidates[0].reason, 'request-ineligible');
    }
  });

  it('reports below-threshold progress and eligibility failures without submitting', async () => {
    const below = await new NextSeasonService(
      dependencies({
        loadSeriesProgress: async () =>
          detail([
            {
              seasonNumber: 1,
              availableEpisodeCount: 10,
              users: [{ key: 'viewer', userId: 1, watchedEpisodeCount: 6 }],
            },
          ]),
        loadTvMetadata: async () =>
          metadata([
            { seasonNumber: 1, episodes: 10 },
            { seasonNumber: 2, episodes: 10 },
          ]),
      })
    ).run({ dryRun: true });
    assert.equal(below.skipped, 1);
    assert.equal(below.candidates[0].reason, 'below-threshold');

    let submissions = 0;
    const failed = await new NextSeasonService(
      dependencies({
        inspectSeason: async () => {
          throw new Error('database unavailable');
        },
        submitSeason: async () => {
          submissions += 1;
          return { id: 1 };
        },
      })
    ).run();
    assert.equal(failed.failed, 1);
    assert.equal(failed.candidates[0].reason, 'eligibility-failure');
    assert.equal(submissions, 0);
  });

  it('does not submit when physical Library activity changes before the recheck', async () => {
    let submissions = 0;
    const result = await new NextSeasonService(
      dependencies({
        isSeriesActive: async () => false,
        submitSeason: async () => {
          submissions += 1;
          return { id: 1 };
        },
      })
    ).run();
    assert.equal(submissions, 0);
    assert.equal(result.candidates[0].reason, 'no-longer-active');
  });

  it('rechecks the exact source Season for live and dry-run evaluation', async () => {
    const submitted: number[] = [];
    const serviceDependencies = dependencies({
      loadSeriesProgress: async () =>
        detail([
          {
            seasonNumber: 1,
            availableEpisodeCount: 10,
            users: [{ key: 'one', userId: 1, watchedEpisodeCount: 7 }],
          },
          {
            seasonNumber: 3,
            availableEpisodeCount: 10,
            users: [{ key: 'two', userId: 2, watchedEpisodeCount: 7 }],
          },
        ]),
      loadTvMetadata: async () =>
        metadata(
          [1, 2, 3, 4].map((seasonNumber) => ({
            seasonNumber,
            episodes: 10,
          }))
        ),
      isSeriesActive: async () => true,
      isSeasonPresent: async (_canonicalMediaId, seasonNumber) =>
        seasonNumber === 3,
      submitSeason: async (_tmdbId, seasonNumber) => {
        submitted.push(seasonNumber);
        return { id: seasonNumber };
      },
    });

    const dryRun = await new NextSeasonService(serviceDependencies).run({
      dryRun: true,
    });
    assert.deepEqual(
      dryRun.candidates.map(({ seasonNumber, outcome, reason }) => ({
        seasonNumber,
        outcome,
        reason,
      })),
      [
        {
          seasonNumber: 2,
          outcome: 'skipped',
          reason: 'no-longer-active',
        },
        { seasonNumber: 4, outcome: 'would-request', reason: undefined },
      ]
    );

    const live = await new NextSeasonService(serviceDependencies).run();
    assert.deepEqual(submitted, [4]);
    assert.equal(live.requested, 1);
  });

  it('fails closed when the source Season disappears at the request boundary', async () => {
    let sourceChecks = 0;
    let submissions = 0;
    const result = await new NextSeasonService(
      dependencies({
        isSeasonPresent: async (_canonicalMediaId, seasonNumber) => {
          if (seasonNumber !== 1) return false;
          sourceChecks += 1;
          return sourceChecks === 1;
        },
        submitSeason: async () => {
          submissions += 1;
          return { id: 1 };
        },
      })
    ).run();

    assert.equal(sourceChecks, 2);
    assert.equal(submissions, 0);
    assert.equal(result.candidates[0].reason, 'no-longer-active');
  });

  it('does not submit when the target Season becomes physically present before submission', async () => {
    let submissions = 0;
    const result = await new NextSeasonService(
      dependencies({
        isSeasonPresent: async () => true,
        submitSeason: async () => {
          submissions += 1;
          return { id: 1 };
        },
      })
    ).run();
    assert.equal(submissions, 0);
    assert.equal(result.alreadyAvailable, 1);
    assert.equal(result.candidates[0].reason, 'already-available');
  });

  it('classifies eligibility changes consistently during the submission race', async () => {
    const cases: {
      state: Exclude<SeasonInspection['state'], 'eligible'>;
      counter:
        | 'alreadyAvailable'
        | 'alreadyRequested'
        | 'activeAcquisitions'
        | null;
    }[] = [
      { state: 'already-available', counter: 'alreadyAvailable' },
      { state: 'already-requested', counter: 'alreadyRequested' },
      { state: 'failed-request', counter: 'alreadyRequested' },
      { state: 'active-acquisition', counter: 'activeAcquisitions' },
      { state: 'partially-available', counter: null },
    ];

    for (const { state, counter } of cases) {
      let inspections = 0;
      const result = await new NextSeasonService(
        dependencies({
          inspectSeason: async () => {
            inspections += 1;
            return inspections === 1 ? { state: 'eligible' } : { state };
          },
        })
      ).run();

      assert.equal(result.requested, 0);
      assert.equal(result.skipped, 1);
      assert.equal(result.candidates.length, 1);
      assert.equal(result.candidates[0].reason, state);
      if (counter) assert.equal(result[counter], 1);
    }
  });

  it('prevents overlapping execution and remains safe on repeated runs', async () => {
    let release!: () => void;
    const blocked = new Promise<LibrarySeriesDetailResponse | null>(
      (resolve) => {
        release = () => resolve(qualifyingDetail);
      }
    );
    let progressCalls = 0;
    const service = new NextSeasonService(
      dependencies({
        loadSeriesProgress: async () => {
          progressCalls += 1;
          return progressCalls === 1 ? blocked : qualifyingDetail;
        },
        inspectSeason: async () =>
          progressCalls > 1
            ? { state: 'already-requested' }
            : { state: 'eligible' },
      })
    );
    const first = service.run();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const overlapping = await service.run();
    assert.equal(overlapping.status, 'already-running');
    release();
    assert.equal((await first).requested, 1);
    const repeated = await service.run();
    assert.equal(repeated.requested, 0);
    assert.equal(repeated.candidates[0].reason, 'already-requested');
  });

  it('fails closed with an explicit reason when the source Episode total is unavailable', async () => {
    const result = await new NextSeasonService(
      dependencies({
        loadTvMetadata: async () => metadata([{ seasonNumber: 2 }]),
      })
    ).run({ dryRun: true });

    assert.equal(result.requested, 0);
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.candidates, [
      {
        canonicalMediaId: 1,
        tmdbId: 101,
        seasonNumber: 2,
        outcome: 'skipped',
        reason: 'missing-episode-count',
      },
    ]);
  });

  it('reports contradictory physical and authoritative totals as missing Episode counts', async () => {
    const result = await new NextSeasonService(
      dependencies({
        loadSeriesProgress: async () =>
          detail([
            {
              seasonNumber: 1,
              availableEpisodeCount: 11,
              users: [{ key: 'viewer', userId: 1, watchedEpisodeCount: 7 }],
            },
          ]),
        loadTvMetadata: async () =>
          metadata([
            { seasonNumber: 1, episodes: 10 },
            { seasonNumber: 2, episodes: 10 },
          ]),
      })
    ).run({ dryRun: true });

    assert.equal(result.requested, 0);
    assert.equal(result.skipped, 1);
    assert.equal(result.candidates[0].reason, 'missing-episode-count');
  });

  it('retains the real cursor mid-candidate at the five-request limit', async () => {
    await seedActiveSeries(2101);
    const requested = new Set<number>();
    const submissions: number[] = [];
    const sourceSeasons = [1, 3, 5, 7, 9, 11];
    const service = new NextSeasonService(
      dependencies({
        loadActiveSeries: loadActiveNextSeasonSeries,
        loadSeriesProgress: async () =>
          detail(
            sourceSeasons.map((seasonNumber) => ({
              seasonNumber,
              availableEpisodeCount: 10,
              users: [
                {
                  key: `viewer-${seasonNumber}`,
                  userId: seasonNumber,
                  watchedEpisodeCount: 7,
                },
              ],
            }))
          ),
        loadTvMetadata: async () =>
          metadata(
            Array.from({ length: 12 }, (_, index) => ({
              seasonNumber: index + 1,
              episodes: 10,
            }))
          ),
        inspectSeason: async (_tmdbId, seasonNumber) =>
          requested.has(seasonNumber)
            ? { state: 'already-requested' }
            : { state: 'eligible' },
        isSeasonPresent: async (_canonicalMediaId, seasonNumber) =>
          sourceSeasons.includes(seasonNumber),
        submitSeason: async (_tmdbId, seasonNumber) => {
          submissions.push(seasonNumber);
          requested.add(seasonNumber);
          return { id: 200 + seasonNumber };
        },
      })
    );

    const dryRun = await service.run({ dryRun: true });
    assert.equal(dryRun.limitReason, 'request-limit');
    assert.equal(
      dryRun.candidates.filter(({ outcome }) => outcome === 'would-request')
        .length,
      5
    );
    assert.deepEqual(submissions, []);

    const first = await service.run();
    assert.equal(first.requested, 5);
    assert.equal(first.limitReason, 'request-limit');
    assert.deepEqual(submissions, [2, 4, 6, 8, 10]);

    const second = await service.run();
    assert.equal(second.requested, 1);
    assert.deepEqual(submissions, [2, 4, 6, 8, 10, 12]);
    assert.equal(second.alreadyRequested, 5);
  });

  it('retains the real cursor when the deadline interrupts a multi-target Series', async () => {
    await seedActiveSeries(2201);
    const requested = new Set<number>();
    const submissions: number[] = [];
    let deadlineEnabled = true;
    let nowCalls = 0;
    const service = new NextSeasonService(
      dependencies({
        loadActiveSeries: loadActiveNextSeasonSeries,
        loadSeriesProgress: async () =>
          detail([
            {
              seasonNumber: 1,
              availableEpisodeCount: 10,
              users: [{ key: 'one', userId: 1, watchedEpisodeCount: 7 }],
            },
            {
              seasonNumber: 3,
              availableEpisodeCount: 10,
              users: [{ key: 'two', userId: 2, watchedEpisodeCount: 7 }],
            },
          ]),
        loadTvMetadata: async () =>
          metadata(
            [1, 2, 3, 4].map((seasonNumber) => ({
              seasonNumber,
              episodes: 10,
            }))
          ),
        inspectSeason: async (_tmdbId, seasonNumber) =>
          requested.has(seasonNumber)
            ? { state: 'already-requested' }
            : { state: 'eligible' },
        isSeasonPresent: async (_canonicalMediaId, seasonNumber) =>
          seasonNumber === 1 || seasonNumber === 3,
        submitSeason: async (_tmdbId, seasonNumber) => {
          submissions.push(seasonNumber);
          requested.add(seasonNumber);
          return { id: seasonNumber };
        },
        now: () => {
          if (!deadlineEnabled) return new Date(now);
          nowCalls += 1;
          return nowCalls >= 4
            ? new Date(now.getTime() + 45_000)
            : new Date(now);
        },
      })
    );

    const first = await service.run();
    assert.equal(first.limitReason, 'deadline');
    assert.equal(first.requested, 1);
    assert.deepEqual(submissions, [2]);

    deadlineEnabled = false;
    const second = await service.run();
    assert.equal(second.requested, 1);
    assert.deepEqual(submissions, [2, 4]);
  });

  it('retains the real cursor when cancellation interrupts a multi-target Series', async () => {
    await seedActiveSeries(2251);
    const requested = new Set<number>();
    const submissions: number[] = [];
    let cancelOnSubmit = true;
    let cancelService: () => void = () => undefined;
    const service = new NextSeasonService(
      dependencies({
        loadActiveSeries: loadActiveNextSeasonSeries,
        loadSeriesProgress: async () =>
          detail([
            {
              seasonNumber: 1,
              availableEpisodeCount: 10,
              users: [{ key: 'one', userId: 1, watchedEpisodeCount: 7 }],
            },
            {
              seasonNumber: 3,
              availableEpisodeCount: 10,
              users: [{ key: 'two', userId: 2, watchedEpisodeCount: 7 }],
            },
          ]),
        loadTvMetadata: async () =>
          metadata(
            [1, 2, 3, 4].map((seasonNumber) => ({
              seasonNumber,
              episodes: 10,
            }))
          ),
        inspectSeason: async (_tmdbId, seasonNumber) =>
          requested.has(seasonNumber)
            ? { state: 'already-requested' }
            : { state: 'eligible' },
        isSeasonPresent: async (_canonicalMediaId, seasonNumber) =>
          seasonNumber === 1 || seasonNumber === 3,
        submitSeason: async (_tmdbId, seasonNumber) => {
          submissions.push(seasonNumber);
          requested.add(seasonNumber);
          if (cancelOnSubmit) cancelService();
          return { id: seasonNumber };
        },
      })
    );
    cancelService = () => service.cancel();

    const first = await service.run();
    assert.equal(first.limitReason, 'cancelled');
    assert.deepEqual(submissions, [2]);

    cancelOnSubmit = false;
    const second = await service.run();
    assert.equal(second.requested, 1);
    assert.deepEqual(submissions, [2, 4]);
  });

  it('continues from the first unprocessed real candidate after the metadata budget', async () => {
    for (let index = 0; index < 11; index += 1) {
      await seedActiveSeries(2301 + index);
    }
    let runNumber = 1;
    const metadataIdsByRun = new Map<number, number[]>();
    const service = new NextSeasonService(
      dependencies({
        loadActiveSeries: loadActiveNextSeasonSeries,
        loadTvMetadata: async (tmdbId) => {
          const ids = metadataIdsByRun.get(runNumber) ?? [];
          ids.push(tmdbId);
          metadataIdsByRun.set(runNumber, ids);
          return {
            ...metadata([{ seasonNumber: 1 }, { seasonNumber: 2 }]),
            id: tmdbId,
          };
        },
        inspectSeason: async () => ({ state: 'already-requested' }),
      })
    );

    const first = await service.run({ dryRun: true });
    assert.equal(first.metadataLookups, 10);
    assert.equal(first.limitReason, 'metadata-limit');
    assert.equal(first.alreadyRequested, 10);

    runNumber = 2;
    const second = await service.run({ dryRun: true });
    assert.equal(second.limitReason, 'metadata-limit');
    assert.equal(metadataIdsByRun.get(2)?.[0], 2311);
  });
});
