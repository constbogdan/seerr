export interface CandidateSelectionRow {
  candidateId: number;
  revision: number;
  show: boolean;
}

export type CandidatePageSelectionState = 'none' | 'some' | 'all';

export interface CandidateSelectionScope {
  page: number;
  search: string;
  mediaType: string;
  status: string;
  sort: string;
  reasonFamily: string;
  seasonEvidence: string;
  manualResolution: string;
  admissionOverride: string;
  visibility: string;
}

export const candidateSelectionScopeKey = (
  scope: CandidateSelectionScope
): string => JSON.stringify(scope);

export const candidatePageSelectionState = (
  rows: CandidateSelectionRow[],
  selectedIds: number[]
): CandidatePageSelectionState => {
  if (rows.length === 0 || selectedIds.length === 0) return 'none';
  const selected = new Set(selectedIds);
  const selectedOnPage = rows.filter((row) => selected.has(row.candidateId));
  if (selectedOnPage.length === 0) return 'none';
  return selectedOnPage.length === rows.length ? 'all' : 'some';
};

export const toggleCandidateSelection = (
  selectedIds: number[],
  candidateId: number,
  selected: boolean
): number[] => {
  const next = new Set(selectedIds);
  if (selected) next.add(candidateId);
  else next.delete(candidateId);
  return [...next];
};

export const toggleCandidatePageSelection = (
  rows: CandidateSelectionRow[],
  selected: boolean
): number[] => (selected ? rows.map((row) => row.candidateId) : []);

export const bulkCandidateVisibilityTargets = (
  rows: CandidateSelectionRow[],
  selectedIds: number[],
  show: boolean
): { candidateId: number; expectedRevision: number }[] => {
  const selected = new Set(selectedIds);
  return rows
    .filter((row) => selected.has(row.candidateId) && row.show !== show)
    .map((row) => ({
      candidateId: row.candidateId,
      expectedRevision: row.revision,
    }));
};

export const nearestCandidatePage = (
  currentPage: number,
  totalResults: number,
  removedResults: number,
  pageSize: number
): number =>
  Math.min(
    currentPage,
    Math.max(
      1,
      Math.ceil(Math.max(0, totalResults - removedResults) / pageSize)
    )
  );
