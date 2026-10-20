import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
const globalStyles = readFileSync(
  path.join(__dirname, '../../styles/globals.css'),
  'utf8'
);
const titleCardSource = readFileSync(
  path.join(__dirname, '../TitleCard/index.tsx'),
  'utf8'
);
const cancelButtonSource = readFileSync(
  path.join(__dirname, '../Common/CancelScheduledRemovalButton.tsx'),
  'utf8'
);
const libraryItemSource = readFileSync(
  path.join(__dirname, '../Library/LibraryItem.tsx'),
  'utf8'
);
const seriesDetailSource = readFileSync(
  path.join(__dirname, '../Library/SeriesDetail.tsx'),
  'utf8'
);
const navigation = readFileSync(
  path.join(__dirname, '../Layout/navigationConfig.ts'),
  'utf8'
);
const navigationPresentation = readFileSync(
  path.join(__dirname, '../Layout/navigation.tsx'),
  'utf8'
);

describe('Leaving Soon presentation', () => {
  it('loads only the user-safe scheduled-removal projection', () => {
    assert.match(source, /\/api\/v1\/leaving-soon\?page=/);
    assert.match(source, /item\.schedules\.map/);
    assert.doesNotMatch(source, /failureMessage|sourceScope|leaseToken/);
  });

  it('reuses bounded Library presentation polling and revalidates once after settlement', () => {
    assert.match(source, /data\?\.presentation\?\.state !== 'pending'/);
    assert.match(source, /data\?\.presentation\?\.batchId/);
    assert.match(
      source,
      /\/api\/v1\/leaving-soon\/presentation-status\/\$\{batchId\}/
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
    assert.match(source, /Missing, expired, or transiently unavailable/);
  });

  it('does not introduce per-card metadata hydration or replace TitleCard loading', () => {
    assert.doesNotMatch(source, /\/api\/v1\/(?:movie|tv)\//);
    assert.doesNotMatch(source, /getMovie|getTvShow|<CachedImage/);
    assert.match(source, /image=\{item\.posterPath \?\? undefined\}/);
  });

  it('groups Season countdowns under their canonical Series card', () => {
    assert.match(source, /item\.canonicalMediaId/);
    assert.match(source, /schedule\.targetType === 'season'/);
    assert.match(source, /schedule\.seasonNumber/);
  });

  it('reuses the compact responsive Seerr media grid and standard TitleCard', () => {
    assert.match(source, /<ul className="cards-vertical">/);
    assert.match(source, /className="leaving-soon-card"/);
    assert.match(source, /key=\{item\.canonicalMediaId\}/);
    assert.doesNotMatch(source, /(?:sm|md|lg|xl):grid-cols-/);
    assert.match(
      globalStyles,
      /ul\.cards-vertical[\s\S]*repeat\(auto-fill, minmax\(9\.375rem, 1fr\)\)/
    );
    assert.match(source, /import TitleCard from '@app\/components\/TitleCard'/);
    assert.match(source, /<TitleCard[\s\S]*canExpand/);
    assert.doesNotMatch(source, /<article|<CachedImage/);
    assert.match(titleCardSource, /paddingBottom: '150%'/);
    assert.match(titleCardSource, /data-testid="title-card-title"/);
  });

  it('keeps Leaving Soon dates persistent on the standard card overlay', () => {
    assert.match(source, /persistentMetadata=\{/);
    assert.match(source, /intl\.formatMessage\(messages\.leaves/);
    assert.match(
      titleCardSource,
      /data-testid="title-card-persistent-metadata"/
    );
    assert.match(
      titleCardSource,
      /col-span-2 col-start-1 row-start-3 mb-1 max-w-full self-end justify-self-center break-words/
    );
    assert.match(
      titleCardSource,
      /aria-hidden="true"[\s\S]*invisible mb-1 mt-2 max-w-full justify-self-center break-words/
    );
    assert.match(source, /navigationHref=\{navigationHref\}/);
    assert.match(
      source,
      /mediaType=\{item\.mediaType === 'movie' \? 'movie' : 'tv'\}/
    );
    assert.match(source, /actionsDisabled/);
  });

  it('offers administrators the shared exact-schedule cancellation action', () => {
    assert.match(source, /hasPermission\(Permission\.ADMIN\)/);
    assert.match(source, /cornerAction=\{/);
    assert.match(source, /<CancelScheduledRemovalButton/);
    assert.match(
      source,
      /\/api\/v1\/library\/removal-schedules\/\$\{selectedSchedule\.id\}/
    );
    assert.match(source, /await mutate\(\)/);
    assert.match(source, /event\.preventDefault\(\)/);
    assert.match(source, /event\.stopPropagation\(\)/);
    assert.match(
      source,
      /onKeyDown=\{\(event\) => event\.stopPropagation\(\)\}/
    );
    assert.match(source, /okButtonType="danger"/);
    assert.match(source, /okDisabled=\{!selectedSchedule \|\| cancelling\}/);
    assert.match(source, /role="radiogroup"/);
    assert.match(source, /type="radio"/);
  });

  it('clamps an invalid page only after authoritative cancellation refresh', () => {
    assert.match(source, /const refreshed = await mutate\(\)/);
    assert.match(source, /invalidLeavingSoonPage\(/);
    assert.match(source, /page,[\s\S]*refreshed\.pageInfo\.pages/);
    assert.match(
      source,
      /router\.replace\(\{[\s\S]*query: \{ \.\.\.router\.query, page: validPage \}/
    );
    assert.match(source, /cancellationCompleted/);
    assert.match(source, /messages\.cancelRefreshError/);
  });

  it('reuses the same blue calendar control as Library items and Seasons', () => {
    assert.match(
      cancelButtonSource,
      /h-7 w-7 border-transparent bg-blue-900\/50/
    );
    assert.match(cancelButtonSource, /<CalendarIcon className="h-4 w-4"/);
    assert.match(
      cancelButtonSource,
      /hover:bg-blue-800\/80 focus:bg-blue-800\/80/
    );
    assert.match(source, /preserveColorsOnInteraction/);
    assert.match(
      cancelButtonSource,
      /preserveColorsOnInteraction[\s\S]*bg-blue-800\/80 text-white[\s\S]*hover:bg-blue-800\/80 hover:text-white/
    );
    assert.match(cancelButtonSource, /focus:bg-blue-800\/80/);
    assert.match(cancelButtonSource, /group-hover:bg-blue-800\/80/);
    assert.match(cancelButtonSource, /group-hover:text-white/);
    assert.match(libraryItemSource, /<CancelScheduledRemovalButton/);
    assert.match(seriesDetailSource, /<CancelScheduledRemovalButton/);
    assert.match(titleCardSource, /cornerAction\?: React\.ReactNode/);
    assert.match(titleCardSource, /id: 'custom-corner-action'/);
  });

  it('reveals cancellation on hover or focus without making hidden actions clickable', () => {
    assert.match(
      globalStyles,
      /\.leaving-soon-cancel-action\s*\{[\s\S]*transition: opacity 150ms/
    );
    assert.match(
      globalStyles,
      /@media \(hover: hover\) and \(pointer: fine\)[\s\S]*pointer-events: none;[\s\S]*opacity: 0;/
    );
    assert.match(
      globalStyles,
      /\.leaving-soon-card:hover \.leaving-soon-cancel-action,[\s\S]*\.leaving-soon-card:focus-within \.leaving-soon-cancel-action[\s\S]*pointer-events: auto;[\s\S]*opacity: 1;/
    );
    assert.match(
      globalStyles,
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*transition: none;/
    );
  });

  it('is ordinary navigation without an administrator permission gate', () => {
    const entry = navigation.match(
      /\{\s*id: 'leaving-soon',[\s\S]*?href: '\/leaving-soon',[\s\S]*?\}/
    )?.[0];
    assert.ok(entry);
    assert.doesNotMatch(entry, /requiredPermission/);
  });

  it('uses the leaving-soon icon without changing the request clock icon', () => {
    const routeEntry = navigation.match(
      /\{\s*id: 'leaving-soon',[\s\S]*?href: '\/leaving-soon',[\s\S]*?\}/
    )?.[0];
    const iconEntry = navigationPresentation.match(
      /'leaving-soon': \{[\s\S]*?\}/
    )?.[0];

    assert.ok(routeEntry);
    assert.ok(iconEntry);
    assert.match(iconEntry, /ArrowRightStartOnRectangleIcon/);
    assert.match(iconEntry, /FilledArrowRightStartOnRectangleIcon/);
    assert.doesNotMatch(iconEntry, /ClockIcon/);
    assert.match(navigationPresentation, /requests: \{[\s\S]*?icon: ClockIcon/);
  });
});
