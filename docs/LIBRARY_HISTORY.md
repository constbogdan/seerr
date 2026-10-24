# Library foundation

Library is the downstream durable record of canonical media, physical
library presence, storage facts, viewers, and normalized viewing evidence. It
is intentionally separate from Seerr's current `Media`, `Season`, `Request`,
`Watchlist`, and `UserMediaState` projections.

## Identity and lifecycle

- Canonical Movies and Series have separate typed identity namespaces.
- Exact provider and source aliases may be attached or corrected without
  replacing the canonical row. Titles never establish identity.
- Series own durable Seasons and Episodes. Season 0 and unaired Episodes remain
  representable facts. Episode air date is retained as the explicit policy
  cache used by the aired-completion denominator; Season and Episode titles
  are reconstructed rather than persisted.
- A `LibraryPresence` is one source-scoped presence interval. Removal closes an
  interval; reacquisition creates another interval for the same canonical
  media.
- Storage roots are identified by Servarr type, Seerr service configuration,
  and Servarr root-folder ID. Physical files retain byte sizes once even when a
  Sonarr file represents multiple Episodes.

## Viewing

`Viewer` uses exact media-server source identity and may link to a current
Seerr user. Removing that user only detaches the link. `ViewingEvidence`
retains source-scoped activity identity, exact canonical Movie/Episode
identity, playback evidence, completion certainty, and derivation version.
Unresolved source activities are counted and skipped rather than persisted;
they are retried by a later complete hydration after exact aliases become
available. Titles are never used for identity.

## Library Sync and current hydration

The user-facing **Library Sync** job (internal ID
`library-history-hydration`, retained for compatibility) establishes and
reconciles the current baseline without changing external systems:

- Radarr owns current managed Movie identity, roots, paths, MovieFiles, logical
  bytes, and MovieFile import dates.
- Sonarr owns current managed Series hierarchy, roots, paths, Episodes,
  EpisodeFiles, logical bytes, and EpisodeFile import dates. A multi-Episode
  file is stored once and linked to every represented Episode.
- Jellyfin owns current visibility and exact Jellyfin/provider aliases. Its
  absence never closes a Servarr-managed physical presence.
- Seerr `Media` and `Request` remain the current application projections.
  Exact typed identities link `CanonicalMedia.currentMediaId`; request context
  remains available through that relationship. Request creation is never used
  as a library-added date, and hydration never changes request or media status.

`CanonicalMedia.titleSnapshot` and `year` are narrow query/fallback caches,
not source snapshots or authoritative presentation. They are populated from
deterministic English provider metadata through Seerr's cache-aware TMDB
client. Radarr, Sonarr, and Jellyfin localized titles never write them.
Hydration resolves identity through exact typed provider IDs or source-scoped
Servarr/Jellyfin IDs and records conflicts rather than title-matching. An exact
linked Seerr `Media.tmdbId` can safely materialize a missing canonical TMDB
alias. A source must finish complete enumeration before it can
close that source's current presence or file interval. Failed or partial runs
retain last-good state and mark their durable checkpoint failed.

The job starts a catch-up 30 seconds after application job registration, runs on
a conservative daily schedule, and supports the administrator Jobs **Run Now**
action. Invocations are single-flight. Database-writing background jobs share an
exclusive in-process coordinator, while every hydration run also has durable
lease ownership and conditional completion. Each source has a `HydrationRun`,
`SourceCheckpoint`, and idempotent current observation; expired or superseded
workers cannot complete a newer checkpoint. Incomplete source enumeration keeps
the checkpoint non-current and preserves last-good membership.

Membership-affecting hydration advances a durable global current-Library
generation. Per-source hydration epochs independently prevent a provider
snapshot captured before removal from reopening the removed presence. A stale
run fails closed and converges through a fresh retry; the generation is not a
timestamp and is not process-local.

Confirmed Radarr and Sonarr imports also enqueue a bounded, process-local
targeted refresh of the affected Movie or complete Series. It rereads only the
exact Servarr target, coalesces repeated import generations, and commits
target-scoped Foundation changes only after revalidating the global generation
and affected source epochs. Provider reads occur outside the shared background
write lock; unchanged snapshots perform no business-data writes. This immediate
path is best-effort and deliberately has no durable queue. A restart, exhausted
retry window, identity conflict, or provider outage is recovered by the next
authoritative Full Library Sync, which remains the only source-wide closure and
checkpoint owner. Jellyfin visibility and Seerr availability completion remain
the responsibility of the independent Jellyfin reconciliation path.

