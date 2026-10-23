# Next Season automation

Next Season is an independent, disabled-by-default scheduled job that evaluates
persisted Library viewing progress every five minutes. It does not run from the
Jellyfin Activity Sync callback and does not fetch viewing state directly from a
media server.

## Eligibility

The job examines at most 50 physically current Series per run. It evaluates
every physically present regular Season independently for each viewer. Specials
are excluded. The immediately following numbered Season is considered when at
least one viewer has watched 70 percent or more of the source Season.

The numerator is the Library's distinct completed Episode evidence for that
viewer. The denominator is the authoritative regular Episode count from the
same cached TMDB Series metadata already used to verify the target Season. A
missing, zero, or inconsistent denominator fails closed. This prevents a
partially present source Season from appearing complete merely because only its
available files were counted.

The next Season must exist in cached TMDB-backed Series metadata, contain at
least one Episode, and have an air date no later than the current date. Missing
Season numbers are never jumped: progress in Season 1 evaluates only Season 2,
while a separately present Season 3 may independently evaluate Season 4.
Targets are deduplicated by canonical Series and Season number. Across the whole
run, no more than five requests are submitted, ten metadata lookups are allowed,
and execution is bounded to 45 seconds. Remaining targets are reconsidered by a
later five-minute run through the existing rotating Series cursor and request
checks. The cursor advances only after a Series candidate is fully evaluated, so
a limit, deadline, or cancellation revisits an interrupted candidate safely.

Seerr skips Seasons that are already available, partially available, requested,
failed, processing, actively downloading, blocklisted, or no longer physically
current. Because Seerr's existing partial-Series request contract treats a
partially available Season as already represented, Next Season does not invent
an Episode-level acquisition path. It also skips when partial Series requests
are disabled.

## Ownership and safety

Automatic requests use the administrator configured as the Watchlist Roulette
request owner. Enabling Next Season fails if that account is missing or is no
longer an administrator. The existing `MediaRequest.request` workflow remains
responsible for permissions, quotas, duplicate locking, blocklists, override
rules, approval, and Sonarr submission. The job never sends Sonarr commands
directly. Each run refreshes acquisition state once and fails closed when that
snapshot is not authoritative; it never performs one acquisition lookup per
Series. Immediately before reporting or submitting a target, it also verifies
that the exact source Season remains physically present and that the target has
not appeared.

Next Season uses an explicit Season-scoped automatic-request duplicate check.
An existing automatic request for the same Season remains authoritative, while
non-overlapping Seasons of the same Series can be requested independently. All
other automatic-request callers retain Seerr's existing media-wide duplicate
behavior.

The job is registered through the standard synchronization guard. Contained and
commissioning modes suppress scheduled and ordinary manual execution, and there
is no startup catch-up. Concurrent runs are rejected, while request submission
is rechecked immediately before the existing request lock is entered.

## Dry run

Administrators can enable or disable the job and run the diagnostic from
**Settings > Next Season**. Jobs & Cache also exposes the same **Dry Run**
action, or administrators can call:

```text
POST /api/v1/settings/jobs/next-season/dry-run
```

Dry run executes the real persisted progress, metadata, availability, request,
and acquisition checks. It never persists a request or invokes Sonarr. The
response contains bounded candidate identities and skip reasons but no private
viewer identities. A dry run does not replace the last operational run result.
