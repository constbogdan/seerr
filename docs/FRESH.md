# Fresh V2 discovery

Fresh is an automatic discovery feed sourced exclusively from approved releases
in the selected numeric autobrr filter. It never submits requests or mutates
providers. Seerr's existing TitleCards own Details navigation, request actions,
Watchlist behavior and availability presentation.

## Durable model

V2 uses only three runtime entities:

- `FreshSourceState`: source/filter fingerprint, committed checkpoint, frozen
  scan head and continuation cursor, backfill completion, bounded retry state,
  dynamic filter-year evidence and a rotating late-approval cursor.
- `FreshWork`: deduplicated source evidence, earliest original source timestamp,
  bounded release-name sample, matching outcome, retry state and resolved identity.
- `FreshDiscovery`: typed TMDB identity and Movie/Series/regular-Season event,
  original discovery timestamp, visibility deadline and minimal fallback title.

Legacy Fresh entities remain registered only to preserve their tables during
development schema synchronization. V2 does not read, transform, update or delete
their records. No legacy manual corrections, overrides or admission outcomes are
imported.

## One synchronization lifecycle

Fresh Sync remains scheduled every five minutes. The same entry point handles
startup catch-up, initial history traversal, incremental capture, due matching,
provider retries and continuity recovery. There is no reconciliation or separate
backfill job. Existing contained/commissioning execution guards and single-flight
database-write coordination remain authoritative.

The initial scan walks **all available** autobrr history. Each execution captures
at most ten pages and resolves at most 100 grouped work items, with a two-minute
execution budget checked between provider operations. These are per-execution
limits, not total-history cutoffs. Source requests and matching continue on later
executions until finished.

Each captured page and its continuation state commit together. The scan head is
frozen across executions; the high-water checkpoint advances only when that range
is completely captured. New arrivals during backfill are collected by subsequent
incremental execution. Resolution occurs outside source capture transactions;
temporary metadata failures cannot discard captured releases.

autobrr exposes insertion-order history rather than a proven modified-since
approval feed. After backfill, the same job also probes one older page per
execution using a durable rotating cursor. This discovers late approvals without
a second job or repeated TMDB searches for completed groups. Late historical
approvals may take a full probe rotation to appear.

An unchanged incremental execution normally reads the filter configuration, the
head page and at most one historical page. Group lookups are indexed; no unchanged
work or discovery rows are rewritten and there are zero TMDB identity lookups
when no retry is due. Only the small probe progress record may advance.

Missing checkpoints and regressed source IDs trigger automatic retained-history
recovery. Previously captured work remains durable. No recovery claim is made for
releases already pruned by autobrr before they were captured.

## Matching

The source supplies parsed title, optional year and media type. Valid external
TMDB/IMDb/TVDB identifiers are used when actually present; their availability is
not assumed. Movie and Series namespaces never mix.

Movie searches use Seerr's cached, error-preserving TMDB client with the broader
`year` parameter. A returned primary release date need not have the same year.
Configured alternate years are read dynamically from the selected filter, not
hardcoded. An ambiguous search is never bypassed by trying another year.

Series searches first run without a first-air-year constraint, since a release
or Season year need not be its premiere year. An ambiguous or truncated search
may be disambiguated by a complete, unique exact-title/premiere-year result;
unsuccessful narrowing preserves the original outcome. A no-match can retry a
trailing numeric `Volume N` title without that suffix. No Season lookup is
necessary to confirm a Series identity. Calendar-year Season coordinates never
authorize year narrowing: that year identifies the source Season, not a premiere.

A unique normalized localized/original title wins over unrelated ranked results.
For a complete small result set, provider-verified aliases can establish a unique
match, including a valid singleton. Unrelated singletons, conflicting identities
and incomplete/truncated searches are skipped automatically. Vote count and
popularity never override title evidence.

When a broader Movie search is ambiguous or truncated, a complete primary-year
search may recover a unique exact-title/year identity. Known competing exact
titles in other configured filter years, missing competitor dates and same-year
conflicts remain fail-closed. This preserves useful year evidence without making
old-year shorts or documentaries automatically override competing feature films.
Already unique broader-year matches and verified aliases keep precedence.

Searches are bounded to three pages and four year attempts per work item.
Complete searches must receive every reported hit with stable page totals.
Repeated IDs with consistent title/date evidence are deduplicated; conflicting
duplicate evidence remains retryable rather than being silently overwritten.
Malformed responses and provider failures remain retryable, distinct from genuine
no-match/ambiguity/incomplete outcomes. Selected detail IDs and typed title shapes
are verified before persistence. No manual review or correction workflow exists.

## Discovery and visibility

autobrr filter approval is the sole source-admission authority. Fresh has no
release-age, physical/digital, grace, airing-age, genre, language, score or vote
admission policy. Existing Seerr permissions, blocklist presentation and request
safeguards are unchanged.

All identified approved groups are recorded, including historical ones.
Discovery uses the original autobrr timestamp, never rebuild/retry time. While a
descending backfill finds earlier evidence, an existing discovery clock may move
earlier, never later. Quality upgrades, release groups and repacks do not refresh it.

