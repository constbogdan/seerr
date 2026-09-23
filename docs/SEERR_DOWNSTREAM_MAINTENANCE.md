# Seerr downstream maintenance

This document defines the intended operating model for `constbogdan/seerr`. The
model is partly implemented: downstream validation exists, image publication does
not, and GitHub repository settings have not yet completed the transition.

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

The current edits to 14 inherited workflows are temporary bootstrap protection.
They remain only until:

1. `downstream-main` is the default branch;
2. GitHub has registered the workflows;
3. unsafe inherited workflows are disabled and their state is verified;
4. branch protection requires downstream validation;
5. a cleanup PR restores the inherited files exactly to upstream content.

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

Image publication is not implemented. Its intended contract is:

- only after reviewed integration into `downstream-main`;
- exact `constbogdan/seerr` repository and branch authentication;
- GHCR only;
- an immutable source-SHA tag and a rolling downstream/development tag;
- recorded source SHA, image digest, and incorporated upstream tip;
- release notes/metadata suitable for Dockhand-visible updates;
- deployment and rollback by a known digest where practical.

Exact rolling and stable tag names remain undecided. No Stable channel is implied
by the initial publisher.

## Local and NAS verification

`C:\Projects\Wholphin\seerr-harness` is the separate local integration harness.
It can run selected Seerr checkouts against isolated local configuration and real
Jellyfin/Sonarr/Radarr services, and provides status, stop, and configuration
backup operations. It is not a CI runner and must not expose its credentials.

The intended delivery path is GHCR → Dockhand → NAS. Test a new image without
silently replacing production state, retain a configuration backup, record the
deployed digest, and keep the prior known-good digest available for rollback.