Servarr connection credentials, provider options, and root selections remain in
`settings.json`. Optional Storage Root display names, colors, and Animation
designations live in the database. An update validates the whole payload before
writing, serializes settings updates in the supported single process, and
compensates the JSON file if the database transaction fails. A reported partial
persistence state must be resolved by retrying the same validated update after
storage is healthy; it must not be treated as an atomic success.

## Portable historical-data import

Permanent Seerr-custom has no native Jellystat source, entity, checkpoint, or
scheduled job. Historical facts enter the same Jellyfin-owned Foundation
through the administrator-only **Import historical data** surface and the
versioned `wholphin-history-v1` contract.

The portable file contains exact typed canonical identities, durable Jellyfin
viewer identities, Series/Season/Episode hierarchy, truthful non-current
library facts, and normalized playback evidence. The complete file is
size-bounded, schema-validated, reference-validated, and integrity-checked
before one atomic database transaction begins. Validation and import use the
same database-aware inspection. Import repeats that inspection while holding
transactional ownership of the source checkpoint, so a concurrent import
cannot invalidate an earlier validation decision.

Durable source identities are compared with every persisted normalized fact.
An exact repeat is a true no-op and creates neither a run nor a checkpoint
update. Missing facts from the same accepted artifact may be repaired, and a
cumulative artifact may add facts only when it contains the previously
accepted evidence and does not regress the observed date range. Changed facts,
changed identity ownership, historical omissions, older bounded ranges, and an
unbounded artifact following an accepted bounded range are rejected atomically
for explicit review. Existing exact current identities win over historical
fallback title/year metadata, and imported historical presence is always
non-current.

The artifact `coverage` fields describe the minimum and maximum timestamps
actually observed in that artifact. They do not claim that Jellystat history is
exhaustive before, between, or after those timestamps. The API and Settings UI
therefore report historical completeness as `not-asserted`, independently of
whether artifact ingestion succeeded. A CURRENT historical-import checkpoint
means only that the accepted artifact was ingested successfully.

Completion certainty is carried explicitly. `CONFIRMED`, `LIKELY`, `PARTIAL`,
`UNKNOWN`, and no-qualifying-evidence remain distinct; import never converts
uncertain playback into Jellyfin `Played=true` and never mutates
`CurrentViewingState`. Unknown removal dates remain unknown. Watchlist, Fresh,
requests, and acquisition state are outside the import transaction.

The one-time legacy conversion was completed outside the permanent application
boundary. Its accepted output is the validated October 4
`wholphin-history-v1` artifact plus a separate unresolved report; it remains the
default first-production import artifact unless a concrete coverage gap is
demonstrated. Source credentials, staging schemas, reconciliation state,
candidates, and source-specific identifiers are not part of the runtime or
permanent application architecture. Jellystat is not an ongoing synchronization
source.

## Jellyfin Activity Sync

The user-facing **Jellyfin Activity Sync** job (internal ID
`current-jellyfin-viewing-sync`) reads exact Jellyfin `UserData` for every
current canonical Movie and currently available canonical Episode.
It reuses the same exact-ID validation, 100-item batching, and two-user
concurrency boundary as Watchlist play-state synchronization. The two domains
remain separate consumers so Watchlist's accepted Series-level semantics are
unchanged.

TV targets intentionally use the existing Sonarr-derived canonical
Series/Season/Episode hierarchy and current physical Episode links, then attach
exact Jellyfin aliases. Pure Jellyfin-only TV hierarchy creation is not part of
the supported Wholphin deployment path and is not broadened by this lifecycle
work.

`CurrentViewingState` is a mutable source snapshot keyed by durable `Viewer`,
Jellyfin server scope, and exact Jellyfin item ID. It stores only Played,
PlayCount, last-played time, current position/runtime/progress, canonical
Movie/Episode identity, and successful observation time. It stores no devices,
clients, addresses, sessions, paths, or raw Jellyfin payloads.

Each authoritative `Played=true` snapshot also creates or reuses a monotonic
`ViewingEvidence` row classified `CONFIRMED`. Its stable identity combines the
exact source user, exact item, and valid Jellyfin last-played timestamp; a
timestamp-free fallback remains stable rather than inventing a completion
date. Meaningful resumable `Played=false` state (existing positive Jellyfin
progress/position semantics) creates or updates one stable `PARTIAL` evidence
row per exact Viewer/item. Repeated identical observations are no-ops, stronger
truthful progress replaces weaker progress without summing sessions, and zero
or no-activity state creates no historical evidence. A later confirmation does
not delete the earlier partial fact, but `CONFIRMED` remains authoritative for
historical completion.

