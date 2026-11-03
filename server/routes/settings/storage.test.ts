import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import request from 'supertest';

import storageRoutes, {
  createSeriesRelocationPreviewHandler,
  OVERFLOW_ROUTE_REQUIRED_MESSAGE,
  overflowSettingsSchema,
} from '@server/routes/settings/storage';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

const app = express();
app.use(express.json());
app.use('/settings/storage', storageRoutes);
app.use(
  (
    error: { status?: number; message?: string },
    _req: Request,
    res: Response,
    _next: NextFunction
  ) => {
    void _next;
    return res
      .status(error.status ?? 500)
      .json({ message: error.message ?? 'Unexpected error.' });
  }
);

describe('Storage settings route validation', () => {
  const route = {
    sourceVolumeId: 'physical:volume1',
    destinationVolumeId: 'physical:volume9',
    thresholdGb: 50,
    enabled: true,
  };
  const settings = {
    enabled: true,
    freeSpaceThreshold: 10,
    automaticSeriesPlacement: false,
    defaultSeriesVolumeId: null,
    expansionSeriesVolumeId: null,
    seriesSeasonThreshold: 3,
    torrentRelocationDelayHours: 48,
    routes: [route],
  };

  it('accepts compatible typed volume mappings', () => {
    assert.equal(overflowSettingsSchema.safeParse(settings).success, true);
    assert.equal(
      overflowSettingsSchema.safeParse({
        ...settings,
        enabled: false,
        automaticSeriesPlacement: true,
        defaultSeriesVolumeId: 'physical:volume3',
        expansionSeriesVolumeId: 'physical:volume9',
        routes: [],
      }).success,
      true,
      'Automatic Series Placement does not require Overflow Routing or a route'
    );
  });

  it('allows no enabled routes only while Overflow Routing is disabled', () => {
    for (const routes of [[], [{ ...route, enabled: false }]]) {
      assert.equal(
        overflowSettingsSchema.safeParse({
          ...settings,
          enabled: false,
          routes,
        }).success,
        true
      );
    }

    for (const routes of [[], [{ ...route, enabled: false }]]) {
      const result = overflowSettingsSchema.safeParse({
        ...settings,
        enabled: true,
        routes,
      });
      assert.equal(result.success, false);
      if (!result.success) {
        assert.ok(
          result.error.issues.some(
            (issue) =>
              issue.path.join('.') === 'routes' &&
              issue.message === OVERFLOW_ROUTE_REQUIRED_MESSAGE
          )
        );
      }
    }
  });

  it('rejects direct API submissions with the actionable activation error', async () => {
    for (const routes of [[], [{ ...route, enabled: false }]]) {
      const response = await request(app)
        .post('/settings/storage')
        .send({ ...settings, enabled: true, routes });
      assert.equal(response.status, 400);
      assert.equal(response.body.message, OVERFLOW_ROUTE_REQUIRED_MESSAGE);
    }
  });

  it('returns the three read-only Series Relocation preview states', async () => {
    const results = [
      {
        status: 'eligible' as const,
        candidate: {
          canonicalMediaId: 42,
          title: 'Example Series',
          year: 2020,
          retainedSeasonCount: 4,
          totalBytes: '123456789',
          sonarrUrl: 'https://sonarr.example.test/series/example-series',
        },
        reason: null,
      },
      { status: 'none' as const, candidate: null, reason: null },
      {
        status: 'unavailable' as const,
        candidate: null,
        reason: 'provider-unavailable' as const,
      },
    ];
    for (const result of results) {
      const previewApp = express();
      previewApp.get(
        '/settings/storage/series-relocation/next-candidate',
        createSeriesRelocationPreviewHandler(async () => result)
      );
      const response = await request(previewApp).get(
        '/settings/storage/series-relocation/next-candidate'
      );
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, result);
      assert.doesNotMatch(
        JSON.stringify(response.body),
        /apiKey|downloadPath|torrentHash|sourcePath|destinationPath/i
      );
    }
  });

  it('inherits administrator-only authorization from the Settings router', () => {
    const routes = readFileSync(path.join(__dirname, '../index.ts'), 'utf8');
    assert.match(
      routes,
      /router\.use\('\/settings', isAuthenticated\(Permission\.ADMIN\), settingsRoutes\)/
    );
  });

  it('accepts only the four supported threshold values', () => {
    for (const freeSpaceThreshold of [5, 10, 15, 20]) {
      assert.equal(
        overflowSettingsSchema.safeParse({ ...settings, freeSpaceThreshold })
          .success,
        true
      );
    }
  });

  it('rejects self-routes, unsafe identifiers, unknown fields, and duplicates', () => {
    for (const invalidSettings of [
      {
        ...settings,
        routes: [{ ...route, destinationVolumeId: 'physical:volume1' }],
      },
      { ...settings, routes: [{ ...route, sourceVolumeId: 'bad' }] },
      { ...settings, routes: [{ ...route, thresholdGb: 0 }] },
      { ...settings, routes: [{ ...route, thresholdGb: 1.5 }] },
      { ...settings, routes: [{ ...route, extra: true }] },
      { ...settings, routes: [route, route] },
      { ...settings, routes: [], extra: true },
      { ...settings, freeSpaceThreshold: 0 },
      { ...settings, freeSpaceThreshold: 7.5 },
      { ...settings, freeSpaceThreshold: 25 },
      { ...settings, freeSpaceThreshold: Number.NaN },
      {
        ...settings,
        automaticSeriesPlacement: true,
        defaultSeriesVolumeId: 'physical:volume3',
        expansionSeriesVolumeId: 'physical:volume3',
      },
    ]) {
      assert.equal(
        overflowSettingsSchema.safeParse(invalidSettings).success,
        false
      );
    }
  });
});