A Series has one visible card, selected after grouping its discovery events
before count/sort/pagination. Explicit regular source Seasons have distinct clocks.
Calendar-year Season coordinates remain source evidence, not assertions about
TMDB Season numbering. New regular Seasons may refresh the card once; Episodes
and repeated releases from that Season do not. Missing Season metadata does not
invalidate identity. Specials do not create refreshing Season events.

Fresh Visibility (Days) accepts integers from 1 through 365; the existing default
of 7 days and saved administrator values are unchanged. The current configured
visibility duration is applied to source discovery dates
at read time. Stored deadlines preserve the duration in force when evidence was
recorded. Changing visibility intentionally changes the viewing window, without
resetting any discovery date. Expired discoveries remain durable for deduplication.

With content filters disabled and First Seen sorting, only selected-page artwork/overview metadata is
hydrated through Seerr's normal TMDB cache, with concurrency four. Saved fallback
titles survive metadata outages. Enabled genre/language exclusions and inclusive
minimum score/vote thresholds apply only to presentation, before totals and
pagination. Zero disables a numeric threshold. Missing/invalid metadata cannot
qualify for an enabled criterion. No discovery, work, checkpoint or clock changes.

Global Blocklist membership is excluded by typed Movie/Series identity before
counting, metadata filter/sort evaluation and pagination, for every user regardless
of optional Blocklist display preferences. This does not delete discoveries or
change Blocklist creation/removal behavior. Retained discoveries can become
eligible again when the configured visibility window is increased.

Filtered reads and TMDB rating/vote sorts evaluate the complete visibility-eligible typed population in
batches of 20, reusing the same TMDB cache and concurrency limit. A maximum of
5,000 identities and a two-minute budget checked between batches bound each
evaluation. Concurrent identical evaluations coalesce; a different uncached
evaluation waits for a later request rather than starting another provider sweep.
Up to four complete in-memory snapshots are reused for 60 seconds and keyed by
population, locale and filters. Incomplete metadata, capacity or budget exhaustion
returns HTTP 503, never partial results or guessed totals. Relaxing filters takes
effect on the next fetch without synchronization. No separate metadata table,
refresh sweep or rebuild lifecycle is introduced.

## UI and API

### Persisted Animation and Documentary categories

`GET /api/v1/fresh?category=animation|documentary` selects TMDB genre 16 or
99 respectively across both Movie and TV identities. Omit `category` for the
existing All/Movies/Series behavior. `mediaType=movie|tv|all` still applies and
may intersect a category; Movies and Series continue to include animated and
documentary titles. Invalid or repeated categories return HTTP 400.

The existing verified TMDB details response supplies both classifications; no
additional matching request is made. A valid empty genre array means false for
both flags. Missing or malformed genres mean unknown, not false, and do not
weaken identity matching or erase previous classifications. A title may belong
to both categories. Only `movie` and `series` title anchors own the nullable
`isAnimation` / `isDocumentary` flags. Season events remain unclassified.

Classification is source-scoped by the existing typed anchor identity. A new
successful verification can correct either flag independently of discovery
timestamps. Repeated unchanged release groups do not cause new metadata reads.
Known classifications are not continuously refreshed; later successful matching
observations can correct them. Read-time presentation remains independent.

SQL selects the matching anchor before grouping, totals and pagination, without
applying the visibility cutoff to that anchor. Thus a recent regular Season can
make an old Series visible in its category. Category-only First Seen reads keep
SQL paging and hydrate only the selected page. Administrator content restrictions
and metric sorts retain their existing bounded snapshot evaluation, now over the
category-selected population. Blocklist exclusion remains authoritative.

SQLite and PostgreSQL migration `1790000000051` adds the two nullable columns.
Historical records remain unknown; it performs no network calls or backfill.
The existing unique source/type/TMDB/event index supports anchor lookups. No
Boolean-only index is added. Rollback removes only these derived flags, and
requires the matching old application code; it does not remove discovery history.

#### Explicit historical maintenance

Use an **offline, consistently backed-up and migrated SQLite database**, never a
running application's database. No maintenance command is registered with the
scheduler or called by startup/API reads. The default invocation is a dry run
with no provider calls or classification writes:

```powershell
pnpm exec ts-node -r tsconfig-paths/register --project server/tsconfig.json server/scripts/backfillFreshCategories.ts --database C:\isolated\db.sqlite3
```

The read-only preview reports `afterId`, `limit`, `maxLimit`, `budgetMs`, total
`remainingUnknown`, `unknownMovies`, `unknownTv`, `eligibleRecords`,
`selectedAnchorIds`, `nextAfterId` and `hasMore`. Bounds are validated in both
modes. Preview and apply share the same unknown-title-anchor selection. The
preview cursor is the last selected anchor, not persisted progress: use the
original cursor when applying that previewed batch. `hasMore` describes unknown
anchors beyond the selected batch; unknowns before the cursor remain in the total.

