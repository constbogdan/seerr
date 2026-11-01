# Jellyfin Like/Dislike persistence V1

This is an uninstalled review candidate for Jellyfin Web 10.10.7 and JavaScript
Injector 3.5.0.0. Jellyfin remains the source of truth. No Seerr credentials,
cross-origin calls, new scheduler, background polling or automatic provider
mutations are introduced.

## Actions and reversal

The maintained candidate is `public/integrations/jellyfin-user-likes.js`. It
extends the inspected installed Native User Likes controls, retaining their
placement, icons, colors and selected-rating toggle. Movie actions target that
Movie. Episode/Season actions read the authoritative `SeriesId`, validate the
returned Series and target it; Series actions target the Series directly.
Episode/Season controls are explicitly labelled Like Series / Dislike Series.

| Action                 | Jellyfin operations, in order                |
| ---------------------- | -------------------------------------------- |
| Like                   | Set `Likes=true`; never change Played        |
| Selected Like again    | Clear rating to Neutral; never change Played |
| Dislike                | Set `Likes=false`, then native mark-played   |
| Selected Dislike again | Clear rating, then native mark-unplayed      |
| Dislike to Like        | Set `Likes=true`; **leave Played unchanged** |

Jellyfin performs its normal Series cascade; the script never enumerates child
Episodes. No date is supplied to mark-played. Single-user sessions are verified
using the current client's device/user session and `AdditionalUsers`; additional,
ambiguous or unverifiable sessions are rejected. Context is checked before and
after asynchronous work. Unknown parents, mismatched IDs and unsupported types
fail closed. Requests are user-triggered, with duplicate submissions disabled.

The two writes are not atomic. A failed watched-state step retains the saved
rating and reports partial success. Clicking again in that mounted context
retries only the failed step if the current rating still matches it. There is no
automatic retry or rollback. Reload, account/server changes, disposal or cache
eviction lose that temporary retry state; inspect the native watched state before
using another toggle.

Native user-data notifications update Jellyfin's own controls and the shared
card/detail preference state. Browser acceptance of feed/parent refreshes is
still required. Other-device changes are reread on activation, not continuously
polled. New Episodes receive no special handling.

## Standard Movie/Series card candidate

The same maintained script now includes uninstalled card controls for the
inspected Jellyfin Web 10.10.7 standard markup: Library grids, Home media rows,
Search, and Movie-only Continue Watching. Actual `data-type` must be Movie or
Series and the server must match. Two inspected `.cardScalable` structures are
accepted: the legacy direct image anchor (recommendations/Home/Search), and the
primary-grid image `div.cardContent > .cardImageContainer` with a separate
`.cardOverlayContainer > a.cardImageContainer`. The latter anchor must reference
the exact card item and server. This covers the supplied Movie grid structure
and its matching Series variant; it is not blanket support for arbitrary React
markup. Episodes, Seasons, Next Up, TV button cards and unrecognized structures
remain excluded. Detail-page Episode/Season support is unchanged.

Controls are direct `.cardScalable` children, outside navigation anchors, at the
bottom-left. A confirmed Like shows one blue thumb; Dislike shows one red thumb.
Confirmed Neutral shows neither at rest. Hover or keyboard focus exposes both;
touch provides a labelled ellipsis reveal button. Unknown/loading instead shows
the ellipsis with a loading/unavailable label and disabled rating controls. Both
actions retain native buttons, labels and pressed states. Selected icons toggle
directly; controls stop card navigation without changing the card's own handler.
Controls mirror the native action group's inset/bottom and the native button's
layout hit-target width/height, with relative-unit fallbacks. Visible thumbs are
80% of the native glyph size (for example 19.2px from a 24px native glyph), while
the click/touch targets retain their native dimensions. At rest the selected
blue/red thumb has a fully transparent background and subtle dark/light text
shadows for poster contrast; Neutral still shows no persistent thumb.
Footer/progress
height is reserved. Narrow cards stack the controls vertically first, raising
them above native actions only if even one button cannot fit beside those actions.
There is no fixed 30px size or 80px poster threshold. Measurements use unscaled
offset/client dimensions, not transformed screen rectangles. ResizeObserver
updates clearance when poster, footer or native controls resize. Real JellyTweaks
and Jellyfin Enhanced overlay compatibility still requires visual acceptance.

The selected hover/focus layout remains the bottom-left fallback, not insertion
into the native row: the primary-grid row is React/MUI-owned inside a fading
overlay, while legacy markup and ownership differ. Adding two actions also
crowds the existing three native controls on narrow posters. Avoiding reparenting
preserves persistent visibility, native events and the accepted cleanup path.
Both thumbs reveal on hover/focus or touch expansion. Card and item-detail
buttons remain fully background-free in every state. Unselected icons use native
Jellyfin light gray; Like turns blue and Dislike red on hover/focus or selection.
The existing hit targets and a regular `:focus` outline remain accessible in
Chromium 83. No JavaScript outside
the style block, API/state logic, cache, batching or supported card types changes
for this visual refinement.