After both the current-Library checkpoint and a user's complete item response
are authoritative, obsolete `CurrentViewingState` rows are pruned. Confirmed
and meaningful partial history must already be durable before pruning; zero
state needs no history. Failed/incomplete enumeration or a stale/unavailable
Library checkpoint preserves last-good current state and marks synchronization
incomplete. Current projections independently restrict mutable state to active
Jellyfin targets, so synchronization delay and changed-ID re-adds cannot leak
stale playback into current truth.

Movie, Season, and Series viewing projections are rebuilt from durable evidence
plus current state. `includeInUserMetrics` is evaluated at query time, so
changing it never deletes or reimports evidence. Movie watched counts are
unique Viewers, not play counts. Season completion is Episode-based:

- the available denominator contains distinct Episodes linked to current
  Servarr files under a current presence, provided the Series is currently
  Jellyfin-visible;
- the aired denominator contains regular Episodes with a known air date no
  later than the query date;
- future and unknown-air-date Episodes are excluded from aired completion;
- Season 0/Specials remain a separate projection; and
- one physical multi-Episode file contributes each represented Episode once.

Target identity and the global current-Library generation are captured in one
transaction before provider calls. Each user's current state, evidence, pruning,
and checkpoint update then commits in one transaction only after revalidating
that generation and the viewing-run lease. A membership change rejects stale
persistence and pruning. A failed user transaction preserves that user's
last-good state without rolling back users already committed by the same run.
Expired RUNNING records are recovered truthfully before a later run; stale
workers cannot complete a recovered or superseded run.

Per-user and overall checkpoints distinguish complete, partial, and failed
source coverage. A failed or incomplete batch never refreshes or deletes that
user's last-good state. The job is single-flight, shares the background
database-write coordinator, supports administrator **Run Now**, starts an
immediate catch-up when jobs are registered, and uses a five-minute cadence.

## Factual Library

The administrator-only `/library` surface exposes three derived population
scopes without an Archive table, flag, or state machine:

- **Current** (the default) is current Radarr/Sonarr media with physical files
  and/or current Jellyfin-visible media. Managed-without-file media is not
  silently treated as present.
- **Archive** has trustworthy historical physical membership through a
  source-specific physical presence flag or retained physical file, but does
  not currently qualify for Current. A closed Servarr observation that never
  had a file and a non-visible Jellyfin observation do not qualify.
- **All** is the distinct canonical union. Current wins when old history and a
  qualifying current presence coexist, so re-added media appears once with
  Current semantics.

All scopes show Item, Added, current Watchlist users, per-user Watched, Last
active, and Size where the fact is meaningful. Search, factual filters, sort,
pagination, and selected-page metadata enrichment operate within the selected
scope.

Watched is deliberately completion-focused and current-source authoritative. A
Movie or Episode is Watched for a viewer only when the active exact Jellyfin
item currently says `Played=true`. Durable `CONFIRMED` evidence remains the
authoritative historical/Archive completion fact, but it does not override an
active current `Played=false`. Historical `CONFIRMED`, `LIKELY`, `PARTIAL`, and
ordinary resume progress remain preserved; only active current completion
enters the current Library Watched relationship. Last active remains
activity-based, so an item can have recent or historical activity while showing
no current Watched users.

Series percentages are derived at query time from distinct Watched regular
Episodes divided by distinct regular Episodes linked to current physical
Sonarr files. Specials are excluded from the Series denominator and remain a
separate Season 0 detail. Series detail is Season-first; each Season lists only
users with at least one Watched Episode, with percentage-first chips and exact
Episode counts available on hover or keyboard focus. Adding a physical Episode
therefore changes the denominator without cached or migrated aggregates.

Archive Watched is historical rather than mutable. A Movie is Watched only for
a Viewer with durable `CONFIRMED` evidence. A Series percentage divides the
Viewer's distinct historically `CONFIRMED` regular Episodes by the distinct
regular Episodes linked to retained physical file history. Replacement files
and re-add generations deduplicate by canonical Episode. `PARTIAL`, `LIKELY`,
and `UNKNOWN` evidence never enter the numerator; Specials remain separate and
do not enter the regular Series percentage. Archive Season detail uses the same
Season-first presentation and is expandable only when a Season has useful
confirmed Watched information.

Archive Added uses a truthful retained file import date or historical presence
`addedAt`; otherwise it is unknown. Archive Last active uses the latest durable
qualifying playback timestamp, including partial activity. Archive Size is
always unknown because removed media consumes no current Library storage.
Current Watchlist membership remains an independent present-day relationship
in every scope.

