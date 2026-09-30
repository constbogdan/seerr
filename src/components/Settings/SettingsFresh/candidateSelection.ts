import type {
  FreshCandidateDiagnosticResponse,
  FreshCandidateDiagnosticRow,
  FreshCandidateVisibilityFilter,
} from '@server/lib/fresh/types';

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

const decrementSummary = (
  summary: FreshCandidateDiagnosticResponse['summary'],
  row: FreshCandidateDiagnosticRow
) => {
  const next = { ...summary, totalCandidates: summary.totalCandidates - 1 };
  const fieldByStatus = {
    no_match: 'noMatch',
    ambiguous: 'ambiguous',
    temporary_failure: 'temporaryFailure',
    outside_eligibility_window: 'outsideEligibilityWindow',
    eligibility_unknown: 'eligibilityUnknown',
    excluded_content_filter: 'excludedContentFilter',
    visibility_expired: 'visibilityExpired',
    active_fresh: 'activeFresh',
    needs_attention: 'needsAttention',
    reviewable: 'reviewable',
    historical: 'historical',
  } as const;
  const field = fieldByStatus[row.displayStatus as keyof typeof fieldByStatus];
  if (field) next[field] = Math.max(0, next[field] - 1);
  if (row.displayStatus === 'no_match' || row.displayStatus === 'ambiguous') {
    next.needsAttention = Math.max(0, next.needsAttention - 1);
  }
  return next;
};

export const applyCandidateVisibilityLocally = (
  current: FreshCandidateDiagnosticResponse | undefined,
  candidateIds: number[],
  show: boolean,
  visibility: FreshCandidateVisibilityFilter
): FreshCandidateDiagnosticResponse | undefined => {
  if (!current || candidateIds.length === 0) return current;
  const selected = new Set(candidateIds);
  const changed = current.results.filter((row) =>
    selected.has(row.candidateId)
  );
  const removesFromView =
    (visibility === 'visible' && !show) || (visibility === 'hidden' && show);
  if (!removesFromView) {
    return {
      ...current,
      results: current.results.map((row) =>
        selected.has(row.candidateId)
          ? { ...row, show, revision: row.revision + 1 }
          : row
      ),
    };
  }
  const summary = changed.reduce(decrementSummary, current.summary);
  const results = current.results.filter(
    (row) => !selected.has(row.candidateId)
  );
  const resultCount = Math.max(0, current.pageInfo.results - changed.length);
  return {
    ...current,
    results,
    summary,
    pageInfo: {
      ...current.pageInfo,
      results: resultCount,
      pages: Math.ceil(resultCount / current.pageInfo.pageSize),
    },
  };
};
