interface InitialSeasonSelectionInput {
  initialSeasonNumber?: number;
  partialRequestsEnabled: boolean;
  knownSeasonNumbers: readonly number[];
  unavailableSeasonNumbers: readonly number[];
}

interface ValidatedSeasonSelectionInput {
  selectedSeasonNumbers: readonly number[];
  knownSeasonNumbers: readonly number[];
  unavailableSeasonNumbers: readonly number[];
  visibleSeasonNumbers?: readonly number[];
}

export const filterVisibleSeasons = <T extends { seasonNumber: number }>(
  seasons: readonly T[],
  visibleSeasonNumbers?: readonly number[]
): T[] =>
  visibleSeasonNumbers === undefined
    ? [...seasons]
    : seasons.filter((season) =>
        visibleSeasonNumbers.includes(season.seasonNumber)
      );

export const getValidatedSeasonSelection = ({
  selectedSeasonNumbers,
  knownSeasonNumbers,
  unavailableSeasonNumbers,
  visibleSeasonNumbers,
}: ValidatedSeasonSelectionInput): number[] => [
  ...new Set(
    selectedSeasonNumbers.filter(
      (seasonNumber) =>
        knownSeasonNumbers.includes(seasonNumber) &&
        !unavailableSeasonNumbers.includes(seasonNumber) &&
        (visibleSeasonNumbers === undefined ||
          visibleSeasonNumbers.includes(seasonNumber))
    )
  ),
];

export const getInitialSeasonSelection = ({
  initialSeasonNumber,
  partialRequestsEnabled,
  knownSeasonNumbers,
  unavailableSeasonNumbers,
}: InitialSeasonSelectionInput): number[] =>
  partialRequestsEnabled &&
  initialSeasonNumber !== undefined &&
  knownSeasonNumbers.includes(initialSeasonNumber) &&
  !unavailableSeasonNumbers.includes(initialSeasonNumber)
    ? [initialSeasonNumber]
    : [];
