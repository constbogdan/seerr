import type {
  LibraryBulkActionResult,
  LibraryBulkActionTarget,
  LibraryItem,
} from '@server/interfaces/api/libraryInterfaces';

export type LibrarySelectionKey =
  | `movie:${number}`
  | `series:${number}`
  | `season:${number}:${number}`;

export type LibrarySelectionTarget =
  | {
      type: 'movie' | 'series';
      canonicalMediaId: number;
    }
  | {
      type: 'season';
      canonicalMediaId: number;
      seasonNumber: number;
    };

export type LibraryItemSelectionState = 'none' | 'some' | 'selected';
export type LibraryPageSelectionState = LibraryItemSelectionState;

export const createEmptyLibrarySelection =
  (): ReadonlySet<LibrarySelectionKey> => new Set();

export const getLibrarySelectionKey = (
  target: LibrarySelectionTarget
): LibrarySelectionKey =>
  target.type === 'season'
    ? `season:${target.canonicalMediaId}:${target.seasonNumber}`
    : `${target.type}:${target.canonicalMediaId}`;

const getSeasonSelectionPrefix = (canonicalMediaId: number) =>
  `season:${canonicalMediaId}:` as const;

const removeSeasonSelections = (
  selection: Set<LibrarySelectionKey>,
  canonicalMediaId: number
) => {
  const prefix = getSeasonSelectionPrefix(canonicalMediaId);
  selection.forEach((key) => {
    if (key.startsWith(prefix)) selection.delete(key);
  });
};

const normalizeEligibleSeasonNumbers = (
  seasonNumbers: readonly number[]
): number[] =>
  [...new Set(seasonNumbers)]
    .filter(
      (seasonNumber) => Number.isInteger(seasonNumber) && seasonNumber >= 0
    )
    .sort((left, right) => left - right);

export const getEligibleLibrarySeasonNumbers = (
  item: Pick<LibraryItem, 'canonicalMediaId' | 'mediaType' | 'seasonSummaries'>
): number[] =>
  item.mediaType === 'series'
    ? normalizeEligibleSeasonNumbers(
        item.seasonSummaries
          .filter(
            (season) =>
              season.state === 'current' && season.availableEpisodeCount > 0
          )
          .map((season) => season.seasonNumber)
      )
    : [];

export const hasSelectableLibraryPageItems = (
  items: readonly Pick<
    LibraryItem,
    'canonicalMediaId' | 'mediaType' | 'seasonSummaries'
  >[]
): boolean =>
  items.some(
    (item) =>
      item.mediaType === 'movie' ||
      getEligibleLibrarySeasonNumbers(item).length > 0
  );

const removeIneligibleSeasonSelections = (
  selection: Set<LibrarySelectionKey>,
  canonicalMediaId: number,
  eligibleSeasonNumbers: readonly number[]
) => {
  const eligibleKeys = new Set(
    eligibleSeasonNumbers.map(
      (seasonNumber) =>
        `season:${canonicalMediaId}:${seasonNumber}` as LibrarySelectionKey
    )
  );
  const prefix = getSeasonSelectionPrefix(canonicalMediaId);
  selection.forEach((key) => {
    if (key.startsWith(prefix) && !eligibleKeys.has(key)) selection.delete(key);
  });
};

const normalizeSeriesSelection = (
  selection: Set<LibrarySelectionKey>,
  canonicalMediaId: number,
  eligibleSeasonNumbers: readonly number[]
) => {
  const seriesKey = `series:${canonicalMediaId}` as LibrarySelectionKey;
  removeIneligibleSeasonSelections(
    selection,
    canonicalMediaId,
    eligibleSeasonNumbers
  );
  if (selection.has(seriesKey)) {
    removeSeasonSelections(selection, canonicalMediaId);
    if (eligibleSeasonNumbers.length === 0) selection.delete(seriesKey);
    return;
  }
  if (
    eligibleSeasonNumbers.length > 0 &&
    eligibleSeasonNumbers.every((seasonNumber) =>
      selection.has(`season:${canonicalMediaId}:${seasonNumber}`)
    )
  ) {
    removeSeasonSelections(selection, canonicalMediaId);
    selection.add(seriesKey);
  }
};

export const updateLibrarySelection = (
  current: ReadonlySet<LibrarySelectionKey>,
  target: LibrarySelectionTarget,
  selected: boolean,
  eligibleSeasonNumbers: readonly number[] = []
): ReadonlySet<LibrarySelectionKey> => {
  const key = getLibrarySelectionKey(target);
  const next = new Set(current);

  if (target.type === 'movie') {
    if (selected) next.add(key);
    else next.delete(key);
    return next;
  }

  const eligible = normalizeEligibleSeasonNumbers(eligibleSeasonNumbers);
  const seriesKey = `series:${target.canonicalMediaId}` as LibrarySelectionKey;
  removeIneligibleSeasonSelections(next, target.canonicalMediaId, eligible);

  if (target.type === 'series') {
    removeSeasonSelections(next, target.canonicalMediaId);
    if (selected && eligible.length > 0) next.add(seriesKey);
    else next.delete(seriesKey);
    return next;
  }
  if (target.type !== 'season') return next;

  if (!eligible.includes(target.seasonNumber)) return next;

  if (!selected && next.has(seriesKey)) {
    next.delete(seriesKey);
    eligible.forEach((seasonNumber) => {
      if (seasonNumber !== target.seasonNumber)
        next.add(`season:${target.canonicalMediaId}:${seasonNumber}`);
    });
  } else if (selected) {
    next.add(key);
  } else {
    next.delete(key);
  }
  normalizeSeriesSelection(next, target.canonicalMediaId, eligible);
  return next;
};

