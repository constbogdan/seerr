# Seerr downstream handoff

## Current checkpoint

R0–R11 of the Library-enabled production-readiness program are accepted for the
supported SQLite, single-process topology. R12 owns documentation, i18n, backup,
and operational readiness; R13 remains the full validation and immutable release
candidate gate.

- Repository: `constbogdan/seerr`; upstream remains `seerr-team/seerr:develop`.
- The intended production path is immutable GHCR digest → Dockhand → one Seerr
  container on the UGREEN NAS with persistent `/app/config`.
- The first deployment upgrades the existing production SQLite database and
  preserves users, requests, settings, and Watchlist data while adding the
  Foundation schema through migrations.
- The approved October 4 `wholphin-history-v1` artifact is the default one-time
  historical input. Jellystat is not a continuing synchronization source.
- Removal automation remains disabled and requires separate explicit approval.
- PostgreSQL runtime/concurrency acceptance and multi-replica support remain
  outside the claimed deployment topology.
- Startup synchronization is controlled by the strict process-start
  `SEERR_SYNCHRONIZATION_MODE` contract. Contained mode blocks automatic and
  manual synchronization; commissioning mode enforces Library, Jellyfin
  Activity, Watchlist, then optional Fresh ordering. See the
  [first-production deployment runbook](FIRST_PRODUCTION_DEPLOYMENT.md).

## Decisions that must survive

- Strategy C is the permanent workflow architecture: upstream workflow sources
  remain identical, unsafe workflows are disabled externally, and only downstream
  validation and image publication are downstream-owned.
- `downstream-main` is the product branch. Clean upstream contributions remain
  based directly on `upstream/develop`.
- Do not mix Fresh, queue contribution work, or direct refresh into workflow
  bootstrap changes.
- Do not publish images until validation, branch protection, default-branch state,
  and workflow disable state are authenticated.

See [maintenance](SEERR_DOWNSTREAM_MAINTENANCE.md) for the operating model and
the [roadmap](SEERR_DOWNSTREAM_ROADMAP.md) for sequencing.

## Active workstreams

### Queue sync

[Upstream PR #3535](https://github.com/seerr-team/seerr/pull/3535) is open and
non-Draft against `develop` from `fix/servarr-download-queue-sync-v2`. Its observed
head is `3093f869e0ebcc14771a44846e79ba74325ff999`. Keep this an upstream
contribution; do not merge it into the downstream product merely to establish the
maintenance branch.

### Fresh

Fresh is merged into `downstream-main` and maintained in this repository. The
earlier isolated prototype checkout has been retired. Continue Fresh maintenance
from the primary Seerr checkout and preserve its persistent incremental
architecture. The durable Movie/Season/Special identity, irreversible-history,
typed correction, override, rebuild, and GAP-recovery contract is documented in
[Fresh discovery](FRESH.md). Administrators can open Candidate Diagnostics
directly from the Discover Fresh row or the dedicated Fresh page; durable
Visible/Hidden preferences affect that work queue only.

### Watchlist

The downstream Watchlist remains explicit viewing intent and is enriched with
the same user's current Jellyfin completion. Completion is owned by a reusable
per-user typed-media current-state projection, so removing and re-adding
Watchlist intent does not erase known state. The explicit
`includeInUserMetrics` flag is independent of authentication or permissions;
people-oriented selectors exclude opted-out accounts without username
inference. It is managed individually or through the existing Bulk Edit flow,
whose single checkbox directly sets the boolean for every selected account.
Bulk Edit deliberately has no third unchanged state. Ordinary cards show only the
positive Watched signal while retaining not-watched and unknown as distinct
operational states. Exact typed identity remains mandatory: same-title Jellyfin
items with a different TMDB identity must remain unknown.
The durable identity, privacy, Movie/TV semantics, failure behavior,
reconciliation jobs, and Activity boundary are documented in
[Watchlist intent and Jellyfin completion](WATCHLIST.md). Requests, playback,
availability, and completion never create or remove membership. Cross-user
enriched views require administrator authority or the purpose-built
`WATCHLIST_VIEW` permission; `MANAGE_REQUESTS` alone is insufficient.

### Local harness

The `seerr-harness` workspace is a separate repository for running queue or the
primary Seerr checkout against isolated local configuration and real services.
Keep it outside the Seerr source repository and outside hosted CI.

## Immediate next actions

1. Verify startup-synchronization containment and ordered commissioning during
   R13 clean-candidate validation.
2. Complete R13 full validation from a clean immutable candidate containing all
   intended WIP.
3. Publish and authenticate the versioned GHCR image, source tag, rolling tag,
   OCI metadata, and immutable digest through the protected workflow.
4. Execute the runbook's backup/restore rehearsal before approving the
   UGREEN/Dockhand deployment window.
5. Deploy by immutable digest, import the verified artifact once, and preserve
   Removal-disabled evidence through acceptance.

## Deferred

- Direct/on-demand Download Sync refresh.
- Automated upstream detection and sync-PR creation.
- Stable downstream image channel.
- Richer release provenance/changelog.
- Automated canary and rollback.

Do not infer completion from roadmap intent. Reauthenticate repository settings,
workflow state, branch protection, image digests, and deployment state at each
boundary.
