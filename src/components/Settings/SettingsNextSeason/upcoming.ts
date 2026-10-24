export interface NextSeasonUpcomingCandidate {
  canonicalMediaId: number;
  tmdbId: number | null;
  seasonNumber: number | null;
  outcome: string;
  title?: string;
  qualifyingViewer?: string;
  qualifyingLastViewedAt?: string;
}

export interface NextSeasonUpcomingSummary {
  status: 'succeeded' | 'failed' | 'already-running';
  failed: number;
  candidates: NextSeasonUpcomingCandidate[];
}

export interface NextSeasonUpcomingRow {
  key: string;
  seriesTitle: string;
  seasonNumber: number;
  href: string;
  viewer: string;
  lastWatchedAt: string;
  status: 'eligible';
}

export const selectNextSeasonUpcomingRows = (
  summary: NextSeasonUpcomingSummary | undefined
): NextSeasonUpcomingRow[] => {
  if (!summary || summary.status !== 'succeeded') return [];
  const rows = summary.candidates.flatMap((candidate) =>
    candidate.outcome === 'would-request' &&
    candidate.tmdbId !== null &&
    candidate.seasonNumber !== null &&
    candidate.title &&
    candidate.qualifyingViewer &&
    candidate.qualifyingLastViewedAt
      ? [
          {
            key: `${candidate.canonicalMediaId}:${candidate.seasonNumber}`,
            seriesTitle: candidate.title,
            seasonNumber: candidate.seasonNumber,
            href: `/tv/${candidate.tmdbId}`,
            viewer: candidate.qualifyingViewer,
            lastWatchedAt: candidate.qualifyingLastViewedAt,
            status: 'eligible' as const,
          },
        ]
      : []
  );
  return [...new Map(rows.map((row) => [row.key, row] as const)).values()].sort(
    (left, right) =>
      left.seriesTitle.localeCompare(right.seriesTitle, 'en') ||
      left.seasonNumber - right.seasonNumber ||
      left.key.localeCompare(right.key)
  );
};
