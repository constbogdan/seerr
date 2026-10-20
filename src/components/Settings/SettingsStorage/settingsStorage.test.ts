import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

describe('Storage settings presentation', () => {
  const component = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
  const page = readFileSync(
    path.join(__dirname, '../../../pages/settings/storage.tsx'),
    'utf8'
  );
  const globalStyles = readFileSync(
    path.join(__dirname, '../../../styles/globals.css'),
    'utf8'
  );

  it('is administrator-only and maps feature toggles to their single persisted authorities', () => {
    assert.match(page, /useRouteGuard\(Permission\.ADMIN\)/);
    assert.match(
      component,
      /checked=\{values\.enabled\}[\s\S]*?setOverflowRoutingEnabled\(current, !current\.enabled\)/
    );
    assert.match(
      component,
      /checked=\{values\.automaticSeriesPlacement\}[\s\S]*?setAutomaticSeriesPlacementEnabled\([\s\S]*?!current\.automaticSeriesPlacement/
    );
    assert.match(
      component,
      /useSWR<StorageJob\[]>\('\/api\/v1\/settings\/jobs'[\s\S]*?job\.id === 'series-relocation'/
    );
    assert.match(
      component,
      /\/api\/v1\/settings\/jobs\/series-relocation\/enabled[\s\S]*?checked=\{seriesRelocationJob\?\.enabled \?\? false\}/
    );
    assert.match(
      component,
      /!values\.automaticSeriesPlacement \|\| selectedSeriesVolumesValid/
    );
    assert.match(
      component,
      /!seriesRelocationJob\?\.enabled \|\| selectedSeriesVolumesValid/
    );
    assert.doesNotMatch(
      component,
      /values\.automaticSeriesPlacement \|\| seriesRelocationJob\?\.enabled/
    );
    assert.match(
      component,
      /setOverflowRoutingEnabled\(current, !current\.enabled\)/
    );
    assert.match(
      component,
      /mutateJobs\([\s\S]*?async \(current\)[\s\S]*?replaceStorageJobState\(current, response\.data\)[\s\S]*?revalidate: false/
    );
    assert.equal(
      (
        component.match(
          /className="flex min-h-12 items-center justify-between gap-4"/g
        ) ?? []
      ).length,
      3
    );
    assert.equal(
      (component.match(/<SlideCheckbox\s+checked=\{values\./g) ?? []).length,
      2
    );
    assert.doesNotMatch(component, /<option value="(?:disabled|enabled)">/);
    assert.doesNotMatch(component, /messages\.(?:disabled|enabled)/);
    assert.doesNotMatch(component, /['"]Preview['"]/);
  });

  it('renders physical-volume and Foundation usage facts with accessible route controls', () => {
    for (const expected of [
      'volume.totalSpace',
      'volume.freeSpace',
      'volume.totalSpace - volume.freeSpace',
      '100 - freePercentage',
      'volume.segments',
      'segment.color',
      'segment.percentage',
      'segment.pendingRemovalBytes',
      'splitRootCapacity',
      'retainedPercentage',
      'leavingSoonPercentage',
      'storage-leaving-soon-segment-',
      'storage-leaving-soon-legend-',
      'repeating-linear-gradient',
      'volume.pendingRemovalBytes',
      'volume.pendingRemovalAvailable',
      'volume.pendingRemovalComplete',
      'volume.unaccountedUsageBytes',
      'volume.provisionedSpaceBytes',
      'volume.capacityReadingsDiffer',
      'overflow-source',
      'overflow-destination',
      'aria-label',
      'storage-capacity-total-',
      'storage-capacity-occupied-',
      'storage-capacity-free-',
      'storage-free-space-segment-',
      'overflow-free-space-threshold',
      "threshold: 'Capacity warning'",
      'FREE_SPACE_THRESHOLDS',
      'isFreeSpaceThreshold',
      'overflow-route-threshold',
      'noCompatibleDestinations',
      'route.thresholdGb',
      'automaticSeriesPlacement',
      'defaultSeriesVolumeId',
      'expansionSeriesVolumeId',
      'seriesSeasonThreshold',
      'torrentRelocationDelayHours',
      'storage-overflow-threshold-',
      'checked={values.enabled}',
      'volumeLabel(route.sourceVolumeId)',
      'classifyFreeSpace',
      'shouldShowCategoryLegend',
      'FREE_SPACE_LEVEL_COLORS',
      "pendingRemoval: 'Leaving Soon'",
      "other: 'Other'",
    ]) {
      assert.ok(component.includes(expected), expected);
    }
    assert.match(component, /className="mt-5 space-y-5"/);
    assert.match(component, /className="flex flex-wrap items-stretch gap-2"/);
    assert.match(component, /storage-volume-summary-/);
    assert.equal((component.match(/basis-40[^"]*px-3 py-1/g) ?? []).length, 4);
    assert.doesNotMatch(component, /basis-40[^"]*px-3 py-2/);
    assert.match(component, /className="flex h-3\.5/);
    assert.doesNotMatch(component, /md:grid-cols-2 xl:grid-cols-3/);
    assert.match(component, /className="mt-3 flex flex-wrap gap-2 text-sm"/);
    assert.match(
      component,
      /className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0\.5 rounded-md/
    );
    assert.match(component, /storage-volume-bar-/);
    assert.match(component, /storage-volume-legend-/);
    assert.match(
      component,
      /if \(!shouldShowCategoryLegend\(retainedBytes\)\) \{[\s\S]*?return null/
    );
    assert.match(
      component,
      /shouldShowCategoryLegend\([\s\S]*?volume\.pendingRemovalBytes[\s\S]*?storage-leaving-soon-legend-/
    );
    assert.match(
      component,
      /shouldShowCategoryLegend\([\s\S]*?volume\.unaccountedUsageBytes[\s\S]*?messages\.other/
    );
    assert.match(
      component,
      /volume\.provisionedSpaceBytes !== null &&[\s\S]*?shouldShowCategoryLegend\([\s\S]*?volume\.provisionedSpaceBytes/
    );
    assert.match(
      component,
      /storage-free-space-segment-[\s\S]*?storage-volume-legend-[\s\S]*?storage-free-legend-[\s\S]*?messages\.free/
    );
    assert.match(
      component,
      /volume\.capacityReadingsDiffer[\s\S]*?messages\.differingCapacity/
    );
    assert.match(component, /width: `\$\{retainedPercentage\}%`/);
    assert.match(component, /width: `\$\{leavingSoonPercentage\}%`/);
    assert.match(component, /backgroundColor: '#111827'/);
    assert.match(component, /#eab308 0, #eab308 2px/);
    assert.doesNotMatch(component, /Root folder details/);
    assert.doesNotMatch(component, /<details/);
    assert.doesNotMatch(component, /of occupied/);
    assert.doesNotMatch(component, /title=\{`\$\{/);
    assert.doesNotMatch(component, /Pending acquisition accounting/);
    assert.match(
      component,
      /hasPositiveBytes\(volume\.provisionedSpaceBytes\)/
    );
    assert.doesNotMatch(component, /Other \/ unaccounted/);
    assert.doesNotMatch(component, /messages\.otherDescription/);
    assert.doesNotMatch(component, /storage-free-space-level-/);
    assert.doesNotMatch(component, /freeSpaceLabel/);
    assert.doesNotMatch(component, /storage-pending-removal-total-/);
    assert.doesNotMatch(component, /\{segment\.label\}\{' '\}/);
    assert.doesNotMatch(component, /threshold: 'Free-space threshold'/);
    assert.doesNotMatch(component, /messages\.locationsDescription/);
    assert.doesNotMatch(component, /messages\.thresholdsDescription/);
    assert.doesNotMatch(component, /Capacity is fetched directly/);
    assert.doesNotMatch(component, /Volumes below this free-space percentage/);
    assert.match(
      component,
      /storage-routing-container[\s\S]*?storage-route-grid storage-add-route-grid[\s\S]*?storage-route-arrow-icon/
    );
    assert.match(globalStyles, /container-type: inline-size/);
    assert.match(globalStyles, /@container \(min-width: 280px\)/);
    assert.match(globalStyles, /@container \(min-width: 700px\)/);
  });

  it('separates Physical volumes, routing configuration, and Automation', () => {
    const physicalVolumes = component.indexOf(
      'data-testid="storage-physical-volumes-section"'
    );
    const overflowRouting = component.indexOf(
      'data-testid="storage-overflow-routing-section"'
    );
    const seriesRouting = component.indexOf(
      'data-testid="storage-series-routing-section"'
    );
    const automation = component.indexOf(
      'data-testid="storage-automation-section"'
    );
    assert.ok(physicalVolumes >= 0);
    assert.ok(overflowRouting > physicalVolumes);
    assert.ok(seriesRouting > overflowRouting);
    assert.ok(automation > seriesRouting);
    assert.doesNotMatch(
      component,
      /storage-(?:automatic-series-placement|series-relocation)-section/
    );
    assert.match(
      component,
      /<PageTitle title=\{intl\.formatMessage\(messages\.title\)\} \/>/
    );
    assert.doesNotMatch(component, /messages\.description/);
    assert.doesNotMatch(component, /<h1/);
    assert.match(
      component,
      /<section data-testid="storage-physical-volumes-section">/
    );
    assert.doesNotMatch(
      component,
      /className="border-t border-gray-700 pt-6"[\s\S]*?storage-physical-volumes-section/
    );
    assert.match(
      component,
      /<Tooltip content=\{intl\.formatMessage\(messages\.refresh\)\}>[\s\S]*?aria-label=\{intl\.formatMessage\(messages\.refresh\)\}/
    );
    assert.match(component, /aria-busy=\{refreshPending\}/);
    assert.match(component, /disabled=\{refreshPending\}/);
    assert.match(component, /onClick=\{\(\) => void refreshCapacity\(\)\}/);
    assert.match(component, /classifyStorageRefresh\(refreshed\.instances\)/);
    assert.match(component, /appearance: 'success'/);
    assert.match(component, /appearance: 'warning'/);
    assert.match(component, /appearance: 'error'/);
    assert.match(component, /dateTime=\{refreshedAt\}/);
    assert.match(
      component,
      /messages\.locations\)[\s\S]*?dateTime=\{refreshedAt\}[\s\S]*?overflow-free-space-threshold/
    );
    assert.match(
      component,
      /className="flex flex-col items-end"[\s\S]*?className="mb-1 block text-right[\s\S]*?data-testid="overflow-free-space-threshold"[\s\S]*?className="w-\[90px\] flex-none"/
    );
    assert.match(component, /h-5 w-5/);
    assert.doesNotMatch(component, /mr-2 h-4 w-4.*animate-spin/);
  });

  it('renders configuration separately from responsive Automation controls', () => {
    const overflowSection = component.indexOf(
      'data-testid="storage-overflow-routing-section"'
    );
    const routesDescription = component.indexOf(
      '{intl.formatMessage(messages.routesDescription)}',
      overflowSection
    );
    const series = component.indexOf(
      'data-testid="storage-series-routing-section"'
    );
    const automation = component.indexOf(
      'data-testid="storage-automation-section"'
    );
    const actions = component.indexOf('<div className="actions">', automation);
    const overflowMarkup = component.slice(overflowSection, series);
    const seriesMarkup = component.slice(series, automation);
    const automationMarkup = component.slice(automation, actions);

    assert.ok(overflowSection >= 0);
    assert.ok(routesDescription > overflowSection);
    assert.ok(series > routesDescription);
    assert.ok(automation > series);
    assert.match(component, /storageRouting: 'Storage Routing'/);
    assert.match(
      overflowMarkup,
      /<h2 className="text-xl font-bold">[\s\S]*?messages\.storageRouting/
    );
    assert.doesNotMatch(overflowMarkup, /checked=\{values\.enabled\}/);
    assert.match(component, /overflowRouting: 'Overflow Routing'/);
    assert.doesNotMatch(component, /overflowSettings: 'Overflow settings'/);
    assert.match(
      automationMarkup,
      /checked=\{values\.enabled\}[\s\S]*?ariaLabel=\{intl\.formatMessage\(messages\.overflowRouting\)\}/
    );
    assert.match(
      automationMarkup,
      /checked=\{values\.automaticSeriesPlacement\}[\s\S]*?ariaLabel=\{intl\.formatMessage\([\s\S]*?messages\.automaticSeriesPlacement/
    );
    assert.doesNotMatch(component, /overflowSettingsDescription/);
    assert.doesNotMatch(
      component,
      /Configure Overflow evaluation and physical-volume destination routes\./
    );
    assert.doesNotMatch(component, /routes: 'Routes'/);
    assert.match(component, /destination: 'Target volume'/);
    assert.match(component, /chooseDestination: 'Choose a target'/);
    assert.match(component, /routeThreshold: 'Threshold \(GB\)'/);
    assert.match(
      component,
      /Choose where media should be stored based on remaining volume capacity\./
    );
    assert.doesNotMatch(component, /routeThreshold: 'Overflow threshold'/);
    assert.doesNotMatch(component, /Choose a destination/);
    assert.doesNotMatch(component, /rounded-r-none/);
    assert.doesNotMatch(component, />\s*GB\s*<\/span>/);
    assert.match(
      overflowMarkup,
      /className="storage-routing-container mt-5 rounded-lg bg-gray-800 p-5/
    );
    assert.equal(
      (overflowMarkup.match(/className="storage-route-grid /g) ?? []).length,
      2
    );
    assert.match(
      overflowMarkup,
      /data-testid="storage-add-route"[\s\S]*?overflow-source[\s\S]*?storage-route-arrow[\s\S]*?overflow-destination[\s\S]*?overflow-route-threshold[\s\S]*?className="storage-route-actions h-10 justify-self-start/
    );
    assert.match(
      overflowMarkup,
      /id="overflow-source"[\s\S]*?className="h-10 w-full"/
    );
    assert.match(
      overflowMarkup,
      /id="overflow-destination"[\s\S]*?className="h-10 w-full"/
    );
    assert.match(
      overflowMarkup,
      /data-testid="overflow-route-threshold"[\s\S]*?className="storage-route-threshold-control h-10 w-full"/
    );
    assert.match(
      overflowMarkup,
      /className="storage-route-threshold storage-route-threshold-control h-10 w-full"[\s\S]*?value=\{route\.thresholdGb\}/
    );
    assert.match(
      overflowMarkup,
      /data-testid="storage-saved-route"[\s\S]*?\{sourceName\}[\s\S]*?storage-route-arrow-icon h-4 w-4 text-gray-400[\s\S]*?\{destinationName\}[\s\S]*?value=\{route\.thresholdGb\}[\s\S]*?checked=\{route\.enabled\}[\s\S]*?buttonType="danger"/
    );
    assert.doesNotMatch(overflowMarkup, /hidden md:block/);
    assert.match(
      overflowMarkup,
      /storage-route-actions flex h-10 items-center gap-3 justify-self-start[\s\S]*?<SlideCheckbox[\s\S]*?<Button/
    );
    assert.doesNotMatch(overflowMarkup, /(?:md|xl):grid-cols/);
    assert.match(
      globalStyles,
      /@container \(min-width: 280px\)[\s\S]*?max-width: 24\.75rem[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 20px minmax\(0, 1fr\)[\s\S]*?\.storage-route-threshold[\s\S]*?grid-row: 2/
    );
    assert.match(
      globalStyles,
      /\.storage-route-source,[\s\S]*?\.storage-route-target[\s\S]*?min-width: 0[\s\S]*?\.storage-route-source select,[\s\S]*?text-overflow: ellipsis/
    );
    assert.match(
      globalStyles,
      /@container \(min-width: 700px\)[\s\S]*?grid-template-columns: 180px 20px 180px 110px auto[\s\S]*?\.storage-route-actions[\s\S]*?grid-column: 5/
    );
    assert.doesNotMatch(overflowMarkup, /grid-rows-subgrid|text-label/);
    assert.doesNotMatch(component, /messages\.routes\)/);
    assert.doesNotMatch(
      component,
      /grid grid-cols-1 gap-5 rounded-md bg-gray-900\/30 p-4/
    );
    assert.match(
      component,
      /data-testid="overflow-route-threshold"[\s\S]*?disabled=\{!sourceVolume\}/
    );
    assert.match(component, /sourceVolume && destinations\.length === 0/);
    assert.match(
      component,
      /const overflowRoutingActivationValid =\s*values !== null && isOverflowRoutingActivationValid\(values\)/
    );
    assert.match(
      component,
      /overflowRouteRequired:\s*'Configure at least one enabled storage route before enabling Overflow Routing\.'/
    );
    assert.match(
      overflowMarkup,
      /!overflowRoutingActivationValid[\s\S]*?data-testid="overflow-route-required-error"[\s\S]*?role="alert"[\s\S]*?messages\.overflowRouteRequired/
    );
    assert.equal(
      (component.match(/!overflowRoutingActivationValid/g) ?? []).length,
      3,
      'the activation invariant guards the message, save handler, and Save button'
    );
    assert.doesNotMatch(
      component,
      /flex flex-col gap-5 rounded-lg bg-gray-800 p-4 ring-1 ring-gray-700/
    );
    assert.doesNotMatch(overflowMarkup, /buttonSize="sm"/);
    assert.doesNotMatch(component, /className="short"/);
    assert.match(component, /seriesRouting: 'Series Routing'/);
    assert.match(
      component,
      /Choose where new Series are stored and when existing Series should be relocated\./
    );
    assert.match(
      component,
      /setAutomaticSeriesPlacementEnabled\([\s\S]*?!current\.automaticSeriesPlacement/
    );
    assert.match(component, /defaultSeriesVolume: 'Default volume'/);
    assert.match(component, /expansionSeriesVolume: 'Expansion volume'/);
    assert.match(component, /torrentRelocationDelay: 'Relocation delay \(h\)'/);
    assert.doesNotMatch(component, /Torrent relocation delay \(hours\)/);
    assert.match(
      seriesMarkup,
      /grid grid-cols-1 gap-5 md:grid-cols-\[180px_180px\] md:justify-start md:gap-x-5 md:gap-y-5 xl:grid-cols-\[180px_180px_125px_150px\]/
    );
    assert.match(
      seriesMarkup,
      /defaultSeriesVolumeId[\s\S]*?expansionSeriesVolumeId[\s\S]*?htmlFor="seriesSeasonThreshold"[\s\S]*?htmlFor="torrentRelocationDelayHours"/
    );
    assert.doesNotMatch(seriesMarkup, /<SlideCheckbox/);
    assert.match(seriesMarkup, /className="h-10 md:w-\[180px\]"/);
    assert.match(seriesMarkup, /className="h-10 md:w-\[110px\]"/);
    assert.match(seriesMarkup, /className="h-10 md:w-\[140px\]"/);
    assert.match(component, /automation: 'Automation'/);
    assert.match(
      automationMarkup,
      /automation-overflow-routing-row[\s\S]*?messages\.overflowRouting[\s\S]*?messages\.overflowRoutingDescription[\s\S]*?checked=\{values\.enabled\}[\s\S]*?automation-automatic-series-placement-row[\s\S]*?messages\.automaticSeriesPlacement[\s\S]*?messages\.automaticSeriesPlacementDescription[\s\S]*?checked=\{values\.automaticSeriesPlacement\}[\s\S]*?automation-series-relocation-row[\s\S]*?messages\.seriesRelocation[\s\S]*?messages\.seriesRelocationDescription[\s\S]*?checked=\{seriesRelocationJob\?\.enabled \?\? false\}/
    );
    assert.equal(
      (
        automationMarkup.match(
          /className="flex min-h-12 items-center justify-between gap-4"/g
        ) ?? []
      ).length,
      3
    );
    assert.equal((automationMarkup.match(/<SlideCheckbox/g) ?? []).length, 3);
    assert.match(
      automationMarkup,
      /automation-series-relocation-row[\s\S]*?checked=\{seriesRelocationJob\?\.enabled \?\? false\}[\s\S]*?series-relocation-next-candidate/
    );
    assert.match(
      component,
      /axios\.get<SeriesRelocationPreviewResult>\(\s*'\/api\/v1\/settings\/storage\/series-relocation\/next-candidate'/
    );
    assert.match(
      automationMarkup,
      /messages\.nextCandidate[\s\S]*?aria-busy=\{refreshingSeriesRelocationPreview\}[\s\S]*?seriesRelocationPreviewStale[\s\S]*?refreshSeriesRelocationPreview/
    );
    for (const expected of [
      'seriesRelocationPreviewStale',
      'messages.candidateStale',
      'messages.candidateLoading',
      'messages.candidateUnavailable',
      'messages.candidateNone',
      'seriesRelocationPreview.candidate.title',
      'seriesRelocationPreview.candidate.sonarrUrl',
      '.retainedSeasonCount',
      'seriesRelocationPreview.candidate.totalBytes',
      'messages.candidateIdle',
    ]) {
      assert.ok(automationMarkup.includes(expected), expected);
    }
    assert.doesNotMatch(component, /useSWR<SeriesRelocationPreviewResult>/);
    assert.match(
      automationMarkup,
      /candidate\.sonarrUrl[\s\S]*?href=\{seriesRelocationPreview\.candidate\.sonarrUrl\}[\s\S]*?target="_blank"[\s\S]*?rel="noopener noreferrer"[\s\S]*?: \([\s\S]*?<p className="font-medium text-white">/
    );
    assert.doesNotMatch(
      automationMarkup,
      /rounded-lg bg-gray-800|ring-1 ring-gray-700/
    );
    assert.doesNotMatch(seriesMarkup, /text-label/);
    assert.match(
      component,
      /checked=\{values\.automaticSeriesPlacement\}[\s\S]*?setAutomaticSeriesPlacementEnabled\([\s\S]*?!current\.automaticSeriesPlacement/
    );
    assert.match(
      component,
      /checked=\{seriesRelocationJob\?\.enabled \?\? false\}[\s\S]*?setSeriesRelocationEnabled\([\s\S]*?!\(seriesRelocationJob\?\.enabled \?\? false\)/
    );
    assert.doesNotMatch(component, /values\.automaticSeriesPlacement && \(/);
    assert.match(
      component,
      /seriesRelocationConfigurationChanged\(values, savedValues\)/
    );
    assert.match(
      component,
      /JSON\.stringify\(current\) !== JSON\.stringify\(values\)[\s\S]*?\? current[\s\S]*?: response\.data/
    );
    assert.doesNotMatch(component, /configurationOnly/);
    assert.doesNotMatch(component, /No Overflow routes are configured/);
    assert.doesNotMatch(component, /Requests remain on this source volume/);
  });
});