The original grid omission was the direct-anchor-only selector, not a failed API
read or IntersectionObserver gate. Existing candidates are scanned once at
startup/account change; subsequent discovery uses added/changed mutation subtrees,
including in-place card identities and overlay href changes. Navigation/sorting
does not repeatedly scan the whole document. Duplicate and removed-node cleanup,
shared state, read limits and all detail actions retain their existing behavior.

A user/server/API-client-bound shared cache holds at most 512 entries. Visible
cards subscribe; offscreen/removed cards release subscriptions. Unused entries
are evicted first; if all slots are pinned, additional items remain Unknown until
capacity becomes available and they are activated again. Duplicate titles share
reads, writes, state and explicit partial-failure retries. A fresh cache entry is
reused for 60 seconds; expired entries are read only on activation. There is no
periodic refresh. Unresolved visible IDs use batches of at most 50 with at most
two reads in flight, including outstanding reads from a previous account/server
context. Failed reads require reactivation or explicit reveal/retry; hung reads
retain their slot rather than starting replacement requests.

Read revisions fence earlier batch/detail/parent reads against later writes and
notifications. Notifications arriving during a write cause one bounded read
afterward, not replay of ambiguously ordered event data. Account/server changes
invalidate the context. No tokens, browser storage, additional WebSocket or
Seerr API are used. The existing `createActions()` rating/watched algorithm is
unchanged; an optional expected-target guard rejects a changed detail-page
Episode/Season parent before writes. Parent identity is still revalidated on
every action. Only explicit button activation can rate or mark played/unplayed.

### JMP compatibility and controller isolation

The local JMP installation inspected for the V2 regression bundles Qt WebEngine
5.15.2 / Chromium 83.0.4103.122. V2 introduced logical assignment (`||=`), which
arrived in Chrome 85 and prevents that older engine from parsing the entire
script. This happens before API/session detection, observer construction, event
registration or either UI controller can run; it is not an authentication or
script-delivery diagnosis. V1 uses no logical-assignment syntax.

The subscription now uses an ordinary conditional assignment. An executable
ES2020 parse check covers the entire shipped source, with the unsupported
operator as a negative control. The 60-second TTL is unchanged (`60000`).
Both card observer APIs are feature-detected and their construction/callbacks
guarded. Missing or failing card APIs disable only cards, disconnect their
observers, release card subscriptions and preserve details/shared state.
Details initialize before card discovery. Optional native notification-hook
failures cannot abort initialization or cleanup. If extended mutation options
are rejected, the observer falls back to V1's child-list/subtree options.
There is no polling fallback, automatic provider action, client-specific branch
or change to the rating/watched algorithm or batch/cache limits.

The local automated checks use an older-language parser, isolated failure
fixtures and offline current Chromium, not an authenticated JMP session. After
approval for temporary evaluation, unload the previous candidate in the test
tab, evaluate this source without saving Injector configuration, and verify
Movie/Series details, SPA navigation, card selection and cleanup in JMP and
Chrome. Only use approved disposable titles when checking watched consequences.
Reload restores the installed script, not altered ratings or watched state.
The user confirmed the preceding functional correction works in browser and JMP.
The background-free/smaller-icon refinement still needs manual visual review;
the running application and its profile/configuration have not been modified.

### Manual acceptance (pending; no installation authorized)

1. On an explicitly approved disposable/single-user test session, save the
   existing Injector entry privately. For a temporary evaluation only, dispose
   the installed candidate with `window.__jellyfinLikesInstalled.dispose()` and
   evaluate the reviewed source in that tab. Do not save an Injector change.
   Reload restores the installed script, **not** any changed ratings/play state.
2. Inspect Library, Home, Search and Movie Continue Watching: blue/red selected
   thumb at rest, no Neutral thumb, both actions on hover/Tab, touch ellipsis;
   no controls on Episodes/Seasons/Next Up. Check progress, ratings, watched badge,
   native actions and both installed overlay extensions at narrow/desktop sizes.
   In primary Movies and Series, resize card density/window, then change sorting
   and navigate away/back. Check bottom-left anchoring, native-sized hit targets,
   and no duplicate controls on the replaced/recycled cards.
3. Only on approved test titles, test Like, toggle-off, Dislike, toggle-off, and
   Dislike-to-Like. Check duplicate cards and details, no navigation on activation,
   and the V1 watched consequences above (Series operations cascade natively).
4. Simulate a read failure and a failed watched step in an isolated provider
   fixture: Unknown is not Neutral; a saved rating is retained; explicit retry
   does not reverse it. Check SPA replacement, scrolling, account/server switching
   and disposal. Do not export browser storage, credentials or raw network traces.

