export class InvalidRequestSeasonsError extends Error {}

interface TmdbSeasonSummary {
  season_number: number;
  episode_count: number;
}

interface ResolveRequestedSeasonsOptions {
  requestedSeasons: number[] | 'all' | undefined;
  tmdbSeasons: TmdbSeasonSummary[];
  enableSpecialEpisodes: boolean;
}

const sameSeasonSet = (left: number[], right: number[]): boolean => {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return (
    leftSet.size === rightSet.size &&
    [...leftSet].every((seasonNumber) => rightSet.has(seasonNumber))
  );
};

export const resolveRequestedSeasons = ({
  requestedSeasons,
  tmdbSeasons,
  enableSpecialEpisodes,
}: ResolveRequestedSeasonsOptions): number[] => {
  const knownSeasons = new Set(
    tmdbSeasons
      .filter(
        (season) =>
          Number.isSafeInteger(season.season_number) &&
          season.season_number >= 0 &&
          season.episode_count > 0
      )
      .map((season) => season.season_number)
  );

  if (requestedSeasons === 'all') {
    // Preserve the existing all-Series behavior: Specials are not included in
    // an "all" request and must be requested explicitly when enabled.
    return [...knownSeasons].filter((seasonNumber) => seasonNumber > 0);
  }

  if (!Array.isArray(requestedSeasons) || requestedSeasons.length === 0) {
    throw new InvalidRequestSeasonsError(
      'A Series request must include at least one Season.'
    );
  }

  if (
    requestedSeasons.some(
      (seasonNumber) => !Number.isSafeInteger(seasonNumber) || seasonNumber < 0
    )
  ) {
    throw new InvalidRequestSeasonsError(
      'Season numbers must be non-negative safe integers.'
    );
  }

  if (new Set(requestedSeasons).size !== requestedSeasons.length) {
    throw new InvalidRequestSeasonsError(
      'A Series request cannot contain duplicate Seasons.'
    );
  }

  const unknownSeason = requestedSeasons.find(
    (seasonNumber) => !knownSeasons.has(seasonNumber)
  );
  if (unknownSeason !== undefined) {
    throw new InvalidRequestSeasonsError(
      `Season ${unknownSeason} does not belong to this Series.`
    );
  }

  if (!enableSpecialEpisodes && requestedSeasons.includes(0)) {
    throw new InvalidRequestSeasonsError(
      'Specials cannot be requested while Special Episode requests are disabled.'
    );
  }

  return [...requestedSeasons];
};

export const assertCompleteSeriesRequest = ({
  requestedSeasons,
  requestableSeasons,
  partialRequestsEnabled,
}: {
  requestedSeasons: number[] | 'all' | undefined;
  requestableSeasons: number[];
  partialRequestsEnabled: boolean;
}): void => {
  if (
    !partialRequestsEnabled &&
    requestedSeasons !== 'all' &&
    !sameSeasonSet(requestableSeasons, requestedSeasons ?? [])
  ) {
    throw new InvalidRequestSeasonsError(
      'Partial Series requests are disabled. Request all available Seasons.'
    );
  }
};
