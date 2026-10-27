import { MediaType } from '@server/constants/media';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
// Client unit tests execute under the server test tsconfig, which has no @app alias.
// eslint-disable-next-line no-relative-import-paths/no-relative-import-paths
import {
  createDetailsWatchlistTarget,
  DetailsWatchlistMutationTracker,
  updateDetailsWatchlistMembership,
} from '../../hooks/useDetailsWatchlist';
import { resolveTitleCardRequestActionLabel } from './requestActionLabel';

describe('TitleCard interaction contracts', () => {
  const source = readFileSync(path.join(__dirname, 'index.tsx'), 'utf8');
  const requestIconButton = readFileSync(
    path.join(__dirname, '../Common/RequestIconButton.tsx'),
    'utf8'
  );
  it('uses one native navigation link instead of a link-like wrapper', () => {
    assert.match(source, /<Link\s+href=\{cardHref\}/);
    assert.match(
      source,
      /aria-label=\{intl\.formatMessage\(messages\.viewTitle/
    );
    assert.match(source, /onFocusCapture=\{\(\) => setShowDetail\(true\)\}/);
    assert.match(source, /onBlurCapture=/);
    assert.doesNotMatch(source, /role=\{cardHref \? 'link'/);
    assert.doesNotMatch(source, /tabIndex=\{cardHref \? 0/);
    assert.doesNotMatch(source, /onKeyDown=\{/);
    assert.equal((source.match(/<Link\b/g) ?? []).length, 1);
  });

  it('preserves the two-step touch reveal while Enter uses native navigation', () => {
    assert.match(source, /onPointerDown=/);
    assert.match(source, /onTouchStart=/);
    assert.match(source, /beginCardPointerGesture\(/);
    assert.match(source, /beginCardTouchFallbackGesture\(/);
    assert.match(source, /consumeCardNavigationClick\(/);
    assert.match(source, /navigationGestureRef\.current\.suppressClick/);
    assert.match(source, /isKeyboardActivation: event\.detail === 0/);
    assert.match(source, /event\.preventDefault\(\)/);
    assert.match(source, /setShowDetail\(true\)/);
    assert.match(source, /focus-visible:ring-indigo-400/);
  });

  it('keeps the Request action outside card navigation and opens the shared modal', () => {
    const requestButtonStart = source.indexOf('<RequestIconButton');
    const requestHandler = source.slice(
      requestButtonStart,
      source.indexOf('</Tooltip>', requestButtonStart)
    );
    assert.match(requestHandler, /e\.preventDefault\(\)/);
    assert.match(requestHandler, /e\.stopPropagation\(\)/);
    assert.match(requestHandler, /setShowRequestModal\(true\)/);
    assert.match(source, /requestActionEnabled \?\?/);
    assert.match(source, /!actionsDisabled/);
    assert.match(source, /type=\{[\s\S]*?mediaType === 'collection'/);
    assert.equal(
      resolveTitleCardRequestActionLabel(undefined, 'Request'),
      'Request'
    );
    assert.equal(resolveTitleCardRequestActionLabel('View', 'Request'), 'View');
    assert.match(source, /resolveTitleCardRequestActionLabel\(/);
    assert.match(
      source,
      /useLowerRightStatus\s*\? lowerRightStatusIcon\s*: requestActionIcon/
    );
    assert.match(source, /requestActionClassName \?\? ''/);
    assert.match(
      requestIconButton,
      /icon \?\? <ArrowDownTrayIcon className="h-4 w-4"/
    );
  });

  it('changes Watchlist state only after confirmed successful mutations', () => {
    const addHandler = source.slice(
      source.indexOf('const onClickWatchlistBtn'),
      source.indexOf('const onClickDeleteWatchlistBtn')
    );
    const deleteHandler = source.slice(
      source.indexOf('const onClickDeleteWatchlistBtn'),
      source.indexOf('const onClickHideItemBtn')
    );
    assert.match(source, /if \(watchlistMutationRef\.current\) return/);
    assert.match(source, /confirmedWatchlistStateRef\.current = true/);
    assert.match(source, /confirmedWatchlistStateRef\.current = false/);
    assert.match(source, /setToggleWatchlist\(false\)/);
    assert.match(source, /setToggleWatchlist\(true\)/);
    assert.match(addHandler, /mutateParent\?\.\(\)/);
    assert.match(deleteHandler, /mutateParent\?\.\(\)/);
    assert.doesNotMatch(addHandler, /finally \{[\s\S]*?setToggleWatchlist/);
    assert.doesNotMatch(deleteHandler, /finally \{[\s\S]*?setToggleWatchlist/);
    assert.match(source, /disabled=\{isUpdating\}/);
  });

  it('applies confirmed Movie and Series detail mutations to their exact identities', () => {
    for (const mediaType of [MediaType.MOVIE, MediaType.TV] as const) {
      const target = createDetailsWatchlistTarget({
        mediaType,
        title: mediaType === MediaType.MOVIE ? 'Movie' : 'Series',
        tmdbId: 42,
        userId: 7,
      });
      assert.ok(target);

      const tracker = new DetailsWatchlistMutationTracker();
      tracker.setCurrentIdentity(target.identity);
      let details = { id: target.tmdbId, onUserWatchlist: false };

      const addToken = tracker.begin(target.identity);
      assert.ok(addToken);
      assert.equal(details.onUserWatchlist, false);
      assert.equal(tracker.isCurrent(target.identity, addToken), true);
      details =
        updateDetailsWatchlistMembership(details, target, true) ?? details;
      assert.equal(details.onUserWatchlist, true);
      assert.equal(tracker.finish(target.identity, addToken), true);

      const removeToken = tracker.begin(target.identity);
      assert.ok(removeToken);
      assert.equal(details.onUserWatchlist, true);
      assert.equal(tracker.isCurrent(target.identity, removeToken), true);
      details =
        updateDetailsWatchlistMembership(details, target, false) ?? details;
      assert.equal(details.onUserWatchlist, false);
      assert.equal(tracker.finish(target.identity, removeToken), true);

      const failedToken = tracker.begin(target.identity);
      assert.ok(failedToken);
      assert.equal(details.onUserWatchlist, false);
      assert.equal(tracker.finish(target.identity, failedToken), true);
      assert.equal(details.onUserWatchlist, false);
    }
  });
});
