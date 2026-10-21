import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
const row = readFileSync(path.join(__dirname, 'LibraryItem.tsx'), 'utf8');
const results = readFileSync(
  path.join(__dirname, 'LibraryResults.tsx'),
  'utf8'
);
const engagement = readFileSync(
  path.join(__dirname, 'LibraryEngagement.tsx'),
  'utf8'
);
const requesterPresentation = readFileSync(
  path.join(__dirname, 'requesterPresentation.ts'),
  'utf8'
);
const seriesDetail = readFileSync(
  path.join(__dirname, 'SeriesDetail.tsx'),
  'utf8'
);
const requestModal = readFileSync(
  path.join(__dirname, '../RequestModal/index.tsx'),
  'utf8'
);
const tvRequestModal = readFileSync(
  path.join(__dirname, '../RequestModal/TvRequestModal.tsx'),
  'utf8'
);
const cancelScheduledRemovalButton = readFileSync(
  path.join(__dirname, '../Common/CancelScheduledRemovalButton.tsx'),
  'utf8'
);
const requestIconButton = readFileSync(
  path.join(__dirname, '../Common/RequestIconButton.tsx'),
  'utf8'
);
const resolutionBadge = readFileSync(
  path.join(__dirname, 'LibraryResolutionBadge.tsx'),
  'utf8'
);
const selection = readFileSync(path.join(__dirname, 'selection.ts'), 'utf8');
const selectionCheckbox = readFileSync(
  path.join(__dirname, 'LibrarySelectionCheckbox.tsx'),
  'utf8'
);
const filters = readFileSync(
  path.join(__dirname, 'FilterSlideover.tsx'),
  'utf8'
);
const layout = readFileSync(
  path.join(__dirname, '../Layout/index.tsx'),
  'utf8'
);
const globalStyles = readFileSync(
  path.join(__dirname, '../../styles/globals.css'),
  'utf8'
);

