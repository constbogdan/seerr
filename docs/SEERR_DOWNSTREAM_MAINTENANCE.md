# Seerr downstream maintenance

This document defines the intended operating model for `constbogdan/seerr`. The
workflow boundary is in its intended Strategy C steady state: downstream
validation, image publication, and external workflow controls have explicit
owners.

## Authorities and branches

- `upstream/develop` is the pristine source from `seerr-team/seerr`.
- `downstream-main` is the canonical maintained downstream product branch.
- Upstream contribution branches, normally `fix/*` or an appropriate `feature/*`,
  start directly from the authenticated upstream tip and must not contain
  downstream-only work.
- Downstream-only feature branches start from `downstream-main`.
- Upstream reconciliation branches should use a name such as
  `chore/sync-upstream-<sha>` and merge through a reviewed PR.

Never force-update the maintained branch or silently replace downstream feature
history with an upstream tree.

## Workflow authority — Strategy C

The permanent model is a minimal downstream workflow surface:

- inherited upstream workflow files remain source-identical;
- unsafe inherited workflows are disabled externally in `constbogdan/seerr`;
- downstream owns only:
  - `.github/workflows/downstream-validation.yml`;
  - `.github/workflows/downstream-image.yml`;
- the repository Actions token defaults to read-only;
- workflow enable/disable state and workflow-file inventory are verified after
  every upstream sync.

The temporary bootstrap guards previously carried in 14 inherited workflows have
been removed. Those workflow files are source-identical to `upstream/develop`;
their unsafe instances remain disabled through external repository configuration.
Restoring source content does not re-enable a disabled workflow, and source
changes must never be treated as a substitute for verifying its external state.

Unsafe inherited workflows include upstream CI publication, release/preview/tag
creation, Pages and Helm publication, Trivy's inherited image scan, and upstream
PR/issue moderation and indexing workflows. Do not rely on missing secrets or
branch-name accidents as containment.

## Upstream sync

For each update:

1. Authenticate the `origin` and `upstream` repository identities.
2. Fetch and record the exact `upstream/develop` tip.
3. Create a sync branch from current `downstream-main`.
4. Merge the recorded upstream tip without rewriting downstream history.
5. Review textual conflicts and semantic overlap with downstream-only features.
6. Run downstream validation and inspect the workflow inventory.
7. Merge through the protected downstream PR path.
8. Reverify externally disabled workflow state before any publication.

Automated detection and sync-PR generation are future conveniences, not current
authority.

## Validation and publication

The read-only `.github/workflows/downstream-validation.yml` runs for PRs targeting
`downstream-main` and may be dispatched manually. Its stable `Downstream
validation` job is intended for branch protection. It runs i18n consistency,
formatting, lint, type checking, unit tests, and a production build. It also
compares the workflow directory with `docs/downstream-workflow-inventory.txt` so
an upstream workflow addition, removal, or rename requires explicit safety review.

The downstream-owned `.github/workflows/downstream-image.yml` publishes:

- only on pushes to reviewed `downstream-main` state;
- only after exact `constbogdan/seerr` repository and branch authentication;
- only when the exact range after the previously published `custom` image is
  product-relevant or conservatively unknown; docs-only and tooling-only ranges
  leave the image, rolling tag, and version unchanged;
- `ghcr.io/constbogdan/seerr:custom-v1.0.N` as the human-readable immutable version tag;
- `ghcr.io/constbogdan/seerr:<full-source-sha>` as the immutable source tag;
- `ghcr.io/constbogdan/seerr:custom` as the rolling update tag;
- `linux/amd64` using the inherited Seerr `Dockerfile`;
- source, revision, version, and build-time OCI metadata;
- the published digest and run link in the workflow summary.

The immutable digest is deployment authority; tags are discovery and convenience
identities. `N` advances once for each required image, using the previous rolling
image's authenticated source/version annotations as the exact classification
baseline. Skipped documentation/tooling merges remain in the next unpublished
range, so a later product publication compares the complete range without version
gaps. The `custom-` namespace prevents confusion with official Seerr releases.

The package description, manifest annotation, and [package documentation](SEERR_DOWNSTREAM_PACKAGE.md)
identify this as a personal downstream build and link the official
`seerr-team/seerr` project. The workflow summary is the current per-build release
record: it includes version, source SHA, digest, build link, and comparison with
the previous published image. It keeps upstream-sync and downstream-change
sections separate. Upstream provenance is reported only when a managed candidate
in the unpublished Git topology has exact upstream/downstream trailers matching
its two parents; ordinary, malformed, or ambiguous merges produce no claim.

No GitHub Release is created. A Release would require broader `contents: write`
authority and Dockhand does not automatically associate one with the mutable
`custom` tag. Reconsider a separate release step only after live Dockhand
verification proves that a versioned Release link materially improves review.

## Local and NAS verification

The separate `seerr-harness` workspace is the local integration harness.
It can run selected Seerr checkouts against isolated local configuration and real
Jellyfin/Sonarr/Radarr services, and provides status, stop, and configuration
backup operations. It is not a CI runner and must not expose its credentials.

The intended delivery path is GHCR → Dockhand → NAS. Test a new image without
silently replacing production state, retain a configuration backup, record the
deployed digest, and keep the prior known-good digest available for rollback.
