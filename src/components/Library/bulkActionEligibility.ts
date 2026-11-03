import type {
  LibraryBulkActionEligibilityReason,
  LibraryBulkActionEligibilityResponse,
  LibraryBulkActionTarget,
} from '@server/interfaces/api/libraryInterfaces';

const targetKey = (target: LibraryBulkActionTarget) =>
  `${target.targetType}:${target.canonicalMediaId}:${target.seasonNumber ?? ''}`;

export interface LibraryBulkActionEligibilityPresentation {
  matchesSelection: boolean;
  scheduleTargets: LibraryBulkActionTarget[];
  cancelTargets: LibraryBulkActionTarget[];
  unresolvedCount: number;
  unresolvedReasons: LibraryBulkActionEligibilityReason[];
}

export interface LibraryBulkActionEligibilityDisplayPresentation extends Omit<
  LibraryBulkActionEligibilityPresentation,
  'matchesSelection'
> {
  retained: boolean;
}

const summarizeResults = (
  results: LibraryBulkActionEligibilityResponse['results']
): Omit<LibraryBulkActionEligibilityPresentation, 'matchesSelection'> => {
  const unresolvedResults = results.filter(
    ({ eligibility }) =>
      eligibility !== 'schedule' && eligibility !== 'cancel_schedule'
  );

  return {
    scheduleTargets: results
      .filter(({ eligibility }) => eligibility === 'schedule')
      .map(({ target }) => target),
    cancelTargets: results
      .filter(({ eligibility }) => eligibility === 'cancel_schedule')
      .map(({ target }) => target),
    unresolvedCount: unresolvedResults.length,
    unresolvedReasons: [
      ...new Set(unresolvedResults.map(({ reason }) => reason)),
    ],
  };
};

export const getLibraryBulkActionEligibilityPresentation = (
  selectedTargets: readonly LibraryBulkActionTarget[],
  response?: LibraryBulkActionEligibilityResponse
): LibraryBulkActionEligibilityPresentation => {
  const results = response?.results ?? [];
  const matchesSelection =
    results.length === selectedTargets.length &&
    results.every(
      ({ target }, index) =>
        targetKey(target) === targetKey(selectedTargets[index])
    );
  const matchingResults = matchesSelection ? results : [];

  return {
    matchesSelection,
    ...summarizeResults(matchingResults),
  };
};

export const getLibraryBulkActionEligibilityDisplayPresentation = (
  selectedTargets: readonly LibraryBulkActionTarget[],
  response?: LibraryBulkActionEligibilityResponse
): LibraryBulkActionEligibilityDisplayPresentation => {
  const currentPresentation = getLibraryBulkActionEligibilityPresentation(
    selectedTargets,
    response
  );

  if (currentPresentation.matchesSelection || !response) {
    return {
      scheduleTargets: currentPresentation.scheduleTargets,
      cancelTargets: currentPresentation.cancelTargets,
      unresolvedCount: currentPresentation.unresolvedCount,
      unresolvedReasons: currentPresentation.unresolvedReasons,
      retained: false,
    };
  }

  return {
    ...summarizeResults(response.results),
    retained: true,
  };
};
