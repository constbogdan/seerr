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
automatic retry or rollback. Navigation/reload loses that temporary retry state;
inspect the native watched state before using another toggle.

Native user-data notifications update Jellyfin's own controls; the candidate
updates its own selected state. Browser acceptance of feed/parent refreshes is
still required. Other-device changes are reread on activation, not continuously
polled. New Episodes receive no special handling.

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
