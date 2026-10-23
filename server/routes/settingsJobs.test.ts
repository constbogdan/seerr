import { scheduledJobs } from '@server/job/schedule';
import { Permission } from '@server/lib/permissions';
import { isAuthenticated } from '@server/middleware/auth';
import settingsRoutes from '@server/routes/settings';
import express from 'express';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import request from 'supertest';

const app = express();
app.use(express.json());
app.use((req, _res, next) => {
  const role = req.header('x-test-role');
  if (role) {
    req.user = {
      id: 1,
      hasPermission: () => role === 'admin',
    } as unknown as Express.Request['user'];
  }
  next();
});
app.use('/settings', isAuthenticated(Permission.ADMIN), settingsRoutes);

describe('Next Season settings job authorization', () => {
  let dryRunCalls = 0;

  before(() => {
    scheduledJobs.push({
      id: 'next-season',
      name: 'Next Season',
      type: 'process',
      interval: 'minutes',
      cronSchedule: '15 */5 * * * *',
      job: {} as (typeof scheduledJobs)[number]['job'],
      dryRun: async () => {
        dryRunCalls += 1;
        return { status: 'succeeded', dryRun: true };
      },
    });
  });

  after(() => {
    const index = scheduledJobs.findIndex((job) => job.id === 'next-season');
    if (index >= 0) scheduledJobs.splice(index, 1);
  });

  it('allows only administrators to execute the non-mutating dry run', async () => {
    assert.equal(
      (await request(app).post('/settings/jobs/next-season/dry-run')).status,
      403
    );
    assert.equal(
      (
        await request(app)
          .post('/settings/jobs/next-season/dry-run')
          .set('x-test-role', 'user')
      ).status,
      403
    );
    assert.equal(dryRunCalls, 0);

    const response = await request(app)
      .post('/settings/jobs/next-season/dry-run')
      .set('x-test-role', 'admin');
    assert.equal(response.status, 200);
    assert.equal(response.body.dryRun, true);
    assert.equal(dryRunCalls, 1);
  });
});
