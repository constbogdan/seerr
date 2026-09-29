# Watchlist intent and Jellyfin completion

The downstream Watchlist is an explicit, user-owned statement of future viewing
intent. Requests, availability, acquisition, playback, completion, and future
preference signals do not add or remove Watchlist membership.

## Completion projection

Local Seerr Watchlist rows may carry a narrow projection of the same user's
current Jellyfin completion:

- `watched`: Jellyfin authoritatively reports completion;
- `not_watched`: Jellyfin authoritatively reports incomplete;
- `unknown`: no safe current conclusion is available.

The default Watchlist view is **Not Watched**, which includes both
`not_watched` and `unknown`. **Watched** and **All** are explicit alternatives,
and filtering happens before pagination. Provider outages preserve the last
known projection. Missing or ambiguous identity evidence produces `unknown`,
never a guessed incomplete state.

Movie completion comes from exact mapped normal and 4K Jellyfin item IDs; any
exact version with `UserData.Played=true` establishes `watched`. TV v1 uses the
exact Jellyfin Series item's `UserData.Played` as “caught up with all currently
indexed content.” A Series must have `RecursiveItemCount > 0`, so an empty
Series cannot be treated as watched. A newly indexed episode can therefore move
a Series back to `not_watched` until the user catches up.

Only `jellyfinPlayed`, `jellyfinLastPlayedAt`, the successful sync time, and an
internal normalized Jellyfin-user binding are persisted. Immutable viewing
history belongs to a future Jellyfin Activity feature, not Watchlist.

## Identity, privacy, and lifecycle

Membership identity is `(requestedBy, mediaType, tmdbId)`. The optional derived
Media relation uses `SET NULL`, so deleting or rebuilding Media cannot delete
explicit Watchlist intent.

Completion is resolved only through exact `User.jellyfinUserId` mapping. No
username, email, display-name, title, or TMDB fallback is permitted. Normalized
Jellyfin IDs are unique when present; ambiguous legacy mappings fail closed. A
changed Jellyfin account invalidates completion derived from the previous
account until the newly linked account can be queried successfully.

Owners can read their own enriched Watchlist. Administrators and users with the
purpose-built `WATCHLIST_VIEW` permission can select **Me**, **All Users**, or a
specific user. `MANAGE_REQUESTS` alone does not grant this playback-derived
visibility. Cross-user responses expose only the minimal owner identity needed
for presentation.

## Reconciliation and reusable Jellyfin boundary

`Watchlist Play State Sync` runs at startup, approximately every five minutes,
and from the existing administrator Jobs page. It is singleton/non-overlapping,
groups rows by exact Jellyfin user, batches at most 100 exact item IDs per
request, limits user concurrency, performs network work outside the database
transaction, and atomically updates rows that still exist.

The generic Jellyfin client supports bounded per-user `/Items` reads with
`enableUserData=true`, a fixed timeout, typed `UserData`, and opt-in item fields.
Watchlist consumes only completion evidence, while later Activity, progress,
and preference work can reuse the client without broadening Watchlist storage.

Plex Watchlists remain upstream-owned remote projections. They report that
Jellyfin completion filtering is unsupported rather than pretending a remote
page was fully filtered locally.

## Product boundaries

- This enrichment never creates Requests or drives acquisition. The existing,
  separately configured Plex Watchlist auto-request behavior is unchanged.
- Watched is current completion, not immutable history or sentiment.
- Likes, dislikes, favorites, recommendations, Historical Library, and Activity
  are separate future features.
- Mosaic must eventually use user-scoped Seerr authorization and the canonical
  Seerr Watchlist; it must not create a parallel Watchlist database or rely on a
  broad service identity.
