import type {
  LibraryBulkActionRequest,
  LibraryBulkActionResponse,
} from '@server/interfaces/api/libraryInterfaces';
import { LibraryBulkActionValidationError } from '@server/lib/libraryBulkActions';
import { isAuthenticated } from '@server/middleware/auth';
import { createLibraryRouter } from '@server/routes/library';
import express from 'express';
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import request from 'supertest';

let calls: LibraryBulkActionRequest[] = [];
const response = (
  input: LibraryBulkActionRequest
): LibraryBulkActionResponse => ({
  action: input.action,
  requested: input.targets.length,
  succeeded: input.targets.length,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  results: input.targets.map((target) => ({
    target,
    outcome:
      input.action === 'schedule'
        ? 'scheduled'
        : input.action === 'cancel_schedule'
          ? 'cancelled'
          : 'provider_acknowledged',
    code: 'ok',
    retryable: false,
    message: 'Processed.',
    affectedSchedules: 1,
  })),
});

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  req.user = {
    id: 1,
    hasPermission: () => req.header('x-test-role') === 'admin',
  } as unknown as Express.Request['user'];
  next();
});
app.use(
  '/library',
  isAuthenticated(),
  createLibraryRouter(
    {
      query: async () => ({}) as never,
      seriesDetail: async () => null,
      userAvailability: async () => ({ users: [] }),
    },
    {
      previewEligibility: async (targets) => ({
        results: targets.map((target) => ({
          target,
          eligibility:
            target.canonicalMediaId % 2 === 0
              ? ('cancel_schedule' as const)
              : ('schedule' as const),
          reason:
            target.canonicalMediaId % 2 === 0
              ? ('scheduled' as const)
              : ('unscheduled' as const),
        })),
      }),
      execute: async (input) => {
        calls.push(input);
        if (input.targets[0]?.canonicalMediaId === 999) {
          throw new LibraryBulkActionValidationError(
            'Canonical media 999 does not exist.'
          );
        }
        return response(input);
      },
    },
    {
      project: async (targets) => ({
        targets,
        sizeBytes: '3072',
        fileCount: 3,
        unknownFileCount: 1,
      }),
    }
  )
);
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

