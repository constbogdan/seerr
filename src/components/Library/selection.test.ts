import type {
  LibraryItem,
  LibrarySeasonSummary,
} from '@server/interfaces/api/libraryInterfaces';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createEmptyLibrarySelection,
  deselectLibraryPage,
  getEligibleLibrarySeasonNumbers,
  getLibraryBulkActionTargets,
  getLibraryItemSelectionState,
  getLibraryPageSelectionState,
  getLibrarySelectionKey,
  hasSelectableLibraryPageItems,
  isLibrarySeasonSelected,
  reconcileLibrarySelectionAfterBulkAction,
  selectLibraryPage,
  updateLibrarySelection,
  type LibrarySelectionKey,
} from './selection';

const season = (
  seasonNumber: number,
  state: LibrarySeasonSummary['state'] = 'current',
  availableEpisodeCount = 1
): LibrarySeasonSummary => ({
  key: `season-${seasonNumber}`,
  seasonNumber,
  isSpecial: seasonNumber === 0,
  state,
  availableEpisodeCount,
  knownEpisodeCount: availableEpisodeCount || null,
  resolution: null,
  requestable: false,
});

const seriesItem = (
  canonicalMediaId: number,
  seasonSummaries: LibrarySeasonSummary[]
): Pick<LibraryItem, 'canonicalMediaId' | 'mediaType' | 'seasonSummaries'> => ({
  canonicalMediaId,
  mediaType: 'series',
  seasonSummaries,
});

const movieItem = (
  canonicalMediaId: number
): Pick<LibraryItem, 'canonicalMediaId' | 'mediaType' | 'seasonSummaries'> => ({
  canonicalMediaId,
  mediaType: 'movie',
  seasonSummaries: [],
});

