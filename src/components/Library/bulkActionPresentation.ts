import type {
  LibraryBulkAction,
  LibraryBulkActionResponse,
  LibraryBulkActionResult,
} from '@server/interfaces/api/libraryInterfaces';

const satisfiedOutcomes: Record<
  LibraryBulkAction,
  ReadonlySet<LibraryBulkActionResult['outcome']>
> = {
  schedule: new Set(['scheduled', 'already_scheduled']),
  cancel_schedule: new Set(['cancelled', 'not_scheduled']),
  remove_now: new Set(['provider_acknowledged', 'provider_absent_reconciled']),
};

export interface LibraryBulkActionPresentation {
  state: 'success' | 'partial' | 'failure';
  completed: number;
  issues: LibraryBulkActionResult[];
  retryable: LibraryBulkActionResult[];
  hasProviderAcknowledgement: boolean;
}

export const getLibraryBulkActionPresentation = (
  response: LibraryBulkActionResponse
): LibraryBulkActionPresentation => {
  const issues = response.results.filter(
    ({ outcome }) => !satisfiedOutcomes[response.action].has(outcome)
  );
  const completed = response.results.length - issues.length;
  return {
    state:
      issues.length === 0 ? 'success' : completed === 0 ? 'failure' : 'partial',
    completed,
    issues,
    retryable: issues.filter(({ retryable }) => retryable),
    hasProviderAcknowledgement:
      response.action === 'remove_now' &&
      response.results.some(
        ({ outcome }) => outcome === 'provider_acknowledged'
      ),
  };
};
