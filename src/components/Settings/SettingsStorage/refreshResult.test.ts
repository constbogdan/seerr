import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { StorageInstanceStatus } from '@server/lib/storageSettings';

import { classifyStorageRefresh } from './refreshResult';

const instance = (
  overrides: Partial<StorageInstanceStatus> = {}
): StorageInstanceStatus => ({
  provider: 'radarr',
  serviceId: 1,
  serviceName: 'Movies',
  available: true,
  capacityAvailable: true,
  ...overrides,
});

describe('Storage capacity refresh results', () => {
  it('reports success only when every configured service returned roots and capacity', () => {
    assert.deepEqual(
      classifyStorageRefresh([
        instance(),
        instance({
          provider: 'sonarr',
          serviceId: 2,
          serviceName: 'Shows',
        }),
      ]),
      { status: 'success', failedServices: [] }
    );
  });

  it('reports a partial failure and identifies root or capacity failures', () => {
    assert.deepEqual(
      classifyStorageRefresh([
        instance(),
        instance({
          provider: 'sonarr',
          serviceId: 2,
          serviceName: 'Shows',
          capacityAvailable: false,
        }),
      ]),
      { status: 'partial', failedServices: ['Sonarr · Shows'] }
    );
  });

  it('reports complete failure when every service failed or none were attempted', () => {
    assert.deepEqual(
      classifyStorageRefresh([
        instance({ available: false }),
        instance({
          provider: 'sonarr',
          serviceId: 2,
          serviceName: 'Shows',
          capacityAvailable: false,
        }),
      ]),
      {
        status: 'failure',
        failedServices: ['Radarr · Movies', 'Sonarr · Shows'],
      }
    );
    assert.deepEqual(classifyStorageRefresh([]), {
      status: 'failure',
      failedServices: [],
    });
  });

  it('does not mistake duplicate service labels for a partial success', () => {
    assert.deepEqual(
      classifyStorageRefresh([
        instance({ available: false }),
        instance({ serviceId: 2, available: false }),
      ]),
      { status: 'failure', failedServices: ['Radarr · Movies'] }
    );
  });
});
