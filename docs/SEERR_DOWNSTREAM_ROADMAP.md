# Seerr downstream roadmap

This roadmap tracks the maintained `constbogdan/seerr` product line. It does not
replace the upstream Seerr roadmap or describe upstream contribution work.

## Direction

```text
upstream/develop
      ↓
reviewed sync PR
      ↓
downstream-main
      ↓
downstream validation
      ↓
GHCR image
      ↓
Dockhand / NAS
```

The downstream should remain close to `seerr-team/seerr:develop`, preserve clean
upstream contribution branches, and carry only features that need a maintained
downstream home.

## Current baseline

- The maintained product has passed the staged upstream integrations and shipped
  v1.0.42. See the [package reference](SEERR_DOWNSTREAM_PACKAGE.md) for immutable
  release evidence and the boundary between publication and deployment acceptance.
- The supported deployment claim remains SQLite, single process. Historical
  R0–R13 candidate gates are not unfinished feature work; runtime/rollback
  observations still need their own release-specific evidence.
- Exact upstream/downstream SHAs and the deployment digest are release evidence,
  not durable roadmap text, and must be captured in the publication summary and
  deployment record.
- Upstream contribution status must be reauthenticated at release time rather
  than inferred from an older roadmap snapshot.
- Fresh discovery: merged into `downstream-main`; current architecture and
  operating invariants are documented in [Fresh discovery](FRESH.md).
- Local integration harness: the separate `seerr-harness` workspace.

## Phase 1 — safe downstream foundation

- [x] Create `downstream-main` from the authenticated upstream tip.
- [x] Complete the temporary inherited-workflow bootstrap guards.
- [x] Add the downstream-owned validation workflow and workflow-inventory check.
- [x] Make `downstream-main` the fork default branch.
- [x] Disable and verify unsafe inherited workflows in GitHub.
- [x] Require downstream validation in branch protection.
- [x] Restore inherited workflow files to upstream-identical content.
- [x] Add downstream-owned GHCR image publication.
- [x] Add namespaced versions, GHCR package metadata, and per-build summaries.
- [ ] Live-verify Dockhand update detection and release-detail presentation.
- [x] Record the operator-reported November 5 NAS health/UI acceptance and supplied
      runtime-log observations, separately from public image verification.
- [ ] Verify backup integrity and an isolated restore rehearsal; retain long-term
      stability and exhaustive feature acceptance as separate open checks.

## Phase 2 — downstream features and repeatable upkeep

- [x] Deliver persistent Fresh discovery with focused tests and downstream release validation.
- [x] Replace legacy Fresh matching administration with Fresh V2 automatic sync,
      durable discoveries and bounded recovery. Manual corrections, overrides
      and Candidate Diagnostics were retired, not carried forward.
- [x] Enrich explicit Watchlist intent with a reusable per-user typed-media
      Jellyfin current-state projection, an explicit user-metrics inclusion flag,
      and privacy-preserving people selectors. See
      [Watchlist intent and Jellyfin completion](WATCHLIST.md).
- [x] Establish the durable Library History foundation and hydrate the current
      Radarr, Sonarr, Jellyfin, Seerr Media, and Request baseline using exact source
      identity and fail-closed source coverage. See
      [Library History foundation](LIBRARY_HISTORY.md).
- [x] Complete the one-time legacy-history reconciliation and export a
      deterministic `wholphin-history-v1` dataset. Permanent Seerr imports this
      Jellystat-agnostic format into its normal Jellyfin-owned Foundation. See
      [Library History foundation](LIBRARY_HISTORY.md).
- [x] Reconcile current Jellyfin Movie/Episode UserData into durable current
      viewing state and confirmed evidence, with rebuildable Movie, Season, and
      Series projections. See [Library History foundation](LIBRARY_HISTORY.md).
- [x] Resolve Fresh presentation through normal metadata; V2 rebuilds from
      approved source history rather than importing legacy admission outcomes.
- [x] Preserve durable Watchlist intent occurrences and legacy SATISFIED history.
      Current completion enriches explicit membership; it does not automatically
      satisfy or remove Movie/Series intent.
- [x] Add hardened administrator Movie/Series/Season removal, durable manual
      and bounded automatic schedules, activity cancellation, acquisition safety,
      and the ordinary-user Leaving Soon projection. Foundation hydration remains
      responsible for Current-to-Archive transitions.
- [ ] Normalize the remaining Watchlist query-title cache to deterministic
      English provider metadata without changing membership or card presentation.
- [ ] Improve validation performance without weakening exact-tree evidence.
- [ ] Evaluate direct/on-demand Download Sync refresh as a separate downstream feature.
- [x] Add scheduled upstream observation and guarded candidate PR publication,
      including managed attention Drafts and resolver handoff. See
      [upstream synchronization](UPSTREAM_SYNC.md).

## Later, when justified

- Activity dashboard and broader analytics beyond the normalized viewing
  foundation.
- [x] Promote one fast factual administrator Library at `/library`, backed by
      current physical presence, current Watchlist membership, and normalized
      per-user viewing facts. Policy-driven Retention was rejected as a product
      requirement and removed before publication.
- Storage Router behavior remains separately gated; source-specific legacy
  migration state is disposable.
- User-scoped Mosaic Watchlist integration without a parallel state store.
- Stable downstream release channel.
- Richer release provenance and changelog presentation.
- Automated canary deployment and rollback.

Do not add broader release or upstream-resolution machinery unless repeated
Seerr maintenance demonstrates a concrete need.