describe('Library bulk-actions route', () => {
  beforeEach(() => {
    calls = [];
  });

  it('requires ADMIN and preserves deterministic target order', async () => {
    const body: LibraryBulkActionRequest = {
      action: 'schedule',
      targets: [
        { canonicalMediaId: 8, targetType: 'movie' },
        { canonicalMediaId: 4, targetType: 'season', seasonNumber: 2 },
      ],
    };
    assert.equal(
      (await request(app).post('/library/bulk-actions').send(body)).status,
      403
    );
    const processed = await request(app)
      .post('/library/bulk-actions')
      .set('x-test-role', 'admin')
      .send(body);
    assert.equal(processed.status, 200);
    assert.deepEqual(
      processed.body.results.map(({ target }: { target: unknown }) => target),
      body.targets
    );
    assert.equal(calls.length, 1);
  });

  it('provides an ADMIN-only read-only eligibility preview in target order', async () => {
    const targets: LibraryBulkActionRequest['targets'] = [
      { canonicalMediaId: 7, targetType: 'movie' },
      { canonicalMediaId: 8, targetType: 'season', seasonNumber: 2 },
    ];
    assert.equal(
      (
        await request(app)
          .post('/library/bulk-actions/eligibility')
          .send({ targets })
      ).status,
      403
    );
    const preview = await request(app)
      .post('/library/bulk-actions/eligibility')
      .set('x-test-role', 'admin')
      .send({ targets });
    assert.equal(preview.status, 200);
    assert.deepEqual(
      preview.body.results.map(
        ({ eligibility }: { eligibility: string }) => eligibility
      ),
      ['schedule', 'cancel_schedule']
    );
    assert.equal(calls.length, 0);
  });

  it('provides an ADMIN-only read-only selected-size projection in target order', async () => {
    const targets: LibraryBulkActionRequest['targets'] = [
      { canonicalMediaId: 7, targetType: 'movie' },
      { canonicalMediaId: 8, targetType: 'season', seasonNumber: 2 },
    ];
    assert.equal(
      (await request(app).post('/library/selection-size').send({ targets }))
        .status,
      403
    );
    const projection = await request(app)
      .post('/library/selection-size')
      .set('x-test-role', 'admin')
      .send({ targets });
    assert.equal(projection.status, 200);
    assert.deepEqual(projection.body, {
      targets,
      sizeBytes: '3072',
      fileCount: 3,
      unknownFileCount: 1,
    });
    assert.equal(calls.length, 0);
  });

  it('allows selected-size projection across more than four 25-item pages', async () => {
    const targets: LibraryBulkActionRequest['targets'] = Array.from(
      { length: 101 },
      (_, index) => ({
        canonicalMediaId: index + 1,
        targetType: 'movie' as const,
      })
    );
    const projection = await request(app)
      .post('/library/selection-size')
      .set('x-test-role', 'admin')
      .send({ targets });
    assert.equal(projection.status, 200);
    assert.equal(projection.body.targets.length, 101);
    assert.equal(calls.length, 0);
  });

  it('rejects duplicate and overlapping read-only projection targets', async () => {
    for (const endpoint of [
      '/library/bulk-actions/eligibility',
      '/library/selection-size',
    ]) {
      for (const targets of [
        [
          { canonicalMediaId: 1, targetType: 'movie' },
          { canonicalMediaId: 1, targetType: 'movie' },
        ],
        [
          { canonicalMediaId: 2, targetType: 'series' },
          { canonicalMediaId: 2, targetType: 'season', seasonNumber: 1 },
        ],
      ]) {
        const rejected = await request(app)
          .post(endpoint)
          .set('x-test-role', 'admin')
          .send({ targets });
        assert.equal(rejected.status, 400);
      }
    }
    assert.equal(calls.length, 0);
  });

  it('rejects unsupported actions, extra source fields, duplicates, overlaps, and oversized batches before execution', async () => {
    const invalidBodies = [
      { action: 'schedule', targets: [] },
      {
        action: 'erase',
        targets: [{ canonicalMediaId: 1, targetType: 'movie' }],
      },
      {
        action: 'schedule',
        targets: [{ canonicalMediaId: 1, targetType: 'season' }],
      },
      {
        action: 'schedule',
        targets: [
          { canonicalMediaId: 1, targetType: 'movie', seasonNumber: 1 },
        ],
      },
      {
        action: 'schedule',
        targets: [
          {
            canonicalMediaId: 1,
            targetType: 'movie',
            sourceScope: 'service:1',
          },
        ],
      },
      {
        action: 'schedule',
        targets: [
          { canonicalMediaId: 1, targetType: 'movie' },
          { canonicalMediaId: 1, targetType: 'movie' },
        ],
      },
      {
        action: 'cancel_schedule',
        targets: [
          { canonicalMediaId: 2, targetType: 'series' },
          { canonicalMediaId: 2, targetType: 'season', seasonNumber: 1 },
        ],
      },
      {
        action: 'schedule',
        targets: Array.from({ length: 101 }, (_, index) => ({
          canonicalMediaId: index + 1,
          targetType: 'movie',
        })),
      },
      {
        action: 'remove_now',
        targets: Array.from({ length: 11 }, (_, index) => ({
          canonicalMediaId: index + 1,
          targetType: 'movie',
        })),
      },
    ];
    for (const body of invalidBodies) {
      const rejected = await request(app)
        .post('/library/bulk-actions')
        .set('x-test-role', 'admin')
        .send(body);
      assert.equal(rejected.status, 400);
    }
    const malformed = await request(app)
      .post('/library/bulk-actions')
      .set('x-test-role', 'admin')
      .set('content-type', 'application/json')
      .send('{');
    assert.equal(malformed.status, 400);
    assert.equal(calls.length, 0);
  });

  it('accepts an ADMIN-only Remove Now batch of at most ten typed targets', async () => {
    const body: LibraryBulkActionRequest = {
      action: 'remove_now',
      targets: [
        { canonicalMediaId: 7, targetType: 'movie' },
        { canonicalMediaId: 9, targetType: 'season', seasonNumber: 0 },
      ],
    };
    assert.equal(
      (await request(app).post('/library/bulk-actions').send(body)).status,
      403
    );
    const processed = await request(app)
      .post('/library/bulk-actions')
      .set('x-test-role', 'admin')
      .send(body);
    assert.equal(processed.status, 200);
    assert.deepEqual(
      processed.body.results.map(({ outcome }: { outcome: string }) => outcome),
      ['provider_acknowledged', 'provider_acknowledged']
    );
  });

  it('returns request-level identity validation errors without a processed response', async () => {
    const rejected = await request(app)
      .post('/library/bulk-actions')
      .set('x-test-role', 'admin')
      .send({
        action: 'cancel_schedule',
        targets: [{ canonicalMediaId: 999, targetType: 'movie' }],
      });
    assert.equal(rejected.status, 400);
    assert.match(rejected.body.message, /does not exist/);
  });
});