describe('Library multi-selection', () => {
  it('uses stable typed canonical identities', () => {
    assert.equal(
      getLibrarySelectionKey({ type: 'movie', canonicalMediaId: 42 }),
      'movie:42'
    );
    assert.equal(
      getLibrarySelectionKey({ type: 'series', canonicalMediaId: 42 }),
      'series:42'
    );
    assert.equal(
      getLibrarySelectionKey({
        type: 'season',
        canonicalMediaId: 42,
        seasonNumber: 0,
      }),
      'season:42:0'
    );
  });

  it('selects every eligible Season through the whole-Series target', () => {
    const eligible = [0, 1, 2];
    const selection = updateLibrarySelection(
      new Set(),
      { type: 'series', canonicalMediaId: 7 },
      true,
      eligible
    );

    assert.deepEqual([...selection], ['series:7']);
    eligible.forEach((seasonNumber) =>
      assert.equal(isLibrarySeasonSelected(selection, 7, seasonNumber), true)
    );
    assert.equal(
      getLibraryItemSelectionState(
        selection,
        seriesItem(
          7,
          eligible.map((number) => season(number))
        )
      ),
      'selected'
    );
  });

  it('materializes only remaining Seasons when one is excluded and collapses when restored', () => {
    const eligible = [0, 1, 2];
    let selection: ReadonlySet<LibrarySelectionKey> = new Set(['series:7']);

    selection = updateLibrarySelection(
      selection,
      { type: 'season', canonicalMediaId: 7, seasonNumber: 1 },
      false,
      eligible
    );
    assert.deepEqual([...selection], ['season:7:0', 'season:7:2']);
    assert.equal(selection.has('series:7'), false);
    assert.equal(isLibrarySeasonSelected(selection, 7, 1), false);
    assert.equal(
      getLibraryItemSelectionState(
        selection,
        seriesItem(
          7,
          eligible.map((number) => season(number))
        )
      ),
      'some'
    );

    selection = updateLibrarySelection(
      selection,
      { type: 'season', canonicalMediaId: 7, seasonNumber: 1 },
      true,
      eligible
    );
    assert.deepEqual([...selection], ['series:7']);
  });

  it('makes an indeterminate parent select all and a checked parent clear all', () => {
    const eligible = [1, 2, 3];
    let selection: ReadonlySet<LibrarySelectionKey> = new Set(['season:9:1']);

    selection = updateLibrarySelection(
      selection,
      { type: 'series', canonicalMediaId: 9 },
      true,
      eligible
    );
    assert.deepEqual([...selection], ['series:9']);

    selection = updateLibrarySelection(
      selection,
      { type: 'series', canonicalMediaId: 9 },
      false,
      eligible
    );
    assert.deepEqual([...selection], []);
  });

  it('excludes Missing, Archived, metadata-only, and zero-episode Seasons while retaining Specials', () => {
    const item = seriesItem(12, [
      season(0),
      season(1),
      season(2, 'known_missing', 0),
      season(3, 'archive', 8),
      season(4, 'current', 0),
    ]);
    const eligible = getEligibleLibrarySeasonNumbers(item);
    assert.deepEqual(eligible, [0, 1]);

    let selection = updateLibrarySelection(
      new Set(),
      { type: 'season', canonicalMediaId: 12, seasonNumber: 2 },
      true,
      eligible
    );
    assert.equal(selection.size, 0);

    selection = updateLibrarySelection(
      selection,
      { type: 'series', canonicalMediaId: 12 },
      true,
      eligible
    );
    assert.deepEqual([...selection], ['series:12']);
    assert.equal(isLibrarySeasonSelected(selection, 12, 0), true);
  });

  it('preserves selection across page/filter/sort result changes', () => {
    const firstPage = selectLibraryPage(new Set(), [
      movieItem(1),
      seriesItem(2, [season(1), season(2)]),
    ]);
    const secondPage = selectLibraryPage(firstPage, [movieItem(3)]);

    assert.deepEqual([...secondPage], ['movie:1', 'series:2', 'movie:3']);
    assert.equal(
      getLibraryItemSelectionState(secondPage, seriesItem(9, [season(1)])),
      'none'
    );
  });

  it('clears cross-page and partial-Series selections without retaining hidden targets', () => {
    const selection = new Set<LibrarySelectionKey>([
      'movie:1',
      'movie:99',
      'season:7:0',
      'season:7:2',
      'series:8',
    ]);

    const cleared = createEmptyLibrarySelection();

    assert.equal(cleared.size, 0);
    assert.deepEqual(getLibraryBulkActionTargets(cleared), []);
    assert.deepEqual(
      [...selection],
      ['movie:1', 'movie:99', 'season:7:0', 'season:7:2', 'series:8']
    );
  });

  it('skips Series with no actionable Seasons during page selection', () => {
    const selection = selectLibraryPage(
      new Set<LibrarySelectionKey>(['season:2:1', 'movie:99']),
      [
        seriesItem(2, [season(1), season(2, 'known_missing', 0)]),
        seriesItem(8, [season(1, 'archive')]),
        movieItem(3),
      ]
    );
    assert.deepEqual([...selection], ['movie:99', 'series:2', 'movie:3']);
  });

  it('derives empty, indeterminate, and checked state from selectable current-page items', () => {
    const page = [movieItem(1), seriesItem(2, [season(1), season(2)])];
    assert.equal(getLibraryPageSelectionState(new Set(), page), 'none');
    assert.equal(
      getLibraryPageSelectionState(new Set(['movie:1']), page),
      'some'
    );
    assert.equal(
      getLibraryPageSelectionState(new Set(['season:2:1']), page),
      'some'
    );
    assert.equal(
      getLibraryPageSelectionState(selectLibraryPage(new Set(), page), page),
      'selected'
    );
  });

  it('deselects only current-page targets and preserves selections from other pages', () => {
    const currentPage = [movieItem(1), seriesItem(2, [season(1), season(2)])];
    const selected = selectLibraryPage(
      new Set<LibrarySelectionKey>(['movie:99']),
      currentPage
    );
    assert.deepEqual([...selected], ['movie:99', 'movie:1', 'series:2']);

    const deselected = deselectLibraryPage(selected, currentPage);
    assert.deepEqual([...deselected], ['movie:99']);
    assert.equal(getLibraryPageSelectionState(deselected, currentPage), 'none');
  });

  it('disables page selection when no visible item has an actionable target', () => {
    const page = [seriesItem(8, [season(1, 'archive')])];
    assert.equal(hasSelectableLibraryPageItems(page), false);
    assert.equal(getLibraryPageSelectionState(new Set(), page), 'none');
  });

  it('never stores overlapping Series and Season targets', () => {
    const eligible = [1, 2];
    let selection: ReadonlySet<LibrarySelectionKey> = new Set([
      'series:4',
      'season:4:1',
      'season:4:99',
    ]);
    selection = updateLibrarySelection(
      selection,
      { type: 'season', canonicalMediaId: 4, seasonNumber: 2 },
      false,
      eligible
    );
    assert.deepEqual([...selection], ['season:4:1']);

    const cleared = createEmptyLibrarySelection();
    assert.equal(cleared.size, 0);
    assert.equal(selection.size, 1);
  });

  it('serializes stable Movie, whole-Series, and partial-Season targets without overlap', () => {
    assert.deepEqual(
      getLibraryBulkActionTargets(
        new Set<LibrarySelectionKey>([
          'movie:1',
          'series:2',
          'season:2:1',
          'season:3:0',
          'season:3:2',
        ])
      ),
      [
        { canonicalMediaId: 1, targetType: 'movie' },
        { canonicalMediaId: 2, targetType: 'series' },
        { canonicalMediaId: 3, targetType: 'season', seasonNumber: 0 },
        { canonicalMediaId: 3, targetType: 'season', seasonNumber: 2 },
      ]
    );
  });

  it('clears terminal outcomes while retaining retryable and actionable conflicts', () => {
    const selection = new Set<LibrarySelectionKey>([
      'movie:1',
      'series:2',
      'season:3:1',
      'movie:4',
    ]);
    const reconciled = reconcileLibrarySelectionAfterBulkAction(selection, [
      {
        target: { canonicalMediaId: 1, targetType: 'movie' },
        outcome: 'scheduled',
        code: 'schedule_created',
        retryable: false,
        message: 'Scheduled.',
        affectedSchedules: 1,
      },
      {
        target: { canonicalMediaId: 2, targetType: 'series' },
        outcome: 'already_scheduled',
        code: 'already_scheduled',
        retryable: false,
        message: 'Already scheduled.',
        affectedSchedules: 0,
      },
      {
        target: {
          canonicalMediaId: 3,
          targetType: 'season',
          seasonNumber: 1,
        },
        outcome: 'active_acquisition',
        code: 'active_acquisition',
        retryable: true,
        message: 'Active acquisition.',
        affectedSchedules: 0,
      },
    ]);
    assert.deepEqual([...reconciled], ['season:3:1', 'movie:4']);
  });

  it('clears reconciled and uncertain Remove Now targets but retains retryable conflicts', () => {
    const selection = new Set<LibrarySelectionKey>([
      'movie:1',
      'series:2',
      'season:3:1',
      'movie:4',
      'movie:5',
    ]);
    const reconciled = reconcileLibrarySelectionAfterBulkAction(selection, [
      {
        target: { canonicalMediaId: 1, targetType: 'movie' },
        outcome: 'provider_acknowledged',
        code: 'provider_acknowledged',
        retryable: false,
        message: 'Provider acknowledged.',
        affectedSchedules: 1,
      },
      {
        target: { canonicalMediaId: 2, targetType: 'series' },
        outcome: 'remote_removed_local_failed',
        code: 'remote_removed_local_failed',
        retryable: false,
        message: 'Remote result is uncertain.',
        affectedSchedules: 0,
      },
      {
        target: {
          canonicalMediaId: 3,
          targetType: 'season',
          seasonNumber: 1,
        },
        outcome: 'in_progress',
        code: 'in_progress',
        retryable: true,
        message: 'In progress.',
        affectedSchedules: 0,
      },
      {
        target: { canonicalMediaId: 4, targetType: 'movie' },
        outcome: 'failed',
        code: 'schedule_reconciliation_failed',
        retryable: false,
        message: 'Provider removal completed but schedule cleanup failed.',
        affectedSchedules: 0,
      },
    ]);
    assert.deepEqual([...reconciled], ['season:3:1', 'movie:5']);
  });
});