Focused DOM/provider tests cover both structures, exact source identities and
subtree discovery. Optional `pnpm test server/test/jellyfinUserLikesCards.browser.ts`
uses a fresh, offline headless Chromium file fixture (no debugging connection).
It checks rendered geometry at 120/180/320px, transformed posters, focus/reveal,
states, replacements and native-action clearance. Observer delivery is
deterministic in this fixture because headless dump-DOM virtual time does not
drive compositor animation frames; DOM/CSS and MutationObserver are real.
Authenticated-server and full extension/theme acceptance remain pending before
an installation recommendation. No installed script/configuration is modified.

## Deliberately unchanged downstream semantics

V1 is **not Hidden classification**. Dislike's native mark-played may cause
existing Seerr synchronization to show Watched, advance viewing metrics/Last
Active, create its ordinary inferred completion evidence, and affect existing
automation. That downstream behavior is not reinterpreted or suppressed here.

Neutral reversal is intentionally simple, not restoration: Jellyfin's native
mark-unplayed resets current play counts, dates and positions, cascading across
the Series. It does not restore the state before Dislike. Existing durable Seerr
historical evidence is not deleted. Dislike to Like does not undo mark-played.
These side effects need explicit user acceptance before installing the candidate.

Session checks cannot atomically prevent another user being attached between a
read and Jellyfin's native operation. Do not use this candidate in shared/co-watch
sessions. No server permission or authentication behavior is weakened.

## Persistence and synchronization

The additive SQLite/PostgreSQL migration extends `user_media_state`, retaining
its existing unique `(userId, mediaType, tmdbId)` identity. No new table is added:

- `jellyfinLikes`: nullable boolean (true = Like, false = Dislike, null = Neutral).
- `jellyfinPreferenceObservedAt`: null means no successful observation, not Neutral.
- Source server, linked Jellyfin user and exact source-item IDs bind the observation.
- `jellyfinPlayStateTracked`: defaults true for all existing rows. New
  preference-only rows are false so they cannot expand existing watched-state
  synchronization. Explicit Watchlist membership enrolls them normally.

`logicalJellyfinPreference()` exposes the two reusable backend logical fields:
Like is `{liked:true, disliked:false}`, Dislike is `{liked:false, disliked:true}`,
Neutral is `{liked:false, disliked:false}`. Unknown or mismatched source/user
bindings produce `{liked:null, disliked:null}`. Load the non-public binding
columns explicitly and supply current exact item IDs when available. No Library
UI, filters, counts, sorting or API response changes are included in V1.

The existing Watchlist Play State Sync also records preferences from its existing
exact Movie/Series reads. Current Jellyfin Viewing Sync adds top-level Series IDs
from the existing current Library generation to its same bounded per-user reads;
Movie IDs are deduplicated. It records preferences for exact globally scoped TMDB
identities only, without enrolling those rows into watched-state synchronization.
Missing or ambiguous canonical identities are skipped, never title-matched.

Missing items/UserData, failed reads, wrong type/TMDB IDs, changed accounts,
changed media IDs and conflicting version ratings do not clear preferences.
Jellyfin 10.10.7 serializes null properties with `WhenWritingNull`, so omitted
Likes on a valid successful UserData observation means Neutral. It is distinct
from a missing response. All exact versions must agree; conflicts retain the
last observation and do not advance its timestamp.

The existing current-viewing run/library-generation fences remain in force.
Preference writes additionally check account/server bindings and conditionally
update only when their observation start time is newer. Deleted Watchlist state
rows are not recreated by stale reads. Current-viewing summaries separately
report preference updates/incomplete observations; existing viewing completeness
and watched processing remain unchanged.

No provider calls are added to the Watchlist reads. Current-viewing reads add
one Series ID per exact top-level variant, still in batches of at most 100 IDs
and the existing bounded user concurrency. This can add batches, not jobs.
Persistence adds bounded identity checks and preference-only database writes.
Preferences survive application restart; toggles between sync observations are
not an event history. No preferences are reconstructed retroactively.

## Installation, only after separate approval

1. Review this candidate and its side effects; complete real-account acceptance
   in a single-user session without using the production harness for migrations.
2. Back up the existing Native User Likes Injector entry privately.
3. Replace that entry's script with this candidate and keep authentication
   required. Do not add a second copy: both intentionally use the same installation
   guard and `custom-jellyfin-likes` root. Leave Subtitle Reporting untouched.
4. Reload Jellyfin Web. Verify Movie, Series, Season and Episode controls and
   parent scope before authorizing live rating changes.
5. To unload this candidate temporarily, call
   `window.__jellyfinLikesInstalled.dispose()`; it removes controls, listeners,
   observer and styles. To roll back installation, restore the saved entry and
   reload. Neither action restores changed ratings or watched state.

No live installation, production migration, reaction write or deployment was
performed during V1 implementation. Full authoritative hosted validation remains
required for any future publication under `docs/VALIDATION.md`.
