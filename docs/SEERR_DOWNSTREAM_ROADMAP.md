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

- Audited upstream tip: `794743a45f17e3d6aba06d68e1716e8b15146673`.
- `origin/downstream-main`: `f74657aa501e1fc28bf314673a0cedde167d47e6`.
- Current infrastructure branch: `chore/downstream-image-publication`.
- Upstream queue-sync contribution: [seerr-team/seerr#3535](https://github.com/seerr-team/seerr/pull/3535), open against `develop`.
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
- [ ] Validate deployment and rollback against the NAS environment.

## Phase 2 — downstream features and repeatable upkeep

- [x] Deliver persistent Fresh discovery with focused tests and downstream release validation.
- [x] Refine Fresh with irreversible Movie/Season/Special history, typed manual
  correction, admission overrides, and an administrator work queue.
- [x] Add administrator shortcuts from Fresh/Discover to Candidate Diagnostics.
- [x] Enrich explicit Watchlist intent with the same user's current Jellyfin
  completion while preserving membership independence and privacy. See
  [Watchlist intent and Jellyfin completion](WATCHLIST.md).
- [ ] Improve validation performance without weakening exact-tree evidence.
- [ ] Evaluate direct/on-demand Download Sync refresh as a separate downstream feature.
- [ ] Add automated upstream change detection.
- [ ] Add reusable upstream sync-PR generation if manual sync becomes costly.

## Later, when justified

- Jellyfin Activity and immutable viewing history, independently of Watchlist.
- User-scoped Mosaic Watchlist integration without a parallel state store.
- Stable downstream release channel.
- Richer release provenance and changelog presentation.
- Automated canary deployment and rollback.

Do not add broader release or upstream-resolution machinery unless repeated
Seerr maintenance demonstrates a concrete need.
