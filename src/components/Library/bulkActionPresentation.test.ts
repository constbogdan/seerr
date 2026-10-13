import type {
  LibraryBulkActionOutcome,
  LibraryBulkActionResponse,
} from '@server/interfaces/api/libraryInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getLibraryBulkActionPresentation } from './bulkActionPresentation';

const response = (
  action: LibraryBulkActionResponse['action'],
  outcomes: {
    outcome: LibraryBulkActionOutcome;
    retryable?: boolean;
  }[]
): LibraryBulkActionResponse => ({
  action,
  requested: outcomes.length,
  succeeded: 0,
  unchanged: 0,
  skipped: 0,
  failed: 0,
  results: outcomes.map(({ outcome, retryable = false }, index) => ({
    target: { canonicalMediaId: index + 1, targetType: 'movie' },
    outcome,
    code: `code_${index}`,
    retryable,
    message: `message_${index}`,
    affectedSchedules: 0,
  })),
});

describe('Library bulk-action result presentation', () => {
  it('treats scheduled and already-scheduled targets as satisfied', () => {
    assert.deepEqual(
      getLibraryBulkActionPresentation(
        response('schedule', [
          { outcome: 'scheduled' },
          { outcome: 'already_scheduled' },
        ])
      ),
      {
        state: 'success',
        completed: 2,
        issues: [],
        retryable: [],
        hasProviderAcknowledgement: false,
      }
    );
  });

  it('keeps skipped conflicts in partial failure details', () => {
    const value = getLibraryBulkActionPresentation(
      response('schedule', [
        { outcome: 'scheduled' },
        { outcome: 'active_acquisition', retryable: true },
        { outcome: 'identity_conflict' },
      ])
    );
    assert.equal(value.state, 'partial');
    assert.equal(value.completed, 1);
    assert.deepEqual(
      value.issues.map(({ outcome }) => outcome),
      ['active_acquisition', 'identity_conflict']
    );
    assert.deepEqual(
      value.retryable.map(({ outcome }) => outcome),
      ['active_acquisition']
    );
  });

  it('reports a complete failure when no target was satisfied', () => {
    const value = getLibraryBulkActionPresentation(
      response('schedule', [
        { outcome: 'failed', retryable: true },
        { outcome: 'not_attempted', retryable: true },
      ])
    );
    assert.equal(value.state, 'failure');
    assert.equal(value.completed, 0);
    assert.equal(value.issues.length, 2);
  });

  it('treats absent cancellation schedules as idempotently satisfied', () => {
    const value = getLibraryBulkActionPresentation(
      response('cancel_schedule', [
        { outcome: 'cancelled' },
        { outcome: 'not_scheduled' },
      ])
    );
    assert.equal(value.state, 'success');
    assert.equal(value.completed, 2);
  });

  it('reports cancellation conflicts without counting them as completed', () => {
    const value = getLibraryBulkActionPresentation(
      response('cancel_schedule', [
        { outcome: 'cancelled' },
        { outcome: 'in_progress', retryable: true },
      ])
    );
    assert.equal(value.state, 'partial');
    assert.equal(value.completed, 1);
    assert.deepEqual(
      value.issues.map(({ outcome }) => outcome),
      ['in_progress']
    );
    assert.equal(value.retryable.length, 1);
  });

  it('treats acknowledged and already-absent removals as completed requests', () => {
    const value = getLibraryBulkActionPresentation(
      response('remove_now', [
        { outcome: 'provider_acknowledged' },
        { outcome: 'provider_absent_reconciled' },
      ])
    );
    assert.equal(value.state, 'success');
    assert.equal(value.completed, 2);
    assert.equal(value.hasProviderAcknowledgement, true);
    assert.equal(value.issues.length, 0);
  });

  it('keeps uncertain removal reconciliation out of success', () => {
    const value = getLibraryBulkActionPresentation(
      response('remove_now', [
        { outcome: 'provider_acknowledged' },
        { outcome: 'remote_removed_local_failed' },
      ])
    );
    assert.equal(value.state, 'partial');
    assert.equal(value.completed, 1);
    assert.equal(value.hasProviderAcknowledgement, true);
    assert.equal(value.issues[0].retryable, false);
    assert.equal(value.retryable.length, 0);
  });
});