After separately authorizing provider reads and writes to that offline database,
append `--apply --limit 20 --after-id 0`. Each invocation examines at most 100
anchors (default 20), with a two-minute budget checked between provider calls.
It uses the ordinary bounded TMDB client/cache; a call already in flight is
subject to that client's timeout, not an independent batch cancellation deadline.
Each typed title is fetched once per batch even if multiple sources contain it.
Both flags come from the same valid response. Existing known flags survive
provider failures and unavailable genres. Dates, source progress, work records,
autobrr evidence and season events are untouched.

The JSON report contains `inspected`, `updated`, `failures`, `unavailableGenres`,
`nextAfterId`, `hasMore`, and `remainingUnknown`. Continue using `nextAfterId`
while `hasMore` is true. **Advance even after failures** so persistent failures
cannot starve higher IDs. At the end, restart at zero if `remainingUnknown` is
nonzero to retry failed/unknown anchors. Completed anchors are skipped. These
nullable flags plus the reported cursor make restart/resume idempotent; save the
cursor externally if desired. Do not fabricate false classifications to complete
the backlog. Refresh browser feeds after replacing the offline-maintained
database through the separately authorized operational workflow.

The web filter maps All/Movies/Series/Animation/Documentary atomically into URL
parameters, preserves sorting, resets pages on selection changes and uses distinct
SWR keys. Mosaic can consume these same category parameters without local genre
filtering; this change contains no Mosaic implementation.

The user interface retains the Fresh slider/page, All/Movies/Series controls,
discovery-date directions and ordinary TitleCards. The dedicated page also offers
`vote_average` (highest rating) and `vote_count` (most votes), descending before
pagination. Invalid, missing or zero metrics sort last; ties use First Seen
descending, media type and TMDB ID ascending. Both sorts reuse the same snapshot
metadata without additional selected-page lookups. Freshest remains the default,
including the Discover slider. Loading uses existing card
skeletons. Last-good cards remain visible during transient refresh errors.
The Fresh heading uses the Watchlist count presentation and the API's distinct
eligible-title total, not loaded cards. Counts are hidden during loading,
revalidation and errors. Pagination follows successfully loaded server pages and
`totalPages`, including pages entirely hidden by client display preferences;
Movie and Series numeric IDs are separate identities. The Discover slider keeps
its intentional 20-card cap. Successful Fresh settings saves and Blocklist
mutations invalidate only Fresh page/slider caches, including infinite aggregates.

Administrator controls are limited to enablement, autobrr connection, filter,
visibility, presentation-only content filters and basic synchronization health.
The Configuration section splits hostname, port and SSL while preserving saved
base paths. Test Connection & Load Filters uses the current connection draft.
Tokens remain write-only; absent content filters default to empty/zero, never a
preferred preset. Existing visibility settings are preserved.
Diagnostics queues, dismissal, manual matching, overrides and rebuild actions
are removed, including their API operations.

## Rollout and rollback

The initial V2 release adds SQLite migration `1790000000048` and PostgreSQL
migration `1790000000049`. Both create empty V2 tables only. Historical migrations
and all eight legacy Fresh tables remain untouched. V2 deliberately rebuilds from
currently available autobrr releases instead of copying old Fresh data.

Consequences: old manual corrections and forced visibility do not apply to V2.
Discoveries pruned from autobrr cannot be reconstructed in V2 by this rebuild.
Their legacy records remain available for rollback; this is not a claim that the
new feed preserves the old feed exactly. No cleanup migration is included.

Before an authorized deployment:

1. Record the old immutable image digest and synchronization mode.
2. Obtain a consistent database backup and matching settings snapshot. Use
   SQLite's supported backup mechanism, including live WAL state consistently,
   or a verified PostgreSQL backup. Never blindly copy a live SQLite main file.
3. Rehearse the additive migration and restore on disposable copies.
4. Deploy V2 contained first and verify the new empty schema and preserved legacy
   records before separately authorizing live backfill.
5. For rollback, stop only the authorized V2 deployment, restore the pre-upgrade
   database **and settings**, then use the recorded old image. Restoring settings
   matters because V2 removes obsolete Fresh settings and the reconciliation job.
6. Verify database integrity, users/requests and legacy Fresh history before
   separately restoring normal synchronization.

Retained tables alone are not a substitute for a tested database/settings backup.
Do not automatically reverse migrations or delete V2 tables during ordinary
startup. See the existing first-production deployment runbook for operational
approval and containment boundaries.

## Validation

During implementation use mocked providers and isolated databases. Cover complete
and interrupted backfill, gaps/regression/late approval, retry/restart behavior,
immutable clocks, Movie/Series/Season deduplication, no-change zero TMDB calls,
native availability/request integration, authorization, settings save failure,
SQLite migration/entity equivalence and PostgreSQL generated DDL/unique contracts.

Compare the frozen Movie experiment read-only where capture coverage permits;
persisted old identities are not ground truth. Use focused regressions and Fast
local feedback during implementation. Hosted Downstream validation supplies the
authoritative Full checks and production build before protected integration;
local Full is an explicitly authorized diagnostic, not a prerequisite for every
PR preparation. See [validation architecture](VALIDATION.md).