export const selectLibraryPage = (
  current: ReadonlySet<LibrarySelectionKey>,
  items: readonly Pick<
    LibraryItem,
    'canonicalMediaId' | 'mediaType' | 'seasonSummaries'
  >[]
): ReadonlySet<LibrarySelectionKey> => {
  let next = new Set(current);
  items.forEach((item) => {
    next = new Set(
      updateLibrarySelection(
        next,
        {
          type: item.mediaType,
          canonicalMediaId: item.canonicalMediaId,
        },
        true,
        getEligibleLibrarySeasonNumbers(item)
      )
    );
  });
  return next;
};

export const deselectLibraryPage = (
  current: ReadonlySet<LibrarySelectionKey>,
  items: readonly Pick<
    LibraryItem,
    'canonicalMediaId' | 'mediaType' | 'seasonSummaries'
  >[]
): ReadonlySet<LibrarySelectionKey> => {
  let next = new Set(current);
  items.forEach((item) => {
    next = new Set(
      updateLibrarySelection(
        next,
        {
          type: item.mediaType,
          canonicalMediaId: item.canonicalMediaId,
        },
        false,
        getEligibleLibrarySeasonNumbers(item)
      )
    );
  });
  return next;
};

export const getLibraryItemSelectionState = (
  selection: ReadonlySet<LibrarySelectionKey>,
  item: Pick<LibraryItem, 'canonicalMediaId' | 'mediaType' | 'seasonSummaries'>
): LibraryItemSelectionState => {
  const itemKey = getLibrarySelectionKey({
    type: item.mediaType,
    canonicalMediaId: item.canonicalMediaId,
  });
  if (item.mediaType === 'movie')
    return selection.has(itemKey) ? 'selected' : 'none';

  const eligible = getEligibleLibrarySeasonNumbers(item);
  if (eligible.length === 0) return 'none';
  if (
    selection.has(itemKey) ||
    eligible.every((seasonNumber) =>
      selection.has(`season:${item.canonicalMediaId}:${seasonNumber}`)
    )
  ) {
    return 'selected';
  }
  if (
    eligible.some((seasonNumber) =>
      selection.has(`season:${item.canonicalMediaId}:${seasonNumber}`)
    )
  )
    return 'some';
  return 'none';
};

export const getLibraryPageSelectionState = (
  selection: ReadonlySet<LibrarySelectionKey>,
  items: readonly Pick<
    LibraryItem,
    'canonicalMediaId' | 'mediaType' | 'seasonSummaries'
  >[]
): LibraryPageSelectionState => {
  const states = items
    .filter(
      (item) =>
        item.mediaType === 'movie' ||
        getEligibleLibrarySeasonNumbers(item).length > 0
    )
    .map((item) => getLibraryItemSelectionState(selection, item));
  if (states.length === 0 || states.every((state) => state === 'none'))
    return 'none';
  return states.every((state) => state === 'selected') ? 'selected' : 'some';
};

export const isLibrarySeasonSelected = (
  selection: ReadonlySet<LibrarySelectionKey>,
  canonicalMediaId: number,
  seasonNumber: number
): boolean =>
  selection.has(`series:${canonicalMediaId}`) ||
  selection.has(`season:${canonicalMediaId}:${seasonNumber}`);

export const getLibraryBulkActionTargets = (
  selection: ReadonlySet<LibrarySelectionKey>
): LibraryBulkActionTarget[] => {
  const selectedSeries = new Set<number>();
  selection.forEach((key) => {
    const [type, id] = key.split(':');
    if (type === 'series') selectedSeries.add(Number(id));
  });
  return [...selection].flatMap((key): LibraryBulkActionTarget[] => {
    const [type, canonicalMediaIdValue, seasonNumberValue] = key.split(':');
    const canonicalMediaId = Number(canonicalMediaIdValue);
    if (type === 'season') {
      if (selectedSeries.has(canonicalMediaId)) return [];
      return [
        {
          canonicalMediaId,
          targetType: 'season',
          seasonNumber: Number(seasonNumberValue),
        },
      ];
    }
    return [
      {
        canonicalMediaId,
        targetType: type as 'movie' | 'series',
      },
    ];
  });
};

export const getLibraryBulkActionTargetCounts = (
  targets: readonly LibraryBulkActionTarget[]
) => ({
  movie: targets.filter(({ targetType }) => targetType === 'movie').length,
  series: targets.filter(({ targetType }) => targetType === 'series').length,
  season: targets.filter(({ targetType }) => targetType === 'season').length,
});

const terminalBulkActionOutcomes = new Set([
  'scheduled',
  'already_scheduled',
  'cancelled',
  'not_scheduled',
  'not_current',
  'missing',
  'identity_conflict',
  'provider_acknowledged',
  'provider_absent_reconciled',
  'remote_removed_local_failed',
]);

export const reconcileLibrarySelectionAfterBulkAction = (
  selection: ReadonlySet<LibrarySelectionKey>,
  results: readonly LibraryBulkActionResult[]
): ReadonlySet<LibrarySelectionKey> => {
  const next = new Set(selection);
  results.forEach(({ target, outcome, code }) => {
    if (
      !terminalBulkActionOutcomes.has(outcome) &&
      code !== 'schedule_reconciliation_failed'
    )
      return;
    next.delete(
      getLibrarySelectionKey({
        type: target.targetType,
        canonicalMediaId: target.canonicalMediaId,
        ...(target.targetType === 'season'
          ? { seasonNumber: target.seasonNumber! }
          : {}),
      } as LibrarySelectionTarget)
    );
  });
  return next;
};
