import { STORAGE_ROOT_COLOR_PALETTE } from '@server/constants/storageRoot';
import cookieParser from 'cookie-parser';
import express from 'express';
import * as OpenApiValidator from 'express-openapi-validator';
import { load } from 'js-yaml';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';

const API_SPEC_PATH = path.join(__dirname, '../../seerr-api.yml');

describe('OpenAPI runtime schema', () => {
  it('publishes the user-scoped Leaving Soon presentation lifecycle', () => {
    const spec = load(readFileSync(API_SPEC_PATH, 'utf8')) as {
      paths: Record<string, unknown>;
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    assert.ok(spec.paths['/leaving-soon']);
    assert.ok(spec.paths['/leaving-soon/presentation-status/{batchId}']);
    assert.ok(
      spec.components.schemas.LeavingSoonResultsResponse.properties
        ?.presentation
    );
  });

  it('keeps Watchlist ownership on the active compatibility schema', () => {
    const spec = load(readFileSync(API_SPEC_PATH, 'utf8')) as {
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    assert.ok(spec.components.schemas.Watchlist.properties?.requestedBy);
    assert.equal(
      spec.components.schemas.WatchlistHistoryResponse.properties?.requestedBy,
      undefined
    );
  });

  it('exposes one factual Library contract with no Retention surface', () => {
    const spec = load(readFileSync(API_SPEC_PATH, 'utf8')) as {
      paths: Record<
        string,
        {
          get?: {
            parameters?: { name: string }[];
          };
        }
      >;
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    assert.ok(spec.paths['/library']);
    assert.ok(spec.paths['/library/bulk-actions']);
    assert.ok(spec.paths['/library/bulk-actions/eligibility']);
    assert.ok(spec.paths['/library/{canonicalMediaId}/series-detail']);
    assert.ok(spec.paths['/settings/history-import']);
    assert.ok(spec.paths['/settings/history-import/validate']);
    assert.equal(spec.paths['/admin/phase-c-reconciliation'], undefined);
    for (const retired of [
      '/library-cleanup',
      '/library-history',
      '/settings/retention',
    ])
      assert.equal(spec.paths[retired], undefined);
    assert.equal(
      Object.keys(spec.components.schemas).some(
        (name) =>
          name.includes('Retention') ||
          name.includes('Protection') ||
          name.includes('HistoricalSourceMedia')
      ),
      false
    );
    assert.deepEqual(
      spec.paths['/library'].get?.parameters
        ?.map(({ name }) => name)
        .filter((name) => name === 'watched' || name === 'viewing'),
      ['watched']
    );
    assert.ok(
      spec.paths['/library'].get?.parameters?.some(
        ({ name }) => name === 'scope'
      )
    );
    for (const pathName of ['/library', '/library/user-availability'])
      assert.ok(
        spec.paths[pathName].get?.parameters?.some(
          ({ name }) => name === 'animation'
        )
      );
    assert.ok(
      spec.components.schemas.StorageRootDisplayNameInput.properties
        ?.isAnimation
    );
    assert.ok(
      spec.components.schemas.StorageRootWithDisplayName.properties?.isAnimation
    );
    for (const schemaName of [
      'StorageRootDisplayNameInput',
      'StorageRootWithDisplayName',
    ]) {
      const color = spec.components.schemas[schemaName].properties?.color as {
        enum?: (string | null)[];
        nullable?: boolean;
      };
      assert.equal(color.nullable, true);
      assert.deepEqual(color.enum, [...STORAGE_ROOT_COLOR_PALETTE, null]);
    }
    const overflowSettings = spec.components.schemas.OverflowSettings as {
      properties?: Record<
        string,
        {
          enum?: (number | string)[];
          default?: number | string;
          minimum?: number;
          type?: string;
        }
      >;
      required?: string[];
    };
    assert.deepEqual(overflowSettings.required, [
      'enabled',
      'freeSpaceThreshold',
      'automaticSeriesPlacement',
      'defaultSeriesVolumeId',
      'expansionSeriesVolumeId',
      'seriesSeasonThreshold',
      'torrentRelocationDelayHours',
      'routes',
    ]);
    assert.deepEqual(overflowSettings.properties?.freeSpaceThreshold, {
      type: 'integer',
      enum: [5, 10, 15, 20],
      default: 10,
    });
    assert.deepEqual(overflowSettings.properties?.automaticSeriesPlacement, {
      type: 'boolean',
      default: false,
    });
    const overflowRoute = spec.components.schemas.OverflowRoute as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    assert.deepEqual(overflowRoute.required, [
      'sourceVolumeId',
      'destinationVolumeId',
      'thresholdGb',
      'enabled',
    ]);
    assert.deepEqual(overflowRoute.properties?.thresholdGb, {
      type: 'integer',
      minimum: 1,
      default: 50,
    });
    assert.ok(spec.paths['/settings/storage/series-relocation/next-candidate']);
    assert.ok(spec.paths['/settings/watchlist-roulette']);
    assert.ok(spec.components.schemas.WatchlistRouletteSettings);
    assert.ok(spec.components.schemas.WatchlistRouletteSettingsResponse);
    const seriesRelocationPreviewResult = spec.components.schemas
      .SeriesRelocationPreviewResult as {
      required?: string[];
      properties?: Record<string, unknown>;
    };
    assert.deepEqual(seriesRelocationPreviewResult.required, [
      'status',
      'candidate',
      'reason',
    ]);
    assert.deepEqual(
      (
        seriesRelocationPreviewResult.properties?.status as {
          enum?: string[];
        }
      ).enum,
      ['eligible', 'none', 'unavailable']
    );
    const seriesRelocationPreviewCandidate = spec.components.schemas
      .SeriesRelocationPreviewCandidate as { required?: string[] };
    assert.deepEqual(seriesRelocationPreviewCandidate.required, [
      'canonicalMediaId',
      'title',
      'year',
      'retainedSeasonCount',
      'totalBytes',
      'sonarrUrl',
    ]);
    assert.ok(spec.components.schemas.LibraryItem.properties?.watchedUsers);
    assert.ok(spec.components.schemas.LibraryItem.properties?.watchedUserCount);
    assert.ok(spec.components.schemas.LibraryItem.properties?.hasWatchedDetail);
    assert.ok(spec.components.schemas.LibraryItem.properties?.lastActiveUsers);
    assert.ok(spec.components.schemas.LibraryItem.properties?.requesters);
    assert.equal(
      spec.components.schemas.LibraryItem.properties?.lastActiveUser,
      undefined
    );
    assert.ok(spec.components.schemas.LibraryRequester);
    assert.ok(spec.components.schemas.LibraryRequestFact);
    assert.ok(spec.components.schemas.LibraryRequestSeasonFact);
    assert.deepEqual(
      (
        spec.components.schemas.LibraryBulkActionRequest.properties?.action as {
          enum?: string[];
        }
      ).enum,
      ['schedule', 'cancel_schedule', 'remove_now']
    );
    assert.deepEqual(
      (
        spec.components.schemas.LibraryBulkActionEligibilityResult.properties
          ?.eligibility as { enum?: string[] }
      ).enum,
      ['schedule', 'cancel_schedule', 'unavailable', 'conflict', 'unknown']
    );
    const bulkOutcomes = (
      spec.components.schemas.LibraryBulkActionResult.properties?.outcome as {
        enum?: string[];
      }
    ).enum;
    for (const outcome of [
      'provider_acknowledged',
      'provider_absent_reconciled',
      'cross_season_file',
      'remote_removed_local_failed',
      'not_attempted',
    ]) {
      assert.ok(bulkOutcomes?.includes(outcome));
    }
    assert.ok(spec.components.schemas.LibraryItem.properties?.storageRoots);
    assert.ok(spec.components.schemas.LibraryItem.properties?.fresh);
    assert.deepEqual(
      spec.components.schemas.LibraryItem.properties?.resolution,
      {
        type: 'integer',
        nullable: true,
        enum: [1080, 2160],
        description:
          'Uniform confirmed resolution across every applicable file; null when files are missing resolution, mixed, or use another resolution.',
      }
    );
    const seasonSummaries = spec.components.schemas.LibraryItem.properties
      ?.seasonSummaries as {
      items?: {
        properties?: Record<string, unknown>;
        required?: string[];
      };
    };
    assert.ok(seasonSummaries);
    assert.ok(seasonSummaries.items?.required?.includes('knownEpisodeCount'));
    assert.deepEqual(seasonSummaries.items?.properties?.knownEpisodeCount, {
      type: 'integer',
      minimum: 1,
      nullable: true,
      description:
        'Distinct canonical Episode count when the Foundation has a reliable complete Season hierarchy; null when the total is unknown or incomplete.',
    });
    assert.ok(seasonSummaries.items?.required?.includes('resolution'));
    assert.deepEqual(seasonSummaries.items?.properties?.resolution, {
      type: 'integer',
      nullable: true,
      enum: [1080, 2160],
      description:
        'Uniform confirmed resolution across every applicable file in the Season.',
    });
    assert.ok(seasonSummaries.items?.required?.includes('requestable'));
    assert.deepEqual(seasonSummaries.items?.properties?.requestable, {
      type: 'boolean',
      description:
        'Whether the existing standard Seerr request workflow currently considers this Season requestable before user-specific permission and settings checks.',
    });
    assert.ok(spec.components.schemas.LibraryItem.properties?.externalLinks);
    assert.ok(spec.components.schemas.LibraryItem.properties?.tmdbRating);
    assert.ok(spec.components.schemas.LibraryItem.properties?.backdropPath);
    assert.deepEqual(
      spec.components.schemas.LibraryItem.properties?.removedAt,
      { type: 'string', format: 'date-time', nullable: true }
    );
    assert.deepEqual(
      spec.components.schemas.LibraryItem.properties?.removalSource,
      {
        type: 'string',
        nullable: true,
        enum: ['manual', 'scheduled', 'external', 'unknown'],
      }
    );
    assert.equal(
      spec.components.schemas.LibraryItem.properties?.viewingUsers,
      undefined
    );
    assert.ok(spec.components.schemas.LibrarySeriesDetail.properties?.seasons);
    const removalOperation = spec.paths[
      '/library/{canonicalMediaId}/remove'
    ] as unknown as {
      post: {
        requestBody: {
          content: { 'application/json': { schema: { $ref: string } } };
        };
        responses: Record<
          string,
          { content?: { 'application/json'?: { schema?: { $ref?: string } } } }
        >;
      };
    };
    assert.equal(
      removalOperation.post.requestBody.content['application/json'].schema.$ref,
      '#/components/schemas/LibraryRemovalTargetRequest'
    );
    assert.equal(
      removalOperation.post.responses['200'].content?.['application/json']
        ?.schema?.$ref,
      '#/components/schemas/LibraryRemovalResult'
    );
    for (const status of ['400', '403', '404', '409', '503']) {
      assert.ok(removalOperation.post.responses[status]);
    }
    assert.deepEqual(
      spec.components.schemas.LibraryRemovalResult.properties?.providerResult,
      {
        type: 'string',
        enum: ['removed', 'absent'],
        description:
          'removed means the provider acknowledged the command; absent means read-only provider reconciliation confirmed the target absent. Neither value independently guarantees physical file deletion.',
      }
    );
    assert.deepEqual(
      (
        spec.components.schemas.Watchlist as {
          required?: string[];
        }
      ).required,
      ['tmdbId', 'mediaType']
    );
    const watchlistDelete = spec.paths['/watchlist/{tmdbId}'] as unknown as {
      delete: {
        parameters: { schema: Record<string, unknown> }[];
      };
    };
    assert.deepEqual(watchlistDelete.delete.parameters[0].schema, {
      type: 'string',
      pattern: '^[0-9]+$',
    });
    const seriesDetailSeasons = spec.components.schemas.LibrarySeriesDetail
      .properties?.seasons as {
      items?: {
        properties?: Record<string, unknown>;
        required?: string[];
      };
    };
    assert.ok(seriesDetailSeasons.items?.required?.includes('sizeBytes'));
    assert.deepEqual(seriesDetailSeasons.items?.properties?.sizeBytes, {
      type: 'string',
      nullable: true,
      description:
        'Current physical Season size for Current detail, or a historical file-size aggregate for Archive detail; null when any applicable file size is unknown.',
    });
    assert.equal(
      spec.components.schemas.LibrarySeriesDetail.properties?.viewers,
      undefined
    );
  });

  it('exposes only the final per-run Removal policy contract', () => {
    const spec = load(readFileSync(API_SPEC_PATH, 'utf8')) as {
      components: {
        schemas: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    assert.deepEqual(
      Object.keys(
        spec.components.schemas.RemovalAutomaticPolicy.properties ?? {}
      ).sort(),
      ['enabled', 'inactivityMonths', 'itemsPerRun', 'minimumAgeMonths']
    );
    assert.deepEqual(
      Object.keys(
        spec.components.schemas.RemovalPreviewPool.properties ?? {}
      ).sort(),
      [
        'candidates',
        'eligibleUnscheduled',
        'itemsPerRun',
        'maximumSelectableMonths',
        'oldestCurrentAddedAt',
      ]
    );
    assert.deepEqual(
      Object.keys(
        spec.components.schemas.RemovalPreview.properties ?? {}
      ).sort(),
      ['actionableScheduleCount', 'movie', 'series']
    );
    assert.deepEqual(
      spec.components.schemas.RemovalSettings.properties?.removalDelayDays,
      { type: 'integer', enum: [10, 20, 30, 60, 90] }
    );
  });

  it('is accepted by the same middleware Seerr installs at runtime', async () => {
    const app = express();
    app.use(cookieParser());
    app.use(express.json());
    app.use(
      OpenApiValidator.middleware({
        apiSpec: API_SPEC_PATH,
        validateRequests: true,
      })
    );
    app.get('/api/v1/fresh', (_req, res) => res.status(200).json({ ok: true }));
    app.put('/api/v1/settings/radarr/:radarrId', (req, res) =>
      res.status(200).json(req.body)
    );
    app.put('/api/v1/settings/sonarr/:sonarrId', (req, res) =>
      res.status(200).json(req.body)
    );
    app.use(
      (
        error: { message?: string; status?: number },
        _req: express.Request,
        res: express.Response,
        next: express.NextFunction
      ) => {
        void next;
        return res.status(error.status ?? 500).json({ message: error.message });
      }
    );

    const authenticatedGet = (requestPath: string) =>
      request(app).get(requestPath).set('Cookie', 'connect.sid=test-session');
    const response = await authenticatedGet('/api/v1/fresh');
    assert.equal(response.status, 200, response.body?.message);
    assert.deepEqual(response.body, { ok: true });
    assert.equal(
      (
        await authenticatedGet(
          '/api/v1/fresh?page=1&mediaType=movie&sort=vote_average.desc'
        )
      ).status,
      200
    );
    assert.equal((await authenticatedGet('/api/v1/fresh?page=0')).status, 400);
    assert.equal(
      (await authenticatedGet('/api/v1/fresh?unknown=true')).status,
      400
    );

    const commonSettings = {
      name: 'Test',
      hostname: 'localhost',
      apiKey: 'test-key',
      useSsl: false,
      activeProfileId: 1,
      activeProfileName: 'HD',
      activeDirectory: '/media',
      is4k: false,
      isDefault: true,
    };
    const requestBodies = [
      {
        path: '/api/v1/settings/radarr/1',
        body: {
          ...commonSettings,
          port: 7878,
          minimumAvailability: 'released',
        },
      },
      {
        path: '/api/v1/settings/sonarr/1',
        body: {
          ...commonSettings,
          port: 8989,
          seriesType: 'standard',
          animeSeriesType: 'anime',
          enableSeasonFolders: true,
          monitorNewItems: 'all',
        },
      },
    ];
    for (const { path: requestPath, body } of requestBodies) {
      for (const rootFolder of [
        { sourceRootId: 1, path: '/media', color: null },
        { sourceRootId: 1, path: '/media', color: '#60a5fa' },
        { sourceRootId: 1, path: '/media' },
      ]) {
        const saveResponse = await request(app)
          .put(requestPath)
          .set('Cookie', 'connect.sid=test-session')
          .send({ ...body, rootFolderNames: [rootFolder] });
        assert.equal(saveResponse.status, 200, saveResponse.body?.message);
      }
      for (const color of ['', '#ffffff']) {
        const invalidResponse = await request(app)
          .put(requestPath)
          .set('Cookie', 'connect.sid=test-session')
          .send({
            ...body,
            rootFolderNames: [{ sourceRootId: 1, path: '/media', color }],
          });
        assert.equal(invalidResponse.status, 400);
      }
    }
  });
});