Search, factual filters, sorts, and pagination run before presentation
enrichment. Strict query encoding preserves multiword searches and literal plus
signs. The initial response returns authoritative Library facts plus cached
presentation immediately; missing typed TMDB presentation is queued in the
bounded, process-local enrichment coordinator and the client performs a bounded
revalidation. Identical cold requests are coalesced by media type, identity, and
locale. Provider timeout or failure leaves canonical fallback text and missing
artwork rather than blocking the Library response. Storage roots use safe
labels; raw paths, source activity IDs, playback payloads, credentials, and
media-server user IDs are never returned.

Library remains factual, while administrators can now apply removal operations
to Current content. One hardened removal service handles whole Movies, whole
Series, and exact Seasons through Radarr/Sonarr. Removal never deletes
canonical history, viewing evidence, Watchlist state, Fresh history, requests,
or Archive records; ordinary Foundation hydration observes the provider and
Jellyfin changes and closes Current presence normally.

Manual and automatic schedules share a configurable 10, 20, 30, 60, or 90
day countdown (60 days by default).
Actionable schedules are the sole source for the ordinary-user Leaving Soon
page. New qualifying target-scoped activity cancels a countdown. Whole-Series
schedules supersede child Season schedules; different manually selected
Seasons may coexist. Due operations refresh authoritative acquisition state and
defer while downloading or otherwise transiently unsafe.

Removal Scan and Removal Processing are independent, disabled-by-default jobs.
Native Jobs & Cache schedules are the sole cadence owner and provide Edit and
Run Now. Removal settings retain only the two execution gates. Removal Scan
admits a new per-run Movie and Series batch
from the eligible **unscheduled** population. Calendar-month age and inactivity
cutoffs use factual Added and Last active, with Added as the never-active
fallback. Each batch is
`min(itemsPerRun, eligibleUnscheduled)`, ranked by longest inactivity, oldest
Added, then canonical ID. Existing manual or automatic schedules exclude their
targets from the population but never consume the next run's batch allowance,
so multiple countdown batches may coexist.

Removal Processing never selects candidates. It reconciles activity, cancels
invalidated schedules, and revalidates exact target, provider identity,
acquisition safety, cross-Season file ownership, and current physical presence
before any provider mutation. Pausing processing preserves schedules, and
activity is checked before overdue work executes after resume.

`RemovalSchedule` owns countdown lifecycle, exact Movie/Series/Season scope,
origin, activity baseline, optimistic revision, and the legacy schedule lease.
It is not execution ownership. Manual, bulk, and scheduled operations all use a
durable canonical-media `RemovalExecutionClaim` with an owner token, monotonic
fence, lease, and execution phase. Whole-Series and child-Season work conflict
through the same permanent claim anchor. Provider calls occur outside database
transactions, but every transition, schedule reconciliation, Foundation write,
and release conditionally verifies ownership. Clear All is atomic and refuses
the entire operation when an actionable schedule has a live durable claim or
legacy lease.

Provider acknowledgement is stored separately from confirmed physical absence.
Lease loss, timeout, crash, or local reconciliation failure after the provider
boundary leaves an uncertain/reconciliation-required execution; it is recovered
through read-only provider reconciliation and never by blindly repeating the
destructive command. Successful fenced reconciliation closes the current
presence and advances both the source removal epoch and global Library
generation so stale hydration and viewing snapshots cannot restore old Current
truth. Leaving Soon remains a direct projection over actionable schedules.

## Durable boundary

The factual foundation supplies the durable entities and migrations, current
Radarr/Sonarr/Jellyfin hydration, exact current Seerr linkage, portable
historical facts normalized into Jellyfin semantics, source-completeness
safeguards, native job integration, current Jellyfin Movie/Episode state,
rebuildable viewing projections and the factual Library dashboard.

The normalization boundary adds exact durable Watchlist
`ACTIVE`/`SATISFIED`/`REMOVED` occurrences while retaining the current active
membership projection. It also removes reconstructable Fresh presentation
snapshots and resolves the selected Fresh page through normal Seerr metadata.
Fresh's irreversible admission/opportunity history remains unchanged.

Canonical identity, closed/current presence, files and Episode links, Viewer
identity, normalized viewing evidence, checkpoints, Watchlist occurrence
history, and Fresh discovery history remain durable even though the initial
Library page focuses on current physical media.

The accepted portable export passed clean-database equivalence before the
disposable Phase C migration tooling was retired. Favorite, co-viewing,
Like/Dislike and Storage Router behavior remain deferred.