describe('Library browsing and Watched presentation structure', () => {
  it('keeps typed multi-selection above pagination, filtering, and expansion state', () => {
    assert.match(
      source,
      /const \[selectedKeys, setSelectedKeys\] = useState<[\s\S]*?LibrarySelectionKey/
    );
    assert.match(source, /selectLibraryPage\(current, data\.results\)/);
    assert.match(
      source,
      /updateLibrarySelection\([\s\S]*?current,[\s\S]*?target,[\s\S]*?selected,[\s\S]*?eligibleSeasonNumbers/
    );
    assert.match(source, /selectedKeys=\{selectedKeys\}/);
    assert.match(source, /onSelectionChange=\{handleSelectionChange\}/);
    assert.doesNotMatch(
      source,
      /useEffect\([\s\S]{0,200}setSelectedKeys\(new Set\(\)\)/
    );
    assert.match(results, /getLibraryItemSelectionState\(selectedKeys, item\)/);
    assert.match(
      results,
      /selectedKeys=\{expanded \? selectedKeys : undefined\}/
    );
    assert.match(row, /<LibrarySelectionCheckbox/);
    assert.match(row, /selectionState === 'some'/);
    assert.match(seriesDetail, /type: 'season'/);
    assert.match(seriesDetail, /seasonNumber: season\.seasonNumber/);
    assert.match(selection, /`movie:\$\{number\}`/);
    assert.match(selection, /`series:\$\{number\}`/);
    assert.match(selection, /`season:\$\{number\}:\$\{number\}`/);
    assert.match(selectionCheckbox, /type="checkbox"/);
    assert.match(selectionCheckbox, /ref\.current\.indeterminate/);
    assert.match(selectionCheckbox, /!h-\[18px\] !w-\[18px\]/);
    assert.match(selectionCheckbox, /card: 'h-16 w-9'/);
    assert.match(selectionCheckbox, /season: 'h-9 w-9'/);
    assert.match(selectionCheckbox, /absolute -inset-\[7px\]/);
    assert.match(selectionCheckbox, /relative !mb-0 inline-flex/);
    assert.match(selectionCheckbox, /!border-0/);
    assert.match(selectionCheckbox, /focus:ring-0/);
    assert.match(selectionCheckbox, /focus-visible:!ring-2/);
    assert.match(row, /hitArea="card"/);
    assert.match(seriesDetail, /hitArea="season"/);
    assert.match(
      row,
      /-ml-4 flex w-10 flex-shrink-0 items-center justify-center self-stretch/
    );
    assert.match(
      seriesDetail,
      /-ml-3 flex h-7 w-9 flex-shrink-0 items-center justify-center/
    );
    assert.match(row, /inline-flex h-6 min-w-6/);
    assert.match(seriesDetail, /eligibleSeasonNumbers/);
    assert.match(seriesDetail, /isLibrarySeasonSelected/);
    assert.match(selection, /season\.state === 'current'/);
    assert.match(selection, /season\.availableEpisodeCount > 0/);
  });

  it('uses one page-scoped tri-state selection control without clearing other pages', () => {
    assert.match(source, /getLibraryPageSelectionState\(/);
    assert.match(source, /deselectLibraryPage\(current, data\.results\)/);
    assert.match(source, /selectLibraryPage\(current, data\.results\)/);
    assert.match(
      source,
      /checked=\{currentPageSelectionState === 'selected'\}/
    );
    assert.match(
      source,
      /indeterminate=\{currentPageSelectionState === 'some'\}/
    );
    assert.match(
      source,
      /!currentPageHasSelectableItems \|\|[\s\S]*?paginationPresentation\.isPagePending/
    );
    assert.match(source, /one \{# item\} other \{# items\}/);
    assert.doesNotMatch(source, /Selected # item/);
    assert.match(source, /clearAllSelections: 'Clear all selections'/);
    assert.match(source, /selectedKeys\.size > 0/);
    assert.match(source, /onClick=\{handleClearAllSelections\}/);
    assert.match(source, /setSelectedKeys\(createEmptyLibrarySelection\(\)\)/);
    assert.match(source, /setBulkTargetOverride\(null\)/);
    assert.match(
      source,
      /setBulkEligibilityRevision\(\(revision\) => revision \+ 1\)/
    );
    assert.match(
      source,
      /bulkEligibilityKey[\s\S]*?bulkTargets,[\s\S]*?bulkEligibilityRevision/
    );
    assert.match(source, /focus-visible:ring-2/);
    assert.doesNotMatch(source, />\s*Select Current Page\s*</);
    const stickyHeader = source.indexOf(
      'sticky top-[calc(4rem+env(safe-area-inset-top))]'
    );
    const selectionToolbar = source.indexOf(
      'aria-label={intl.formatMessage(messages.selectionToolbar)}'
    );
    const filterSlideover = source.indexOf('<FilterSlideover');
    assert.ok(stickyHeader >= 0);
    assert.ok(selectionToolbar > stickyHeader);
    assert.ok(selectionToolbar < filterSlideover);
    assert.equal(
      source.match(
        /aria-label=\{intl\.formatMessage\(messages\.selectionToolbar\)\}/g
      )?.length,
      1
    );
    assert.match(
      source,
      /<Header>\{intl\.formatMessage\(messages\.title\)\}<\/Header>[\s\S]*?messages\.selectionToolbar/
    );
  });

  it('presents page selection and the cross-page count as one compact badge', () => {
    assert.match(
      source,
      /inline-flex h-7 flex-none items-center gap-1\.5 rounded-md bg-gray-700 px-2 py-1 text-xs font-medium text-slate-300 shadow-md[\s\S]*?data-testid="library-selection-summary"/
    );
    assert.match(
      source,
      /className="library-selection-badge-checkbox"[\s\S]*?data-testid="library-selection-count"/
    );
    assert.match(
      source,
      /data-testid="library-selection-count"[\s\S]*?aria-label=\{intl\.formatMessage\(messages\.selectedItems,[\s\S]*?\{selectedKeys\.size\}/
    );
    assert.match(
      globalStyles,
      /input\[type='checkbox'\]\.library-selection-badge-checkbox[\s\S]*?background-color: #cbd5e1/
    );
    assert.match(
      globalStyles,
      /library-selection-badge-checkbox:checked[\s\S]*?fill='%234f46e5'/
    );
    assert.match(
      globalStyles,
      /library-selection-badge-checkbox:indeterminate[\s\S]*?stroke='%234f46e5'/
    );
  });

  it('projects cross-page storage without letting retained totals shift the header', () => {
    assert.match(source, /\/api\/v1\/library\/selection-size/);
    assert.match(
      source,
      /useSWR<LibrarySelectionSizeResponse>[\s\S]*?keepPreviousData: true/
    );
    assert.match(
      source,
      /getLibrarySelectionSizePresentation\(bulkTargets, selectionSizeData\)/
    );
    assert.match(
      source,
      /selectionSizePresentation\.retained[\s\S]*?messages\.selectedSizeUpdating[\s\S]*?stale: true/
    );
    assert.doesNotMatch(source, /selectedSizePrevious|Previous \{size\}/);
    assert.match(source, /selectionSizePresentation\.unknownFileCount > 0/);
    assert.match(
      source,
      /label: `\$\{partial \? '\\u2265' : ''\}\$\{formatted\}`/
    );
    assert.match(
      source,
      /inline-flex items-center gap-1 tabular-nums[\s\S]*?data-testid="library-selection-size"/
    );
    assert.doesNotMatch(source, /w-\[5\.75rem\]|selectionSizeValidating/);
    assert.match(
      source,
      /data-testid="library-selection-count"[\s\S]*?aria-live="polite"/
    );
    assert.doesNotMatch(source, /min-w-\[4rem\] tabular-nums/);
    assert.doesNotMatch(source, /selectedSizeCalculating/);
    assert.doesNotMatch(
      source,
      /absolute right-0 h-3 w-3 animate-spin[\s\S]*?border-t-gray-300/
    );
    assert.match(source, /flex flex-none items-center gap-2/);
    assert.match(source, /text-gray-500 opacity-60/);
    assert.match(
      source,
      /data-testid="library-selection-clear"[\s\S]*?data-testid="library-selection-divider"[\s\S]*?data-testid="library-bulk-actions"/
    );
    assert.doesNotMatch(source, /min-w-\[14\.5rem\]/);
    assert.match(
      source,
      /data-testid="library-bulk-actions"[\s\S]*?openBulkAction\('remove_now', event\)[\s\S]*?openBulkAction\([\s\S]*?'schedule'[\s\S]*?openBulkAction\([\s\S]*?'cancel_schedule'/
    );
    assert.match(
      source,
      /w-full min-w-0 flex-wrap[\s\S]*?xl:w-auto xl:flex-shrink-0/
    );
    assert.match(
      source,
      /const handleLibraryChanged = useCallback\([\s\S]*?mutateSelectionSize\(\)/
    );
  });

  it('uses one compact confirmation layout for schedule, cancel, and remove', () => {
    assert.match(source, /Permission\.ADMIN/);
    assert.match(source, /getLibraryBulkActionTargets\(selectedKeys\)/);
    assert.match(
      source,
      /openBulkAction\([\s\S]*?'schedule',[\s\S]*?bulkEligibilityPresentation\.scheduleTargets/
    );
    assert.match(
      source,
      /openBulkAction\([\s\S]*?'cancel_schedule',[\s\S]*?bulkEligibilityPresentation\.cancelTargets/
    );
    assert.match(source, /openBulkAction\('remove_now', event\)/);
    assert.match(source, /<TrashIcon className="h-4 w-4" \/>/);
    assert.match(source, /\/api\/v1\/library\/bulk-actions/);
    assert.match(source, /bulkEligibilityPending \|\|[\s\S]*?!removalSettings/);
    assert.match(source, /backgroundClickable=\{!bulkSubmitting\}/);
    assert.match(source, /reconcileLibrarySelectionAfterBulkAction/);
    assert.match(
      source,
      /aria-label=\{intl\.formatMessage\(messages\.batchSummary\)\}/
    );
    assert.doesNotMatch(source, /Files will not be deleted immediately/);
    assert.doesNotMatch(
      source,
      /already-running provider deletion cannot be stopped/
    );
    assert.match(source, /scheduleConfirm: 'Schedule'/);
    assert.match(source, /cancelConfirm: 'Confirm'/);
    assert.match(source, /removeSelected: 'Remove'/);
    assert.match(
      source,
      /one \{Schedule removal for # item\?\} other \{Schedule removal for # items\?\}/
    );
    assert.match(
      source,
      /one \{Cancel scheduled removal for # item\?\} other \{Cancel scheduled removal for # items\?\}/
    );
    assert.match(
      source,
      /one \{Remove # item from library\?\} other \{Remove # items from library\?\}/
    );
    assert.match(source, /!max-w-\[30rem\]/);
    assert.match(source, /!w-\[calc\(100%_-_2rem\)\]/);
    assert.match(source, /\[&>div:last-child\]:!justify-start/);
    assert.match(source, /text-xs leading-4 text-gray-400/);
    assert.match(source, /\{bulkTargetSummary\}/);
    assert.doesNotMatch(source, /messages\.targetCounts/);
    assert.doesNotMatch(source, /whole Series/);
    assert.match(
      source,
      /okButtonType=\{bulkAction === 'schedule' \? 'warning' : 'danger'\}/
    );
    assert.doesNotMatch(source, /Selected media will be permanently removed\./);
    assert.match(source, /bulkTargetCounts\.movie > 0/);
    assert.match(source, /bulkTargetCounts\.series > 0/);
    assert.match(source, /bulkTargetCounts\.season > 0/);
    assert.match(source, /\.join\(' · '\)/);
    assert.doesNotMatch(source, /total target/);
    assert.doesNotMatch(source, /Whole-Series removal includes all files/);
    assert.doesNotMatch(source, /Provider operations may partially succeed/);
    assert.match(source, /bulkTargets\.length > 10/);
    assert.match(source, /bulkSubmissionInFlight\.current/);
    assert.match(source, /getLibraryBulkActionPresentation/);
    assert.match(source, /presentation\.state === 'success'/);
    assert.match(source, /addToast\(/);
    assert.match(source, /messages\.viewFailures/);
    assert.match(source, /bulkResultPresentation\.issues\.map/);
    assert.match(source, /bulkResultPresentation\.retryable\.map/);
    assert.match(source, /formatBulkTargetLabel\(item\.target\)/);
    assert.match(source, /formatBulkFailure\(item\)/);
    assert.doesNotMatch(source, /messages\.batchSummaryCounts/);
    assert.doesNotMatch(source, /bulkTargetLabel\(item\.target\)/);
    assert.match(source, /window\.requestAnimationFrame/);
  });

  it('uses authoritative state-aware Schedule and Cancel target subsets', () => {
    assert.match(source, /\/api\/v1\/library\/bulk-actions\/eligibility/);
    assert.match(source, /keepPreviousData: true/);
    assert.match(
      source,
      /getLibraryBulkActionEligibilityPresentation\([\s\S]*?bulkTargets,[\s\S]*?bulkEligibilityData/
    );
    assert.match(
      source,
      /bulkEligibilityValidating \|\|[\s\S]*?bulkEligibilityError[\s\S]*?!bulkEligibilityPresentation\.matchesSelection/
    );
    assert.match(
      source,
      /bulkEligibilityDisplayPresentation\.scheduleTargets\.length >[\s\S]*?0/
    );
    assert.match(
      source,
      /bulkEligibilityDisplayPresentation\.cancelTargets\.length >[\s\S]*?0/
    );
    assert.match(
      source,
      /openBulkAction\([\s\S]*?'schedule',[\s\S]*?bulkEligibilityPresentation\.scheduleTargets/
    );
    assert.match(
      source,
      /openBulkAction\([\s\S]*?'cancel_schedule',[\s\S]*?bulkEligibilityPresentation\.cancelTargets/
    );
    assert.match(
      source,
      /bulkEligibilityInitialLoading[\s\S]*?bulkEligibilityDisplayPresentation\.scheduleTargets\.length === 0[\s\S]*?bulkEligibilityDisplayPresentation\.cancelTargets\.length === 0/
    );
    assert.match(
      source,
      /scheduleEligibleCount:[\s\S]*?Schedule removal for # item[\s\S]*?Schedule removal for # items/
    );
    assert.match(
      source,
      /cancelEligibleCount:[\s\S]*?Cancel scheduled removal for # item[\s\S]*?Cancel scheduled removal for # items/
    );
    assert.match(
      source,
      /removeSelectedCount:[\s\S]*?Remove # item[\s\S]*?Remove # items/
    );
    assert.match(
      source,
      /<TrashIcon className="h-4 w-4" \/>[\s\S]*?<span>\{bulkTargets\.length\}<\/span>/
    );
    assert.match(
      source,
      /<CalendarDateRangeIcon className="h-5 w-5" \/>[\s\S]*?bulkEligibilityDisplayPresentation\.scheduleTargets[\s\S]*?\.length/
    );
    assert.match(
      source,
      /<CalendarIcon className="h-4 w-4" \/>[\s\S]*?bulkEligibilityDisplayPresentation\.cancelTargets[\s\S]*?\.length/
    );
    assert.match(source, /disabled=\{[\s\S]*?bulkEligibilityPending/);
    assert.match(source, /aria-busy=\{bulkEligibilityPending \|\| undefined\}/);
    assert.match(source, /mutateBulkEligibility/);
    assert.match(
      source,
      /retryBulkEligibility:[\s\S]*?Unable to check Schedule and Cancel availability\. Retry\./
    );
    assert.match(
      source,
      /bulkEligibilityError[\s\S]*?onClick=\{\(\) => void mutateBulkEligibility\(\)\}/
    );
    assert.match(
      source,
      /bulkEligibilityPresentation\.unresolvedCount > 0[\s\S]*?bulkEligibilityUnavailableLabel/
    );
    assert.match(
      source,
      /bulkEligibilityInitialLoading[\s\S]*?messages\.checkingBulkEligibility/
    );
  });

  it('keeps the synchronization warning visible with factual source details', () => {
    assert.match(source, /sourceWarning: 'Library data may be incomplete'/);
    assert.match(source, /data\.sourceStatus\.library !== 'current'/);
    assert.match(source, /data\.sourceStatus\.currentViewing !== 'current'/);
    assert.match(
      source,
      /data\.sourceStatus\.historicalImport\.state !== 'accepted'/
    );
    assert.match(source, /libraryHydration: 'Library hydration'/);
    assert.match(source, /currentViewing: 'Current viewing'/);
    assert.match(source, /historicalViewing: 'Historical viewing'/);
    assert.match(source, /<InformationCircleIcon/);
    assert.match(source, /<Popover className="relative flex">/);
    assert.match(source, /<PopoverButton/);
    assert.match(source, /<PopoverPanel/);
    assert.match(
      source,
      /aria-label=\{intl\.formatMessage\(messages\.incompleteSourcesLabel/
    );
  });

  it('isolates Library row rendering from unrelated page state', () => {
    assert.match(source, /import LibraryResults from '.\/LibraryResults'/);
    assert.match(
      source,
      /<LibraryResults[\s\S]*?items=\{stableLibraryItems\}[\s\S]*?resetKey=\{apiUrl \?\? ''\}[\s\S]*?onChanged=\{handleLibraryChanged\}/
    );
    assert.doesNotMatch(source, /data\.results\.map\(\(item\)/);
    assert.doesNotMatch(source, /const \[expanded, setExpanded\]/);
    assert.doesNotMatch(source, /onToggleExpanded=\{\(\) =>/);
    assert.doesNotMatch(source, /onChanged=\{\(\) =>/);
    assert.match(row, /export default memo\(LibraryItem\)/);
    assert.match(results, /export default memo\(LibraryResults\)/);
    assert.match(source, /stabilizeLibraryItems\(/);
    assert.match(results, /window\.requestAnimationFrame/);
    assert.match(results, /window\.cancelAnimationFrame/);
    assert.match(results, /startTransition/);
    assert.match(results, /items\.slice\(0, mountedCount\)\.map/);
    assert.match(results, /aria-busy=\{pagePending \|\| mounting\}/);
    assert.match(
      results,
      /const handleToggleExpanded = useCallback\(\(canonicalMediaId: number\) =>/
    );
    assert.match(
      results,
      /onToggleExpanded=\{handleToggleExpanded\}[\s\S]*?onChanged=\{onChanged\}/
    );
    assert.doesNotMatch(results, /onToggleExpanded=\{\(\) =>/);
    assert.doesNotMatch(results, /onChanged=\{\(\) =>/);
    assert.match(
      results,
      /expansion\.resetKey === resetKey \? expansion\.canonicalMediaId : null/
    );
    assert.match(
      results,
      /useEffect\(\(\) => \{[\s\S]*?canonicalMediaId: null[\s\S]*?\}, \[resetKey\]\)/
    );
  });

  it('keeps cached Library content tall enough for Next Back restoration', () => {
    assert.match(
      source,
      /getInitialLibraryPreferenceState\(\{[\s\S]*?query: router\.query,[\s\S]*?routeReady: router\.isReady/
    );
    assert.match(
      source,
      /useState<LibraryPreferences>\([\s\S]*?initialPreferenceState\.preferences/
    );
    assert.match(source, /useState\([\s\S]*?initialPreferenceState\.ready/);
    assert.match(results, /const retainedLibraryMountCounts = new Map/);
    assert.match(
      results,
      /getInitialLibraryMountCount\([\s\S]*?retainedLibraryMountCounts\.get\(resetKey\)/
    );
    assert.match(
      results,
      /retainLibraryMountCount\([\s\S]*?retainedLibraryMountCounts,[\s\S]*?resetKey,[\s\S]*?mountedCount/
    );
    assert.doesNotMatch(source, /window\.scrollTo|history\.scrollRestoration/);
    assert.doesNotMatch(results, /window\.scrollTo|setTimeout/);
  });

  it('revalidates cold presentation once through a bounded status batch', () => {
    assert.match(source, /data\?\.presentation\?\.state !== 'pending'/);
    assert.match(
      source,
      /\/api\/v1\/library\/presentation-status\/\$\{batchId\}/
    );
    assert.match(source, /attempts >= 40/);
    assert.match(source, /Math\.min\(500 \* attempts, 2000\)/);
    assert.match(
      source,
      /status\.state === 'complete' \|\| status\.state === 'partial'/
    );
    assert.match(source, /await mutate\(\)/);
    assert.match(source, /cancelled = true/);
    assert.match(source, /clearTimeout\(timeout\)/);
    assert.doesNotMatch(source, /setInterval\(/);
  });

  it('uses the shared factual relative-day projection', () => {
    assert.match(row, /factualDaysAgo/);
    assert.match(row, /parseFactualDate/);
    assert.doesNotMatch(row, /86_400_000/);
  });

  it('keeps exact local timestamps in Last active, Requester, and Watched tooltips', () => {
    assert.match(
      row,
      /includeTime[\s\S]*?dateStyle: 'medium',[\s\S]*?timeStyle: 'short'/
    );
    assert.match(
      row,
      /<Tooltip content=\{intl\.formatMessage\(messages\.lastActive\)\}>[\s\S]*?aria-label=\{intl\.formatMessage\(messages\.lastActive\)\}/
    );
    assert.match(
      row,
      /<LastActiveAvatarStack[\s\S]*?users=\{item\.lastActiveUsers\}[\s\S]*?lastActiveAt=\{item\.lastActiveAt\}/
    );
    assert.match(
      engagement,
      /formattedLastActiveAt[\s\S]*?parseFactualDate\(lastActiveAt\)[\s\S]*?dateStyle: 'medium',[\s\S]*?timeStyle: 'short'/
    );
    assert.match(
      engagement,
      /libraryLastActiveTooltip\(user\.displayName, formattedLastActiveAt\)/
    );
    assert.doesNotMatch(engagement, /Last active:/);
    assert.match(
      engagement,
      /const requesterDate = \(intl: IntlShape, value: string\)[\s\S]*?dateStyle: 'medium',[\s\S]*?timeStyle: 'short'/
    );
    assert.match(engagement, /request\.createdAt/);
    assert.match(engagement, /season\.createdAt/);
    assert.match(
      engagement,
      /viewer\.lastViewedAt[\s\S]*?dateStyle: 'medium',[\s\S]*?timeStyle: 'short'/
    );
    assert.match(engagement, /libraryWatchedTooltip\([\s\S]*?viewer,/);
  });

  it('describes requester facts for assistive technology without changing the avatar grid', () => {
    assert.match(
      engagement,
      /aria-label=\{requester\.displayName\}[\s\S]*?aria-describedby=\{descriptionId\}/
    );
    assert.match(
      engagement,
      /<span id=\{descriptionId\} className="sr-only">[\s\S]*?\{description\}/
    );
    assert.match(
      engagement,
      /requesterDetailText\(intl, requester\)\.join\('\. '\)/
    );
    assert.match(
      engagement,
      /<RequesterAvatar requester=\{requester\} key=\{requester\.id\}/
    );
  });

  it('keeps durable row identity and keys rich pagination content', () => {
    assert.match(
      results,
      /key=\{`\$\{item\.mediaType\}:\$\{item\.canonicalMediaId\}`\}/
    );
    assert.match(source, /<span key="showing-range" className="font-medium">/);
  });

  it('keeps Search, Media, Filters, and Sort in one sticky compact header row', () => {
    assert.match(
      source,
      /sticky top-\[calc\(4rem\+env\(safe-area-inset-top\)\)\][^"]*"[\s\S]*?data-testid="library-sticky-header"[\s\S]*?<Header>\{intl\.formatMessage\(messages\.title\)\}<\/Header>/
    );
    assert.match(
      source,
      /flex flex-col justify-between xl:flex-row xl:items-end/
    );
    assert.match(
      source,
      /relative z-50 mt-2 flex min-w-0 flex-wrap items-center gap-2 xl:ml-1 xl:flex-1 xl:justify-end xl:gap-1/
    );
    const stickyWrapper = source.match(
      /className="([^"]*sticky top-\[calc\(4rem\+env\(safe-area-inset-top\)\)\][^"]*)"/
    );
    assert.ok(stickyWrapper);
    assert.doesNotMatch(stickyWrapper[1], /border-y/);
    assert.match(stickyWrapper[1], /mb-5/);
    assert.match(stickyWrapper[1], /pt-1/);
    assert.match(stickyWrapper[1], /(?:^|\s)-mx-4(?:\s|$)/);
    assert.match(stickyWrapper[1], /(?:^|\s)px-4(?:\s|$)/);
    assert.doesNotMatch(stickyWrapper[1], /sm:-mx-8|sm:px-8/);
    assert.doesNotMatch(stickyWrapper[1], /(?:^|\s)mt-1(?:\s|$)/);
    assert.doesNotMatch(source, /\[&>div\]:mt-0|\[&_h2\]:mb-0/);
    const search = source.indexOf('type="text"');
    const media = source.indexOf('<MediaTypeFilter');
    const filtersButton = source.indexOf(
      'onClick={() => setShowFilters(true)}'
    );
    const sort = source.indexOf('<BarsArrowDownIcon');
    assert.ok(search > 0);
    assert.ok(search < media);
    assert.ok(media < sort);
    assert.ok(sort < filtersButton);
    assert.match(source, /flex w-full min-w-0 sm:w-64 sm:flex-none/);
    assert.match(
      source,
      /inline-flex cursor-default items-center rounded-l-md border border-r-0 border-gray-500 bg-gray-800 px-3 text-sm text-gray-100[\s\S]*?<MagnifyingGlassIcon className="h-6 w-6" \/>[\s\S]*?<input[\s\S]*?type="text"[\s\S]*?className="rounded-r-only"/
    );
    assert.doesNotMatch(source, /ArchiveBoxIcon|messages\.libraryScope/);
    assert.match(source, /<MediaTypeFilter/);
    assert.match(source, /label: intl\.formatMessage\(globalMessages\.all\)/);
    assert.doesNotMatch(source, /All media|messages\.allMedia/);
    assert.match(source, /messages\.search/);
    assert.match(source, /countActiveLibraryFilters\(preferences\)/);
    assert.match(
      source,
      /activeFilters:[\s\S]*?one \{# Active Filter\} other \{# Active Filters\}/
    );
    assert.match(
      source,
      /<Button[\s\S]*?className="w-full"[\s\S]*?messages\.activeFilters[\s\S]*?count: countActiveLibraryFilters\(preferences\)/
    );
    assert.match(source, /messages\.sort/);
  });

  it('uses a Library-specific drawer for bounded factual filters', () => {
    assert.match(source, /<FilterSlideover/);
    assert.match(filters, /filters: 'Filters'/);
    assert.match(filters, /libraryScope: 'Media Status'/);
    assert.match(filters, /scopeCurrent: 'Active'/);
    assert.match(filters, /scopeArchive: 'Archived'/);
    assert.match(filters, /added: 'Added Date'/);
    assert.match(filters, /lastActive: 'Last Active Date'/);
    assert.match(filters, /removalDue: 'Scheduled Removal Date'/);
    assert.match(filters, /removed: 'Removed Date'/);
    assert.match(filters, /scheduled: 'Leaving Soon'/);
    assert.match(filters, /animation: 'Animation'/);
    assert.match(filters, /collectionMembership: 'In Collection'/);
    assert.doesNotMatch(
      filters,
      /Pending Removal|Movie collection membership|In a collection|Not in a collection/
    );
    assert.match(filters, /activity: 'Has Activity'/);
    assert.match(
      filters,
      /activeFilters:[\s\S]*?one \{# Active Filter\} other \{# Active Filters\}/
    );
    assert.ok(
      filters.indexOf('messages.libraryScope') <
        filters.indexOf('messages.storage')
    );
    assert.match(filters, /value=\{preferences\.scope\}/);
    assert.match(filters, /value=\{preferences\.animation\}/);
    assert.match(filters, /value=\{preferences\.collectionMembership\}/);
    assert.match(
      filters,
      /<MediaStatusFilter[\s\S]*?messages\.scopeCurrent[\s\S]*?messages\.scopeArchive[\s\S]*?value=\{preferences\.scope\}[\s\S]*?update\(\{ scope \}\)/
    );
    const scopeControl = filters.indexOf('value={preferences.scope}');
    const usersSection = filters.indexOf(
      '<Section title={intl.formatMessage(messages.users)}>'
    );
    const addedDate = filters.indexOf('inputName="library-added"');
    const lastActiveDate = filters.indexOf('inputName="library-last-active"');
    const removalDueDate = filters.indexOf('inputName="library-removal-due"');
    const removedDate = filters.indexOf('inputName="library-removed"');
    const storageSection = filters.indexOf(
      '<Section title={intl.formatMessage(messages.storage)}>'
    );
    assert.ok(scopeControl < addedDate);
    assert.ok(scopeControl < usersSection);
    assert.ok(usersSection < addedDate);
    assert.ok(addedDate < lastActiveDate);
    assert.ok(lastActiveDate < removalDueDate);
    assert.ok(removalDueDate < removedDate);
    assert.ok(removedDate < storageSection);
    for (const inputName of [
      'library-added',
      'library-last-active',
      'library-removal-due',
      'library-removed',
    ])
      assert.equal(filters.split(`inputName="${inputName}"`).length - 1, 1);
    assert.match(
      filters,
      /preferences\.scope !== 'archive'[\s\S]*?inputName="library-removal-due"/
    );
    assert.match(
      filters,
      /preferences\.scope !== 'current'[\s\S]*?inputName="library-removed"/
    );
    assert.doesNotMatch(filters, /messages\.dates|Dates and activity/);
    assert.match(filters, /storageRootIds/);
    assert.match(filters, /watchlist/);
    assert.match(filters, /watched/);
    assert.match(filters, /requested/);
    assert.equal((filters.match(/<MediaStatusFilter\b/g) ?? []).length, 1);
    assert.equal((filters.match(/<SegmentedFilter\b/g) ?? []).length, 7);
    assert.equal(
      (filters.match(/grid grid-cols-1 gap-4 sm:grid-cols-2/g) ?? []).length,
      2
    );
    const mediaStatus = filters.indexOf('<MediaStatusFilter');
    const activity = filters.indexOf('name="activity"');
    const pendingRemoval = filters.indexOf('name="scheduled"');
    const animation = filters.indexOf('name="animation"');
    const collectionMembership = filters.indexOf(
      'name="collection-membership"'
    );
    const groupDivider = filters.indexOf(
      'className="border-t border-gray-700" aria-hidden="true"'
    );
    const watchlist = filters.indexOf('name="watchlist"');
    const watched = filters.indexOf('name="watched"');
    const requested = filters.indexOf('name="requested"');
    assert.ok(mediaStatus < activity);
    assert.ok(activity < pendingRemoval);
    assert.ok(pendingRemoval < animation);
    assert.ok(animation < collectionMembership);
    assert.ok(collectionMembership < groupDivider);
    assert.ok(groupDivider < watchlist);
    assert.ok(watchlist < watched);
    assert.ok(watched < requested);
    assert.ok(requested < usersSection);
    assert.equal((filters.match(/aria-hidden="true"/g) ?? []).length, 1);
    for (const filter of [
      'watchlist',
      'watched',
      'requested',
      'activity',
      'animation',
      'collection-membership',
    ])
      assert.match(filters, new RegExp(`name="${filter}"`));
    assert.match(filters, /type="checkbox"/);
    assert.match(filters, /library-scope-\$\{option\.value\}/);
    assert.match(filters, /isLibraryScopeSelected\(value, option\.value\)/);
    assert.match(
      filters,
      /toggleLibraryScopeSelection\(value, option\.value\)/
    );
    assert.doesNotMatch(filters, /scopeOptions|messages\.scopeAll/);
    assert.match(
      filters,
      /name="watched"[\s\S]*?value=\{preferences\.watched\}[\s\S]*?options=\{triStateOptions\}[\s\S]*?update\(\{ watched \}\)/
    );
    assert.match(filters, /<fieldset>/);
    assert.match(filters, /type="radio"/);
    assert.match(filters, /name=\{`library-\$\{name\}-filter`\}/);
    assert.match(filters, /checked=\{selected\}/);
    assert.match(filters, /\{ value: 'any'/);
    assert.match(filters, /\{ value: 'yes'/);
    assert.match(filters, /\{ value: 'no'/);
    assert.match(
      filters,
      /activityOptions = \[[\s\S]*?value: 'any'[\s\S]*?value: 'present'[\s\S]*?messages\.yes[\s\S]*?value: 'none'[\s\S]*?messages\.no/
    );
    assert.match(
      filters,
      /collectionMembershipOptions = \[[\s\S]*?value: 'any'[\s\S]*?messages\.any[\s\S]*?value: 'in'[\s\S]*?messages\.yes[\s\S]*?value: 'none'[\s\S]*?messages\.no/
    );
    assert.match(
      filters,
      /className="isolate inline-flex rounded-md shadow-sm"/
    );
    assert.match(filters, /inline-flex min-w-\[3\.25rem\]/);
    assert.doesNotMatch(filters, /allCollections|inCollection|notInCollection/);
    assert.match(
      source,
      /preferences\.collectionMembership !== 'any'[\s\S]*?data\?\.collectionMembershipUnknownCount[\s\S]*?messages\.collectionMembershipUnknown/
    );
    assert.match(
      filters,
      /preferences\.scope !== 'archive'[\s\S]*?name="scheduled"[\s\S]*?value=\{preferences\.scheduled\}/
    );
    assert.doesNotMatch(filters, /<TriState\b|<SegmentedTriState\b/);
    assert.match(filters, /userIds/);
    assert.doesNotMatch(filters, /messages\.people|messages\.usersHelp/);
    assert.doesNotMatch(filters, /library-users-filter/);
    assert.match(
      filters,
      /<UserAvatar user=\{user\} showTooltip=\{false\} \/>/
    );
    assert.match(filters, /<Tooltip content=\{user\.displayName\}/);
    assert.match(filters, /aria-pressed=\{selected\}/);
    assert.match(filters, /disabled=\{!userSelectionEnabled\}/);
    assert.match(
      filters,
      /const userSelectionEnabled = hasLibraryUserAssociationFilter\(preferences\)/
    );
    assert.match(
      filters,
      /userSelectionEnabled && preferences\.userIds\.includes\(user\.id\)/
    );
    assert.match(filters, /bg-indigo-600 ring-2 ring-indigo-400/);
    assert.match(
      filters,
      /focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:ring-offset-gray-900/
    );
    assert.doesNotMatch(filters, /transition focus:outline-none focus:ring-2/);
    assert.match(filters, /opacity-40 grayscale hover:opacity-70/);
    assert.match(filters, /cursor-not-allowed opacity-40 grayscale/);
    assert.match(
      filters,
      /userIds: toggleLibraryUserSelection\([\s\S]*?preferences\.userIds,[\s\S]*?user\.id[\s\S]*?\)/
    );
    assert.match(filters, /activityFrom/);
    assert.match(filters, /removalDueFrom/);
    assert.match(filters, /removalSources/);
    assert.match(
      filters,
      /import Datepicker from '@seerr-team\/react-tailwindcss-datepicker'/
    );
    assert.match(filters, /containerClassName="datepicker-wrapper"/);
    assert.match(filters, /inputClassName="pr-1 sm:pr-4 text-base leading-5"/);
    assert.match(filters, /className="w-full"/);
    assert.equal((filters.match(/relative z-40/g) ?? []).length, 1);
    assert.match(filters, /className="relative z-40 space-y-4"/);
    assert.match(filters, /normalizeLibraryDate\(value\?\.startDate\)/);
    assert.match(
      filters,
      /key=\{`\$\{inputName\}-from-\$\{from \?\? 'empty'\}`\}/
    );
    assert.match(filters, /key=\{`\$\{inputName\}-to-\$\{to \?\? 'empty'\}`\}/);
    assert.doesNotMatch(filters, /type="date"/);
    assert.doesNotMatch(filters, /grid-cols-\[minmax|border-b border-gray/);
    assert.doesNotMatch(filters, /quality|rating/i);
    assert.equal(
      (source.match(/animation: preferences\.animation/g) ?? []).length,
      2
    );
  });

  it('loads filter users independently only while the drawer is open', () => {
    assert.match(
      source,
      /const \[filterUserSnapshot, setFilterUserSnapshot\] = useState\([\s\S]*?emptyLibraryFilterUserSnapshot[\s\S]*?\)/
    );
    assert.match(
      source,
      /const latestFilterUserQuery = useRef<string \| null>\(null\)/
    );
    assert.match(
      source,
      /if \(!preferencesReady \|\| !showFilters\) return null;/
    );
    assert.match(
      source,
      /\/api\/v1\/library\/user-availability\?\$\{serializeLibraryQuery\(params\)\}/
    );
    assert.match(
      source,
      /useSWR<LibraryFilterUsersResponse>\(availabilityApiUrl\)/
    );
    assert.match(
      source,
      /latestFilterUserQuery\.current = availabilityApiUrl;[\s\S]*?\}, \[availabilityApiUrl\]\)/
    );
    assert.match(
      source,
      /!availabilityApiUrl \|\|[\s\S]*?filterUsersValidating \|\|[\s\S]*?!filterUserData\?\.users \|\|[\s\S]*?latestFilterUserQuery\.current !== availabilityApiUrl[\s\S]*?return;[\s\S]*?setFilterUserSnapshot\(\{[\s\S]*?users: filterUserData\.users,[\s\S]*?associationFilterActive: userSelectionEnabled/
    );
    assert.match(
      source,
      /getLibraryFilterUsersForPresentation\([\s\S]*?filterUserSnapshot,[\s\S]*?userSelectionEnabled[\s\S]*?\)/
    );
    assert.match(
      source,
      /if \(userSelectionEnabled\) return;[\s\S]*?associationFilterActive: false/
    );
    assert.match(source, /users=\{filterUsers\}/);
    assert.doesNotMatch(source, /data\?\.users|data\.users/);
    assert.match(
      source,
      /useSWR<LibraryResultsResponse>\(apiUrl,\s*\{\s*keepPreviousData: true/
    );
  });

  it('keeps the prior page visible and labels it truthfully during pagination', () => {
    assert.match(
      source,
      /const \{ data, error, mutate, isLoading, isValidating \} =\s*useSWR<LibraryResultsResponse>\(apiUrl, \{ keepPreviousData: true \}\)/
    );
    assert.match(
      source,
      /getLibraryPaginationPresentation\(\{[\s\S]*?requestedPage: page,[\s\S]*?responsePage: data\?\.pageInfo\.page,[\s\S]*?isLoading,[\s\S]*?isValidating,[\s\S]*?hasError: Boolean\(error\)/
    );
    assert.match(
      source,
      /<nav[\s\S]*?data-testid="library-page-loading"[\s\S]*?paginationPresentation\.isPagePending[\s\S]*?<ArrowPathIcon[\s\S]*?sr-only[\s\S]*?messages\.loadingPage/
    );
    assert.match(
      source,
      /className="inline-flex h-4 w-4 flex-none items-center justify-center text-gray-400"/
    );
    assert.doesNotMatch(source, /remains visible while page/);
    assert.match(results, /data-library-page=\{responsePage\}/);
    assert.match(results, /data-requested-page=\{requestedPage\}/);
    assert.match(results, /aria-busy=\{pagePending \|\| mounting\}/);
    assert.match(
      source,
      /from:\s*\(paginationPresentation\.displayedPage - 1\) \* pageSize \+\s*1/
    );
    assert.match(source, /!data && !error && <LoadingSpinner \/>/);
  });

  it('keeps confirmed availability through rapid changes and rejects stale responses', () => {
    assert.match(
      source,
      /const latestFilterUserQuery = useRef<string \| null>\(null\)/
    );
    assert.match(
      source,
      /latestFilterUserQuery\.current !== availabilityApiUrl[\s\S]*?return;/
    );
    assert.match(
      source,
      /filterUsersValidating[\s\S]*?return;[\s\S]*?setFilterUserSnapshot/
    );
    assert.match(
      source,
      /if \(userSelectionEnabled\) return;[\s\S]*?associationFilterActive: false/
    );
    assert.doesNotMatch(
      source,
      /setFilterUserSnapshot\(emptyLibraryFilterUserSnapshot\)/
    );
  });

  it('uses the standard combined sort selector with every Library ordering', () => {
    for (const sort of [
      'title.asc',
      'title.desc',
      'added.desc',
      'added.asc',
      'lastActive.desc',
      'lastActive.asc',
      'size.desc',
      'size.asc',
      'removed.desc',
      'removed.asc',
      'watchedUsers.desc',
      'watchedUsers.asc',
    ])
      assert.ok(source.includes(`value="${sort}"`));
    assert.match(source, /<BarsArrowDownIcon className="h-6 w-6" \/>/);
    for (const label of [
      'Title (A-Z) Ascending',
      'Title (Z-A) Descending',
      'Added Descending',
      'Added Ascending',
      'Last Active Descending',
      'Last Active Ascending',
      'Size Descending',
      'Size Ascending',
      'Removed Descending',
      'Removed Ascending',
      'Watched Users Descending',
      'Watched Users Ascending',
    ])
      assert.ok(source.includes(label));
    assert.match(source, /value=\{`\$\{sort\}\.\$\{sortDirection\}`\}/);
    assert.match(
      source,
      /changePreferences\(\{[\s\S]*?sort: nextSort,[\s\S]*?sortDirection: nextSortDirection/
    );
    assert.doesNotMatch(
      source,
      /<ArrowUpIcon|<ArrowDownIcon|messages\.direction/
    );
  });

  it('shows completion only below 100% with keyboard-accessible exact counts', () => {
    assert.match(engagement, /const tooltip = libraryWatchedTooltip\(/);
    assert.match(engagement, /content=\{tooltip\}/);
    assert.match(engagement, /aria-label=\{tooltip\}/);
    assert.match(engagement, /tabIndex=\{0\}/);
    assert.match(
      engagement,
      /showPercentage = viewer\.watchedPercentage < 100/
    );
    assert.match(
      engagement,
      /if \(!showPercentage\)[\s\S]*?className="inline-flex"/
    );
    assert.match(
      engagement,
      /relative inline-flex h-7 items-center[\s\S]*?absolute inset-0 rounded-full[\s\S]*?relative z-10 inline-flex h-7 w-7[\s\S]*?justify-center px-2[\s\S]*?libraryWatchedLabel\(viewer\)/
    );
    assert.doesNotMatch(engagement, /showPercentage \? .*bg-gray-700/);
    assert.doesNotMatch(row, /showPercentage=/);
    assert.match(
      seriesDetail,
      /<WatchedChipGroup[\s\S]*?users=\{season\.users\.map/
    );
    assert.doesNotMatch(seriesDetail, /showPercentage=/);
  });

  it('suppresses only the nested watched-avatar name tooltip', () => {
    assert.match(engagement, /showTooltip = true/);
    assert.match(engagement, /showTooltip \? \(/);
    assert.match(
      engagement,
      /<UserAvatar[\s\S]*?showTooltip=\{false\}[\s\S]*?user=\{\{/
    );
    assert.match(engagement, /<UserAvatar user=\{user\} key=\{user\.id\} \/>/);
    assert.match(engagement, /content=\{tooltip\}/);
  });

  it('renders Series detail Season-first and supplies each chip its Season denominator', () => {
    assert.match(seriesDetail, /data\.seasons\.map\(\(season\)/);
    assert.match(
      seriesDetail,
      /grid grid-cols-1 gap-3 border-t border-gray-700 p-4 lg:grid-cols-2 2xl:grid-cols-3/
    );
    assert.match(
      seriesDetail,
      /flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md bg-gray-900\/40 px-3 py-2"/
    );
    assert.doesNotMatch(seriesDetail, /border-gray-700 bg-gray-900\/40 p-4/);
    assert.match(
      seriesDetail,
      /flex min-w-0 flex-1 flex-wrap items-center gap-1\.5/
    );
    assert.match(seriesDetail, /ml-auto flex flex-shrink-0 items-center gap-2/);
    assert.doesNotMatch(seriesDetail, /min-h-\[2\.25rem\]|mt-3/);
    assert.doesNotMatch(seriesDetail, /rounded-md bg-gray-900\/40[^"\n]*ring/);
    assert.match(
      seriesDetail,
      /availableEpisodeCount: season\.availableEpisodeCount/
    );
    assert.match(seriesDetail, /<WatchedChipGroup/);
    assert.doesNotMatch(seriesDetail, /season\.users\.length === 0/);
  });

  it('uses a content-sized first-load state without the page spinner fixed height', () => {
    assert.match(
      seriesDetail,
      /import \{ SmallLoadingSpinner \} from '@app\/components\/Common\/LoadingSpinner'/
    );
    assert.match(
      seriesDetail,
      /!detailResolved[\s\S]*?absolute inset-x-0 bottom-2[\s\S]*?<SmallLoadingSpinner \/>/
    );
    assert.match(
      seriesDetail,
      /contentVisible \? 'grid-rows-\[1fr\]' : 'grid-rows-\[0fr\]'/
    );
    assert.match(
      seriesDetail,
      /transition-\[grid-template-rows\][\s\S]*?motion-reduce:transition-none/
    );
    assert.match(
      seriesDetail,
      /window\.requestAnimationFrame\(\(\) => setContentVisible\(true\)\)/
    );
    assert.doesNotMatch(seriesDetail, /<LoadingSpinner|h-64/);
  });

  it('orders row and Season watched users with the shared presentation sorter', () => {
    assert.match(
      engagement,
      /orderedUsers = sortLibraryWatchedUsersForPresentation\(users\)/
    );
    assert.match(row, /<WatchedChipGroup users=\{item\.watchedUsers\} \/>/);
    assert.match(
      seriesDetail,
      /<WatchedChipGroup[\s\S]*?users=\{season\.users\.map/
    );
  });

  it('keeps expanded Season facts aligned while secondary details remain subdued', () => {
    assert.match(
      seriesDetail,
      /items-center whitespace-nowrap font-semibold leading-\[0\.8125rem\] text-gray-200/
    );
    assert.equal(
      seriesDetail.match(
        /text-sm font-normal leading-\[0\.8125rem\] text-gray-200/g
      )?.length,
      1
    );
    assert.match(
      seriesDetail,
      /text-xs font-normal leading-\[0\.8125rem\] text-slate-300/
    );
    assert.match(seriesDetail, /mx-1\.5 text-gray-500/);
    assert.doesNotMatch(seriesDetail, /text-sm font-normal text-gray-400/);
  });

  it('overlaps completed avatars while keeping partial completion chips separate', () => {
    assert.match(
      engagement,
      /completedUsers = orderedUsers\.filter\([\s\S]*?viewer\.watchedPercentage === 100/
    );
    assert.match(
      engagement,
      /partialUsers = orderedUsers\.filter\([\s\S]*?viewer\.watchedPercentage < 100/
    );
    assert.match(
      engagement,
      /className="flex h-7 min-w-0 flex-nowrap items-center gap-1\.5"[\s\S]*?className="flex -space-x-1"[\s\S]*?completedUsers\.map[\s\S]*?<\/div>[\s\S]*?partialUsers\.map/
    );
  });

  it('preserves Current-only Remove, Schedule, Cancel, and Season controls', () => {
    assert.match(row, /messages\.removeNow/);
    assert.match(row, /messages\.scheduleRemoval/);
    assert.match(row, /messages\.cancelScheduledRemoval/);
    assert.match(seriesDetail, /targetType: 'season'/);
    assert.match(row, /item\.libraryState === 'current'/);
    assert.match(seriesDetail, /!readOnly/);
  });

  it('keeps scheduled rows compact with a distinct cancel icon and deadline badge', () => {
    assert.match(
      cancelScheduledRemovalButton,
      /CalendarIcon className="h-4 w-4"/
    );
    assert.match(
      row,
      /label=\{intl\.formatMessage\([\s\S]*?messages\.cancelScheduledRemoval/
    );
    assert.match(
      cancelScheduledRemovalButton,
      /h-7 w-7 border-transparent bg-blue-900\/50 !p-0 text-blue-200/
    );
    assert.match(
      cancelScheduledRemovalButton,
      /: 'hover:bg-blue-800\/80 focus:bg-blue-800\/80'/
    );
    assert.match(
      row,
      /axios\.delete\([\s\S]*?`\/api\/v1\/library\/removal-schedules\/\$\{mainSchedule\.id\}`/
    );
    assert.match(
      row,
      /absolute right-0 top-0 z-20 flex[\s\S]*?data-testid="library-leaving-soon-badge"/
    );
    assert.match(
      row,
      /inline-flex h-4 max-w-full items-center whitespace-nowrap rounded-bl-md rounded-tr-xl bg-gray-900\/90 px-2 text-center text-\[0\.6875rem\] font-medium leading-none text-yellow-200 shadow-md/
    );
    assert.match(
      row,
      /className="flex min-w-0 flex-wrap items-center gap-2 self-center xl:w-16 xl:justify-end"[\s\S]*?data-testid="library-action-grid"/
    );
    assert.doesNotMatch(row, /pt-\[1\.0625rem\]/);
    assert.doesNotMatch(
      row,
      /firstSchedule\s*\?\s*['"][^'"]*(?:pt-|mt-|translate-y)/
    );
    assert.match(row, /year: 'numeric'/);
    assert.doesNotMatch(row, /<XMarkIcon/);
    assert.match(
      seriesDetail,
      /label=\{intl\.formatMessage\(messages\.cancelRemoval\)\}/
    );
    assert.doesNotMatch(seriesDetail, /<XMarkIcon/);
  });

  it('keeps the Series expansion chevron accessible without a visual tooltip', () => {
    assert.match(
      row,
      /aria-label=\{intl\.formatMessage\([\s\S]*?messages\.hideSeriesDetail[\s\S]*?messages\.showSeriesDetail/
    );
    assert.match(row, /aria-expanded=\{expanded\}/);
    assert.match(row, /onClick=\{handleToggleExpanded\}/);
    assert.doesNotMatch(
      row,
      /<Tooltip\s+content=\{intl\.formatMessage\(\s*expanded/
    );
  });

  it('uses matching accessible icon-only removal actions for items and Seasons', () => {
    assert.match(row, /removeNow: 'Remove'/);
    assert.match(seriesDetail, /removeNow: 'Remove'/);
    assert.doesNotMatch(row, /removeNow: 'Remove now'/);
    assert.doesNotMatch(seriesDetail, /removeNow: 'Remove now'/);
    for (const component of [row, seriesDetail]) {
      assert.match(component, /CalendarDateRangeIcon/);
      assert.match(component, /buttonType="warning"/);
      assert.match(component, /buttonType="danger"/);
      assert.match(
        component,
        /aria-label=\{intl\.formatMessage\(\s*messages\.scheduleRemoval\s*\)\}/
      );
      assert.match(
        component,
        /aria-label=\{intl\.formatMessage\(\s*messages\.removeNow\s*\)\}/
      );
      assert.match(
        component,
        /content=\{intl\.formatMessage\(\s*messages\.scheduleRemoval\s*\)\}/
      );
      assert.match(
        component,
        /content=\{intl\.formatMessage\(\s*messages\.removeNow\s*\)\}/
      );
    }
    assert.match(
      row,
      /className="h-7 w-7 border-transparent bg-yellow-500\/30 !p-0 hover:bg-yellow-500 focus:bg-yellow-500\/80"/
    );
    assert.match(
      row,
      /className="h-7 w-7 border-transparent bg-red-600\/30 !p-0 hover:bg-red-600 focus:bg-red-600\/80"/
    );
    assert.match(row, /CalendarDateRangeIcon className="!h-6 !w-6"/);
    assert.match(
      seriesDetail,
      /className="h-7 w-7 border-transparent bg-yellow-500\/30 !p-0 hover:bg-yellow-500 focus:bg-yellow-500\/80"/
    );
    assert.match(
      seriesDetail,
      /className="h-7 w-7 border-transparent bg-red-600\/30 !p-0 hover:bg-red-600 focus:bg-red-600\/80"/
    );
    assert.match(seriesDetail, /CalendarDateRangeIcon className="!h-5 !w-5"/);
    assert.match(seriesDetail, /TrashIcon className="h-3\.5 w-3\.5"/);
  });

  it('uses a Library-specific Requests-style structured row without Retention or RequestItem coupling', () => {
    assert.match(results, /<LibraryItem/);
    assert.doesNotMatch(source, /<Table/);
    assert.match(row, /rounded-xl bg-gray-800/);
    assert.match(row, /rounded-xl bg-gray-800 text-gray-400 shadow-md"/);
    assert.doesNotMatch(
      row,
      /rounded-xl bg-gray-800 text-gray-400 shadow-md ring/
    );
    assert.match(row, /md:grid-cols-2/);
    assert.match(row, /xl:grid-cols-/);
    assert.match(row, /data-library-state/);
    assert.doesNotMatch(row, /Retention|Protect|RequestItem|metricsPopulation/);
  });

  it('keeps poster and identity navigation clickable while underlining only the title', () => {
    assert.match(
      row,
      /<Link[\s\S]*?href=\{mediaHref\}[\s\S]*?className=\{posterContainerClassName\}[\s\S]*?aria-label=\{item\.title\}/
    );
    assert.match(
      row,
      /<Link href=\{mediaHref\} className="group block min-w-0">/
    );
    assert.match(
      row,
      /className="mt-1 truncate text-base font-bold text-white group-hover:underline group-focus-visible:underline"/
    );
    assert.doesNotMatch(row, /text-white underline"/);
    assert.doesNotMatch(row, /overflow-hidden hover:underline/);
    assert.match(row, /item\.year[\s\S]*?item\.title/);
  });

  it('uses no media-type badge, icon, label, or placeholder in row identity', () => {
    assert.doesNotMatch(row, /FilmIcon|TvIcon/);
    assert.doesNotMatch(row, /messages\.(?:movie|series)/);
    assert.doesNotMatch(row, /badgeType=\{item\.mediaType/);
  });

  it('shows compact confirmed resolution metadata only on parent media cards', () => {
    assert.match(row, /formatLibraryResolution\(item\.resolution\)/);
    assert.match(
      row,
      /resolutionLabel &&[\s\S]*?<LibraryResolutionBadge label=\{resolutionLabel\} \/>/
    );
    assert.doesNotMatch(
      seriesDetail,
      /formatLibraryResolution|LibraryResolutionBadge|TagIcon|season\.resolution/
    );
    assert.match(row, /<span className="text-xs text-gray-300">/);
    assert.match(row, /flex flex-wrap items-center gap-1/);
    assert.match(
      resolutionBadge,
      /inline-grid h-5 min-w-0 grid-cols-\[1rem_minmax\(0,1fr\)\] items-center gap-x-1\.5 whitespace-nowrap text-sm font-normal text-gray-200/
    );
    assert.match(resolutionBadge, /@heroicons\/react\/24\/solid/);
    assert.doesNotMatch(resolutionBadge, /@heroicons\/react\/24\/outline/);
    assert.match(
      resolutionBadge,
      /<TagIcon className="h-4 w-4 text-slate-300" aria-hidden="true" \/>/
    );
    assert.doesNotMatch(resolutionBadge, /bg-gray|rounded|\bpx-|\bpy-/);
    assert.match(
      row,
      /metadataColumnClassName[\s\S]*?StarIcon[\s\S]*?LibraryResolutionBadge/
    );
  });

  it('shows distinct-file Season size inline without a size tooltip', () => {
    assert.match(seriesDetail, /formatLibrarySize\(season\.sizeBytes\)/);
    assert.match(seriesDetail, /season\.sizeBytes &&/);
    assert.doesNotMatch(seriesDetail, /messages\.(?:historicalSize|size)/);
    assert.match(
      seriesDetail,
      /flex flex-col gap-0\.5[\s\S]*?text-sm font-normal leading-\[0\.8125rem\] text-gray-200[\s\S]*?messages\.episodes[\s\S]*?season\.sizeBytes &&[\s\S]*?text-xs font-normal leading-\[0\.8125rem\] text-slate-300[\s\S]*?readOnly[\s\S]*?messages\.archivedSize[\s\S]*?formatLibrarySize\(season\.sizeBytes\)/
    );
    assert.match(
      seriesDetail,
      /items-center whitespace-nowrap font-semibold leading-\[0\.8125rem\] text-gray-200[\s\S]*?<span className="tabular-nums">/
    );
    assert.doesNotMatch(
      seriesDetail,
      /messages\.episodes[\s\S]*?&middot;[\s\S]*?formatLibrarySize\(season\.sizeBytes\)/
    );
  });

  it('places the existing compact Season strip in the Series identity area once', () => {
    assert.match(
      row,
      /className="min-w-0 pl-3"[\s\S]*?item\.seasonSummaries[\s\S]*?\.filter\(\(season\) => !season\.isSpecial\)[\s\S]*?\.map\(\(season\)[\s\S]*?<SeasonPill/
    );
    assert.equal((row.match(/<SeasonPill/g) ?? []).length, 1);
    assert.match(row, /inline-flex h-6 min-w-6/);
    assert.match(row, /mt-1\.5 flex min-w-0 flex-wrap items-center gap-1/);
    assert.match(row, /season\.isSpecial \? 'S' : season\.seasonNumber/);
  });

  it('presents truthful complete, partial, Missing, Archived, Specials, and unknown-total Season pills', () => {
    assert.match(row, /classifyLibrarySeasonAvailability\(season\)/);
    assert.match(
      row,
      /seasonEpisodeRatio: '\{available\}\/\{known\} episodes'/
    );
    assert.match(row, /seasonArchive: 'Archived'/);
    assert.match(row, /seasonKnownMissing: 'Missing'/);
    assert.match(
      row,
      /availability === 'available' \|\| availability === 'partial'[\s\S]*?messages\.seasonEpisodeRatio[\s\S]*?available: season\.availableEpisodeCount[\s\S]*?known: season\.knownEpisodeCount/
    );
    assert.match(
      row,
      /availability === 'partial'[\s\S]*?border-amber-500\/70 bg-amber-500\/20 text-amber-100/
    );
    assert.match(
      row,
      /season\.state === 'current'[\s\S]*?border-green-500\/70 bg-green-500\/20 text-green-100/
    );
    assert.match(row, /season\.isSpecial[\s\S]*?messages\.specials/);
    assert.match(
      row,
      /availability === 'missing'[\s\S]*?messages\.seasonKnownMissing/
    );
    assert.match(
      row,
      /messages\.availableEpisodes[\s\S]*?count: season\.availableEpisodeCount/
    );
    assert.match(row, /<Tooltip content=\{content\}>/);
    assert.match(
      row,
      /season\.requestable && onRequest[\s\S]*?availability === 'partial'[\s\S]*?`\$\{title\} · \$\{description\} · \$\{requestText\}`[\s\S]*?`\$\{title\} · \$\{requestText\}`/
    );
    assert.doesNotMatch(row, /Known missing/);
    assert.doesNotMatch(seriesDetail, /Known missing/);
  });

  it('uses one responsive aspect-correct poster size for Movies and Series without growing the row', () => {
    assert.match(row, /width=\{64\}/);
    assert.match(row, /height=\{96\}/);
    assert.match(
      row,
      /h-\[5\.0625rem\] w-\[3\.375rem\][\s\S]*?sm:h-24 sm:w-16/
    );
    assert.match(
      row,
      /posterContainerClassName =[\s\S]*?h-\[5\.0625rem\][\s\S]*?sm:w-16/
    );
    assert.match(row, /sm:top-1\/2[\s\S]*?sm:-translate-y-1\/2/);
  });

  it('presents factual Current, Archive, engagement, Fresh and Season summary regions', () => {
    assert.match(row, /CalendarDaysIcon/);
    assert.match(row, /ClockIcon/);
    assert.match(row, /ArrowRightStartOnRectangleIcon/);
    assert.match(row, /item\.libraryState === 'archive'/);
    assert.match(row, /item\.logicalSizeBytes/);
    assert.match(row, /item\.storageRoots/);
    assert.match(row, /item\.watchlistUsers/);
    assert.match(row, /item\.watchedUsers/);
    assert.match(row, /item\.lastActiveUsers/);
    assert.match(row, /item\.requesters/);
    assert.doesNotMatch(row, /item\.watchedUserCount/);
    assert.match(row, /item\.fresh/);
    assert.match(row, /item\.seasonSummaries/);
    assert.doesNotMatch(row, /lastActiveUser:/);
  });

  it('stacks dates and storage facts into two aligned compact metadata columns', () => {
    assert.match(
      row,
      /grid min-w-0 grid-cols-\[4rem_minmax\(0,1fr\)\] items-center gap-x-5 text-sm/
    );
    assert.equal(
      (row.match(/className=\{metadataColumnClassName\}/g) ?? []).length,
      2
    );
    assert.match(
      row,
      /value=\{item\.addedAt\}[\s\S]*?value=\{item\.lastActiveAt\}/
    );
    assert.match(
      row,
      /formatLibrarySize\(item\.logicalSizeBytes\)[\s\S]*?storageLabel/
    );
  });

  it('uses one higher-contrast silver for neutral metadata and engagement icons', () => {
    assert.equal(
      (row.match(/<Icon className="h-4 w-4 text-slate-300"/g) ?? []).length,
      2
    );
    assert.equal(
      (
        row.match(
          /inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-slate-300/g
        ) ?? []
      ).length,
      3
    );
    assert.match(row, /ServerIcon className="h-4 w-4 text-slate-300"/);
    assert.doesNotMatch(row, /CircleStackIcon/);
    assert.match(row, /StarIcon className="h-4 w-4 text-yellow-400"/);
    assert.match(row, /root\.color \? \{ color: root\.color \} : undefined/);
    assert.match(seriesDetail, /CalendarDateRangeIcon className="!h-5 !w-5"/);
    assert.doesNotMatch(seriesDetail, /CalendarDateRangeIcon[^>]*text-slate/);
  });

  it('presents storage display labels while filtering by stable root identity', () => {
    assert.match(row, /item\.storageRoots\[0\]\.label/);
    assert.match(row, /item\.storageRoots\.map\(\(root\) => root\.label\)/);
    assert.match(row, /item\.storageRoots\.map\(\(root\) => \(/);
    assert.match(
      row,
      /root\.color \?[\s\S]*?\{ color: root\.color \}[\s\S]*?: undefined/
    );
    assert.match(row, /root\.color \? '' : 'text-gray-400'/);
    assert.match(filters, /value: location\.id/);
    assert.match(filters, /label: location\.label/);
  });

  it('shows Watchlist membership only when factual users exist', () => {
    assert.match(row, /item\.watchlistUsers\.length > 0/);
    assert.match(row, /BookmarkIcon className="h-4 w-4"/);
    assert.match(row, /content=\{intl\.formatMessage\(messages\.watchlist\)\}/);
    assert.match(
      row,
      /aria-label=\{intl\.formatMessage\(messages\.watchlist\)\}/
    );
    assert.match(row, /<AvatarStack users=\{item\.watchlistUsers\}/);
    assert.match(
      row,
      /inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-slate-300/
    );
    assert.doesNotMatch(row, /item\.watchlistUsers\.length \?/);
  });

  it('shows Watched membership only when factual users exist', () => {
    assert.match(row, /item\.watchedUsers\.length > 0/);
    assert.match(row, /PlayIcon className="h-4 w-4"/);
    assert.match(row, /text-green-400/);
    assert.match(
      row,
      /inline-flex h-4 w-4 flex-shrink-0 items-center justify-center text-green-400/
    );
    assert.equal(
      (
        row.match(
          /flex h-7 w-fit min-w-0 max-w-full flex-nowrap items-center gap-2/g
        ) ?? []
      ).length,
      4
    );
    assert.match(row, /content=\{intl\.formatMessage\(messages\.watched\)\}/);
    assert.match(
      row,
      /aria-label=\{intl\.formatMessage\(messages\.watched\)\}/
    );
    assert.match(row, /<WatchedChipGroup users=\{item\.watchedUsers\} \/>/);
    assert.doesNotMatch(row, /item\.watchedUsers\.length === 0/);
    assert.doesNotMatch(row, /includedMetrics/);
  });

  it('presents Last-active and Requester attribution in the compact engagement grid', () => {
    assert.match(
      row,
      /grid min-w-0 grid-cols-\[4\.75rem_minmax\(0,1fr\)\] content-center items-center gap-x-3 gap-y-3/
    );
    assert.doesNotMatch(
      row,
      /grid min-w-0 grid-cols-\[max-content_minmax\(0,1fr\)\]/
    );
    assert.match(row, /col-start-1 row-start-1/);
    assert.match(row, /col-start-1 row-start-2/);
    assert.match(row, /col-start-2 row-start-1/);
    assert.match(row, /col-start-2 row-start-2/);
    assert.equal(
      (engagement.match(/className="inline-flex h-7"/g) ?? []).length,
      2
    );
    assert.ok(
      row.indexOf('item.lastActiveUsers.length') <
        row.indexOf('item.watchlistUsers.length')
    );
    assert.ok(
      row.indexOf('item.requesters.length') <
        row.indexOf('item.watchedUsers.length')
    );
    assert.match(row, /item\.lastActiveUsers\.length > 0/);
    assert.match(
      row,
      /<LastActiveAvatarStack[\s\S]*?users=\{item\.lastActiveUsers\}[\s\S]*?lastActiveAt=\{item\.lastActiveAt\}[\s\S]*?ariaLabel=\{intl\.formatMessage\(messages\.lastActive\)\}/
    );
    assert.match(row, /item\.requesters\.length > 0/);
    assert.match(row, /FolderArrowDownIcon className="h-4 w-4"/);
    assert.match(
      row,
      /<RequesterAvatarStack[\s\S]*?requesters=\{item\.requesters\}[\s\S]*?ariaLabel=\{intl\.formatMessage\(messages\.requesters\)\}/
    );
    assert.match(engagement, /getLibraryRequesterDetailRows\(requester\)\.map/);
    assert.match(engagement, /row\.kind === 'request'/);
    assert.match(engagement, /row\.request\.is4k/);
    assert.match(engagement, /row\.request\.createdAt/);
    assert.match(engagement, /row\.request\.status/);
    assert.match(engagement, /row\.season\.seasonNumber/);
    assert.match(engagement, /row\.season\.createdAt/);
    assert.match(engagement, /row\.season\.status/);
    assert.match(requesterPresentation, /request\.seasons\.length > 0/);
    assert.match(requesterPresentation, /: \[\{ kind: 'request', request \}\]/);
    assert.match(engagement, /className="flex -space-x-1"/);
  });

  it('reuses the standard filtered Series request modal from eligible Season pills', () => {
    assert.match(
      row,
      /import RequestModal from '@app\/components\/RequestModal'/
    );
    assert.match(row, /Permission\.REQUEST_MOVIE/);
    assert.match(row, /Permission\.REQUEST_TV/);
    assert.match(row, /type: item\.mediaType === 'movie' \? 'movie' : 'tv'/);
    assert.match(row, /type: 'collection'/);
    assert.match(row, /initialSeasonNumber: seasonNumber/);
    assert.match(row, /visibleSeasonNumbers: \[seasonNumber\]/);
    assert.match(row, /season\.requestable/);
    assert.match(row, /actionableAvailability/);
    assert.match(row, /settings\.currentSettings\.partialRequestsEnabled/);
    assert.match(row, /onComplete=\{completeRequest\}/);
    assert.match(
      row,
      /event\.preventDefault\(\);[\s\S]*?event\.stopPropagation\(\)/
    );
    assert.match(requestModal, /initialSeasonNumber=\{initialSeasonNumber\}/);
    assert.match(requestModal, /visibleSeasonNumbers=\{visibleSeasonNumbers\}/);
    assert.match(
      tvRequestModal,
      /initialSeasonNumber === undefined[\s\S]*?\[initialSeasonNumber\]/
    );
    assert.match(
      tvRequestModal,
      /partialRequestsEnabled[\s\S]*?initialSeasonRequestable/
    );
    assert.match(
      tvRequestModal,
      /filterVisibleSeasons\([\s\S]*?visibleSeasonNumbers/
    );
    assert.match(
      tvRequestModal,
      /seasons: settings\.currentSettings\.partialRequestsEnabled[\s\S]*?validatedSelectedSeasons/
    );
    assert.doesNotMatch(seriesDetail, /RequestIconButton/);
  });

  it('places the page-enriched Collection banner in the stable metadata-to-actions region', () => {
    const banner = row.indexOf('<LibraryCollectionBanner');
    const actions = row.indexOf(
      'flex min-w-0 flex-wrap items-center gap-2 self-center xl:w-16 xl:justify-end'
    );
    assert.ok(banner > -1);
    assert.ok(actions > banner);
    assert.match(row, /data-testid="library-collection-banner"/);
    assert.match(row, /collection\.backdropPath \?\? collection\.posterPath/);
    assert.match(row, /href=\{`\/collection\/\$\{collection\.id\}`\}/);
    assert.match(
      row,
      /h-16 w-full min-w-0 max-w-80 overflow-hidden rounded-md/
    );
    assert.doesNotMatch(row, /ring-1 ring-gray-700/);
    assert.doesNotMatch(row, /hover:ring-gray-500/);
    assert.match(
      row,
      /xl:grid-cols-\[minmax\(15rem,1\.05fr\)_minmax\(12rem,0\.8fr\)_4rem_minmax\(18rem,1\.2fr\)_auto\]/
    );
    assert.match(
      row,
      /2xl:grid-cols-\[max-content_minmax\(0,1fr\)\] 2xl:gap-4/
    );
    assert.doesNotMatch(row, /2xl:grid-cols-\[12rem_minmax\(0,1fr\)\]/);
    assert.match(
      row,
      /hidden min-w-0 self-center 2xl:grid 2xl:items-center 2xl:justify-items-end/
    );
    assert.doesNotMatch(row, /2xl:place-items-center/);
    assert.doesNotMatch(
      row,
      /item\.collection[\s\S]{0,120}xl:grid-cols-\[minmax\(15rem/
    );
  });

  it('uses one edge-anchored Collection banner geometry for active and archived rows', () => {
    assert.match(
      row,
      /\{item\.collection && \([\s\S]*?hidden min-w-0 self-center 2xl:grid 2xl:items-center 2xl:justify-items-end[\s\S]*?<LibraryCollectionBanner/
    );
    assert.doesNotMatch(
      row,
      /item\.libraryState[^\n]*\?[^\n]*(?:justify|place)-items/
    );
  });

  it('uses separate accessible Collection navigation and Request targets', () => {
    assert.match(
      row,
      /requestCollection: 'Request collection'[\s\S]*?viewCollection: 'View \{collectionName\}'/
    );
    assert.match(
      row,
      /<Link[\s\S]*?href=\{`\/collection\/\$\{collection\.id\}`\}[\s\S]*?aria-label=\{intl\.formatMessage\(messages\.viewCollection/
    );
    assert.match(
      row,
      /pointer-events-none relative z-20[\s\S]*?pointer-events-auto flex-none[\s\S]*?<RequestIconButton/
    );
    assert.match(
      row,
      /aria-label=\{intl\.formatMessage\(messages\.requestCollection\)\}/
    );
    assert.match(
      row,
      /focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-blue-300/
    );
    assert.match(row, /<RequestIconButton/);
    assert.doesNotMatch(row, /\{intl\.formatMessage\(globalMessages\.view\)\}/);
  });

  it('loads complete Collection availability lazily without shifting banner content', () => {
    assert.match(row, /useInView\(\{[\s\S]*?triggerOnce: true/);
    assert.match(
      row,
      /inView \? `\/api\/v1\/collection\/\$\{collection\.id\}` : null/
    );
    assert.match(row, /dedupingInterval: 300_000/);
    assert.match(row, /revalidateIfStale: false/);
    assert.match(row, /revalidateOnFocus: false/);
    assert.match(
      row,
      /collectionDetails && !collectionError[\s\S]*?getCollectionAvailability\(collectionDetails\)/
    );
    assert.match(row, /getCollectionAvailability\(collectionDetails\)/);
    assert.match(row, /formatCollectionAvailability\(availability\)/);
    assert.match(row, /data-testid="library-collection-availability"/);
    assert.match(row, /truncate text-xs font-semibold/);
    assert.match(row, /min-h-4 whitespace-nowrap text-\[0\.6875rem\]/);
    assert.match(row, /\{availabilityLabel \?\? '\\u00a0'\}/);
    assert.doesNotMatch(row, /focus-within:ring/);
  });

  it('standardizes icon-only Request actions without changing their dimensions', () => {
    assert.match(
      requestIconButton,
      /ArrowDownTrayIcon.*@heroicons\/react\/24\/solid/
    );
    assert.match(requestIconButton, /bg-gray-900\/90/);
    assert.match(requestIconButton, /text-purple-400/);
    assert.match(requestIconButton, /rounded-md/);
    assert.match(requestIconButton, /h-7 w-7/);
    assert.match(requestIconButton, /focus:ring-purple-300/);
    assert.equal((row.match(/<RequestIconButton/g) ?? []).length, 2);
    assert.equal((seriesDetail.match(/<RequestIconButton/g) ?? []).length, 0);
    assert.doesNotMatch(row, /bg-orange-500\/90/);
    assert.doesNotMatch(seriesDetail, /bg-orange-500\/90/);
  });

  it('orders identity, engagement, rating/resolution, factual metadata, and actions', () => {
    const identityRegion = row.indexOf(
      'flex min-w-0 items-center overflow-visible'
    );
    const ratingResolutionRegion = row.indexOf(
      '${metadataColumnClassName} text-sm'
    );
    const engagementRegion = row.indexOf(
      'grid min-w-0 grid-cols-[4.75rem_minmax(0,1fr)] content-center items-center gap-x-3 gap-y-3'
    );
    const metadataRegion = row.indexOf(
      'grid min-w-0 grid-cols-[4rem_minmax(0,1fr)] items-center gap-x-5 text-sm'
    );
    const actionsRegion = row.indexOf(
      'flex min-w-0 flex-wrap items-center gap-2 self-center xl:w-16 xl:justify-end'
    );
    assert.ok(identityRegion > -1);
    assert.ok(engagementRegion > -1);
    assert.ok(identityRegion < engagementRegion);
    assert.ok(engagementRegion < ratingResolutionRegion);
    assert.ok(ratingResolutionRegion < metadataRegion);
    assert.ok(metadataRegion < actionsRegion);
  });

  it('aligns factual metadata on stable two-row tracks and icon slots', () => {
    assert.match(
      row,
      /grid min-w-0 grid-rows-\[1\.25rem_1\.25rem\] content-center gap-y-1\.5/
    );
    assert.match(
      row,
      /xl:grid-cols-\[minmax\(15rem,1\.05fr\)_minmax\(12rem,0\.8fr\)_4rem_minmax\(18rem,1\.2fr\)_auto\]/
    );
    assert.match(
      row,
      /grid min-w-0 grid-cols-\[4rem_minmax\(0,1fr\)\] items-center gap-x-5 text-sm/
    );
    assert.match(
      row,
      /inline-flex h-4 w-4 flex-none items-center justify-center/
    );
    assert.match(
      row,
      /<div className="flex h-5 min-w-0 items-center">[\s\S]*?resolutionLabel &&/
    );
    assert.ok(
      (
        row.match(
          /w-fit max-w-full justify-self-start(?: whitespace-nowrap)? text-gray-200/g
        ) ?? []
      ).length >= 3
    );
  });

  it('keeps archived metadata and its tooltip triggers content-sized', () => {
    assert.match(
      row,
      /className=\{`\$\{metadataRowClassName\} w-fit max-w-full justify-self-start whitespace-nowrap text-gray-200`\}/
    );
    assert.match(
      row,
      /<Badge[\s\S]*?badgeType="light"[\s\S]*?className="w-fit max-w-full justify-self-start"/
    );
  });

  it('uses bounded backdrop presentation with archived grayscale state', () => {
    assert.match(row, /item\.backdropPath/);
    assert.match(row, /w1920_and_h800_multi_faces/);
    assert.match(row, /linear-gradient\(90deg/);
    assert.match(row, /item\.libraryState === 'archive' \? 'grayscale' : ''/);
    assert.match(row, /relative isolate overflow-hidden rounded-xl/);
    assert.match(
      row,
      /absolute inset-0 z-0 w-full overflow-hidden rounded-\[inherit\]/
    );
    assert.match(row, /className="absolute inset-0 rounded-\[inherit\]"/);
    assert.match(row, /relative z-10 grid/);
    assert.doesNotMatch(row, /xl:w-2\/3/);
    assert.doesNotMatch(row, /ArchiveBoxIcon/);
  });

  it('keeps Specials deliberate and verified service links accessible', () => {
    assert.match(row, /\.filter\(\(season\) => !season\.isSpecial\)/);
    assert.match(seriesDetail, /season\.isSpecial/);
    assert.match(row, /RadarrLogo/);
    assert.match(row, /SonarrLogo/);
    assert.match(row, /JellyfinLogo/);
    assert.match(row, /rel="noopener noreferrer"/);
    assert.match(row, /aria-label=\{link\.label\}/);
  });

  it('uses a borderless compact 2-by-2 action grid with the standard Jellyfin icon', () => {
    assert.match(row, /components\/Common\/JellyfinIcon/);
    assert.doesNotMatch(row, /jellyfin-icon\.svg/);
    assert.match(row, /link\.service === 'jellyfin' \? 'h-6 w-6'/);
    assert.match(row, /className=\{iconClassName\}/);
    assert.match(row, /inline-flex h-7 w-7/);
    assert.ok(
      (row.match(/className="grid grid-cols-2 gap-1\.5"/g) ?? []).length >= 2
    );
    assert.match(row, /className="grid w-16 gap-2"/);
    assert.match(row, /item\.externalLinks\.length % 2 === 0/);
    assert.match(row, /'col-span-2 justify-self-center'/);
    assert.ok(
      row.indexOf('item.externalLinks.map') < row.indexOf('{mainSchedule ?')
    );
    assert.ok(
      row.indexOf('{mainSchedule ?') < row.lastIndexOf('messages.removeNow')
    );
    assert.doesNotMatch(row, /ring-1 ring-gray-600/);
    assert.match(row, /focus:ring-2 focus:ring-blue-300/);
    assert.match(row, /border-transparent/);
  });

  it('centers a lone archived Request action inside the shared two-column action geometry', () => {
    assert.match(row, /className="grid w-16 gap-2"/);
    assert.match(row, /className="grid grid-cols-2 gap-1\.5"/);
    assert.match(
      row,
      /item\.externalLinks\.length % 2 === 0[\s\S]*?'col-span-2 justify-self-center'/
    );
    assert.doesNotMatch(row, /grid-cols-3/);
  });

  it('keeps pagination outside the sticky control bar and pins it above results', () => {
    const stickyEnd = source.indexOf('<FilterSlideover');
    const pagination = source.indexOf('aria-label="Pagination"');
    assert.ok(stickyEnd > 0);
    assert.ok(pagination > stickyEnd);
    assert.match(results, /className="space-y-3 pb-28 sm:pb-20"/);
    assert.match(
      source,
      /className="sticky bottom-\[calc\(4rem\+env\(safe-area-inset-bottom\)\)\] z-20 -mx-4 mt-3 border-t border-gray-700 bg-gray-900\/95 px-4 py-3 text-white backdrop-blur sm:bottom-0"/
    );
    assert.match(
      source,
      /flex w-full flex-wrap items-center justify-center gap-x-4 gap-y-2 text-sm min-\[1440px\]:relative min-\[1440px\]:min-h-8 min-\[1440px\]:flex-nowrap min-\[1440px\]:justify-start/
    );
    assert.match(
      source,
      /min-\[1440px\]:w-auto min-\[1440px\]:flex-nowrap min-\[1440px\]:justify-start min-\[1440px\]:gap-x-2 min-\[1440px\]:text-xs/
    );
    assert.match(
      source,
      /flex items-center gap-1 min-\[1440px\]:absolute min-\[1440px\]:left-1\/2 min-\[1440px\]:-translate-x-1\/2/
    );
    assert.match(source, /data-testid="library-pagination-summary"/);
    assert.match(source, /data-testid="library-pagination-controls"/);
    assert.match(source, /Showing <strong>\{from\}<\/strong>.*items/);
    assert.match(source, /itemsPerPage: 'Items per page'/);
    assert.match(source, /perPage: 'Per page'/);
    assert.match(source, /className="w-16 py-1 pl-2 pr-7"/);
    assert.match(source, /data-testid="library-page-size"/);
    assert.match(
      source,
      /flex items-center gap-2 whitespace-nowrap min-\[1440px\]:ml-auto min-\[1440px\]:gap-1 min-\[1440px\]:text-xs/
    );
    assert.doesNotMatch(
      source,
      /globalMessages\.(?:showingresults|resultsperpage)/
    );
    assert.match(
      layout,
      /router\.pathname === '\/library' \? undefined : 'mb-6'/
    );
    assert.match(source, /ChevronDoubleLeftIcon as ChevronsLeftIcon/);
    assert.match(source, /ChevronDoubleRightIcon as ChevronsRightIcon/);
    assert.match(source, /paginationItems\.map\(renderPaginationItem\)/);
    assert.match(source, /nearbyPages\.map\(renderPageNumber\)/);
    assert.match(source, /aria-current=/);
    assert.match(source, /onClick=\{\(\) => goToPage\(1\)\}/);
    assert.match(source, /onClick=\{\(\) => goToPage\(totalPages\)\}/);
    assert.match(source, /hidden items-center gap-1 sm:flex/);
    assert.match(source, /flex items-center gap-1 sm:hidden/);
  });

  it('resets membership changes to page one and follows URL Back/Forward state', () => {
    assert.match(
      source,
      /updateQuery\(\{ \.\.\.libraryPreferencesToQuery\(normalized\), page: '1' \}\)/
    );
    assert.match(source, /router\.asPath/);
    assert.match(
      source,
      /resolveLibraryPreferences\(\{ query: router\.query, stored \}\)/
    );
  });
});
