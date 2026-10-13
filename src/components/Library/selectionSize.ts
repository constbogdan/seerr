import type {
  LibraryBulkActionTarget,
  LibrarySelectionSizeResponse,
} from '@server/interfaces/api/libraryInterfaces';

const targetKey = (target: LibraryBulkActionTarget) =>
  `${target.targetType}:${target.canonicalMediaId}:${target.seasonNumber ?? ''}`;

export interface LibrarySelectionSizePresentation {
  matchesSelection: boolean;
  retained: boolean;
  sizeBytes: string | null;
  fileCount: number;
  unknownFileCount: number;
}

export const getLibrarySelectionSizePresentation = (
  selectedTargets: readonly LibraryBulkActionTarget[],
  response?: LibrarySelectionSizeResponse
): LibrarySelectionSizePresentation => {
  const matchesSelection =
    Boolean(response) &&
    response!.targets.length === selectedTargets.length &&
    response!.targets.every(
      (target, index) => targetKey(target) === targetKey(selectedTargets[index])
    );

  return {
    matchesSelection,
    retained: Boolean(response) && !matchesSelection,
    sizeBytes: response?.sizeBytes ?? null,
    fileCount: response?.fileCount ?? 0,
    unknownFileCount: response?.unknownFileCount ?? 0,
  };
};
