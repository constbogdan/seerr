import { LibraryCollectionsLifecycle } from '@server/lib/libraryCollectionsLifecycle';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('Library Collections lifecycle', () => {
  it('does not schedule automatic work in contained synchronization mode', () => {
    let warms = 0;
    let timers = 0;
    const lifecycle = new LibraryCollectionsLifecycle({
      allowAutomaticWork: () => false,
      warm: () => {
        warms++;
      },
      setTimer: () => {
        timers++;
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      },
    });
    lifecycle.markHttpReady();
    lifecycle.onHistoryCommitted(true, true);
    lifecycle.onConfirmedImport(1);
    lifecycle.onPhysicalChangePending(1, true);
    assert.equal(lifecycle.ready(), false);
    assert.equal(warms, 0);
    assert.equal(timers, 0);
  });

  it('waits for HTTP readiness and successful history hydration, then warms without blocking', () => {
    let warms = 0;
    const lifecycle = new LibraryCollectionsLifecycle({
      warm: () => {
        warms++;
      },
      defaultLocale: () => 'en',
    });
    lifecycle.onHistoryCommitted(false, false);
    lifecycle.markHttpReady();
    assert.equal(warms, 0);
    lifecycle.onHistoryCommitted(true, false);
    assert.equal(warms, 1);
    assert.equal(lifecycle.ready(), true);
  });

  it('distinguishes failed history from incomplete Movie membership and retries without warming', () => {
    let warms = 0;
    const readiness: boolean[] = [];
    const lifecycle = new LibraryCollectionsLifecycle({
      warm: () => {
        warms++;
      },
      setRefreshReady: (ready) => readiness.push(ready),
      setTimer: () => ({ unref: () => undefined }) as unknown as NodeJS.Timeout,
    });
    lifecycle.markHttpReady();
    lifecycle.onHistoryCommitted(false, false, true);
    assert.equal(lifecycle.ready(), false);
    lifecycle.onHistoryCommitted(true, false, false);
    assert.equal(lifecycle.ready(), false);
    assert.equal(warms, 0);
    lifecycle.onHistoryCommitted(true, false, true);
    assert.equal(lifecycle.ready(), true);
    assert.equal(warms, 1);
    assert.deepEqual(readiness, [false, false, false, true]);
  });

  it('coalesces collection imports and skips a confirmed standalone movie', async () => {
    const scheduled: (() => void)[] = [];
    let invalidations = 0;
    const calls: { ids: number[]; maxLookups: number }[] = [];
    const lifecycle = new LibraryCollectionsLifecycle({
      resolve: async (ids, maxLookups) => {
        calls.push({ ids, maxLookups });
        return new Map(
          ids.map(
            (id) => [id, id === 11 ? 'collection' : 'standalone'] as const
          )
        );
      },
      changeSignatures: async (ids) =>
        new Map(ids.map((id) => [id, String(id)])),
      invalidate: () => {
        invalidations++;
      },
      warm: () => undefined,
      hasSnapshot: () => true,
      defaultLocale: () => 'en',
      setTimer: (run) => {
        scheduled.push(run);
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      },
      clearTimer: () => {
        scheduled.shift();
      },
    });
    lifecycle.markHttpReady();
    lifecycle.onHistoryCommitted(true, false);
    lifecycle.onConfirmedImport(11);
    lifecycle.onConfirmedImport(12);
    assert.equal(scheduled.length, 1);
    scheduled.shift()?.();
    await settle();
    assert.equal(invalidations, 1);
    assert.deepEqual(calls, [{ ids: [11, 12], maxLookups: 0 }]);
  });

  it('looks up only unresolved confirmed imports after committed history', async () => {
    const scheduled: (() => void)[] = [];
    let invalidations = 0;
    const calls: { ids: number[]; maxLookups: number }[] = [];
    const lifecycle = new LibraryCollectionsLifecycle({
      resolve: async (ids, maxLookups) => {
        calls.push({ ids, maxLookups });
        return new Map(
          ids.map(
            (id) =>
              [
                id,
                id === 21 && maxLookups ? 'collection' : 'unresolved',
              ] as const
          )
        );
      },
      changeSignatures: async (ids) =>
        new Map(ids.map((id) => [id, String(id)])),
      invalidate: () => {
        invalidations++;
      },
      warm: () => undefined,
      hasSnapshot: () => true,
      defaultLocale: () => 'en',
      setTimer: (run) => {
        scheduled.push(run);
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      },
      clearTimer: () => {
        scheduled.shift();
      },
    });
    lifecycle.markHttpReady();
    lifecycle.onPhysicalChangePending(21, true);
    lifecycle.onPhysicalChangePending(22, false);
    assert.equal(scheduled.length, 0);
    lifecycle.onHistoryCommitted(true, false);
    assert.equal(scheduled.length, 1);
    scheduled.shift()?.();
    await settle();
    assert.deepEqual(calls, [
      { ids: [21, 22], maxLookups: 0 },
      { ids: [21], maxLookups: 1 },
    ]);
    assert.equal(invalidations, 1);
  });

  it('hydrates an external collection import before rebuilding, but skips standalone changes', async () => {
    const scheduled: (() => void)[] = [];
    let hydrated = 0;
    let invalidations = 0;
    const lifecycle = new LibraryCollectionsLifecycle({
      resolve: async (ids) =>
        new Map(
          ids.map(
            (id) => [id, id === 31 ? 'collection' : 'standalone'] as const
          )
        ),
      changeSignatures: async (ids) =>
        new Map(ids.map((id) => [id, String(id)])),
      hydrateHistory: async () => {
        hydrated++;
        lifecycle.onHistoryCommitted(true, true);
        return true;
      },
      invalidate: () => {
        invalidations++;
      },
      warm: () => undefined,
      hasSnapshot: () => true,
      defaultLocale: () => 'en',
      setTimer: (run) => {
        scheduled.push(run);
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      },
      clearTimer: () => {
        scheduled.shift();
      },
    });
    lifecycle.markHttpReady();
    lifecycle.onHistoryCommitted(true, false);
    lifecycle.onPhysicalChangePending(32, true);
    scheduled.shift()?.();
    await settle();
    assert.equal(hydrated, 0);
    lifecycle.onPhysicalChangePending(31, true);
    scheduled.shift()?.();
    await settle();
    assert.equal(hydrated, 1);
    assert.equal(invalidations, 0);
    scheduled.shift()?.();
    await settle();
    assert.equal(invalidations, 1);
  });

  it('deduplicates a targeted import followed by unchanged History, but rebuilds on a distinct state', async () => {
    const scheduled: (() => void)[] = [];
    const state = new Map([[41, 'collection:present:available']]);
    let membership: 'collection' | 'standalone' = 'collection';
    let invalidations = 0;
    const lifecycle = new LibraryCollectionsLifecycle({
      resolve: async (ids) => new Map(ids.map((id) => [id, membership])),
      changeSignatures: async (ids) =>
        new Map(ids.map((id) => [id, state.get(id) ?? 'absent'])),
      hasCurrentPhysicalPresence: async () => true,
      hydrateHistory: async () => {
        lifecycle.onHistoryCommitted(true, false);
        return true;
      },
      invalidate: () => {
        invalidations++;
      },
      warm: () => undefined,
      hasSnapshot: () => true,
      defaultLocale: () => 'en',
      setTimer: (run) => {
        scheduled.push(run);
        return { unref: () => undefined } as unknown as NodeJS.Timeout;
      },
      clearTimer: () => {
        scheduled.shift();
      },
    });
    lifecycle.markHttpReady();
    lifecycle.onHistoryCommitted(true, false);
    lifecycle.onConfirmedImport(41);
    scheduled.shift()?.();
    await settle();
    assert.equal(invalidations, 1);

    lifecycle.onPhysicalChangePending(41, true);
    scheduled.shift()?.();
    await settle();
    scheduled.shift()?.();
    await settle();
    assert.equal(invalidations, 1, 'unchanged History must not rebuild');

    state.set(41, 'collection:absent:unavailable');
    lifecycle.onPhysicalChangePending(41, false);
    scheduled.shift()?.();
    await settle();
    scheduled.shift()?.();
    await settle();
    assert.equal(invalidations, 2, 'final anchor removal must rebuild');

    state.set(41, 'other-collection:present:available');
    lifecycle.onMembershipObserved(41);
    await settle();
    scheduled.shift()?.();
    await settle();
    assert.equal(invalidations, 3, 'reassociation must rebuild');

    state.set(41, 'other-collection:present:unavailable');
    lifecycle.onAvailabilityCommitted(41);
    scheduled.shift()?.();
    await settle();
    assert.equal(invalidations, 4, 'availability transition must rebuild');

    membership = 'standalone';
    state.set(41, 'standalone:present:unavailable');
    lifecycle.onMembershipObserved(41);
    await settle();
    scheduled.shift()?.();
    await settle();
    assert.equal(
      invalidations,
      5,
      'removing a prior collection association must rebuild'
    );
  });
});
