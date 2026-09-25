# Seerr downstream handoff

## Current checkpoint

Validate the first downstream-owned image publication and then prove the
Dockhand/NAS deployment and rollback path.

- Repository: `constbogdan/seerr`.
- Upstream: `seerr-team/seerr`, branch `develop`.
- Audited live upstream tip: `794743a45f17e3d6aba06d68e1716e8b15146673`.
- `origin/downstream-main`: `f74657aa501e1fc28bf314673a0cedde167d47e6`.
- Current branch: `chore/downstream-image-publication`; its published workflow
  commit `60276f62` is the second parent of that downstream merge.
- The inherited workflow files are source-identical to `upstream/develop`.
- Unsafe inherited workflows remain disabled externally in the fork; restoring
  their source does not re-enable them.
- `.github/workflows/downstream-validation.yml` defines the read-only required
  `Downstream validation` job and checks the expected workflow inventory.
- `.github/workflows/downstream-image.yml` publishes `linux/amd64` to
  `ghcr.io/constbogdan/seerr` only after a push to authenticated
  `downstream-main`. It uses `custom-v1.0.N`, full-SHA, and rolling `custom`
  tags and reports the authoritative digest in the workflow summary.
- `N` is the protected-main first-parent distance from epoch `f74657aa`; this
  uses deterministic allocation while the `custom-` namespace avoids official
  Seerr version identity.
- GHCR metadata and [package documentation](SEERR_DOWNSTREAM_PACKAGE.md) identify
  the image as a personal downstream build, not an official Seerr release.

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

The prototype is in the separate `seerr-discovery` workspace on `feature/fresh` at
`a3dbbd94a654dcf9f4273d7ba754f66c6d71d799`. It contains tracked and untracked
work and was observed 18 commits behind the audited `upstream/develop`. Preserve
that workspace. Transplant it only after the downstream foundation exists, using
reviewable commits and focused tests.

### Local harness

The `seerr-harness` workspace is a clean, separate repository for running
queue or Fresh checkouts against isolated local configuration and real services.
Keep it outside the Seerr source repository and outside hosted CI.

## Immediate next actions

1. Review and merge the image-publication workflow through a PR targeting
   `downstream-main`.
2. Authenticate the first versioned GHCR package tags, manifest annotations, and
   digest.
3. Verify Dockhand detection of a changed `custom` digest and inspect which OCI
   metadata/release links it actually presents.
4. Prove NAS deployment and rollback using recorded immutable digests.

## Deferred

- Fresh transplant.
- Direct/on-demand Download Sync refresh.
- Automated upstream detection and sync-PR creation.
- Stable downstream image channel.
- Richer release provenance/changelog.
- Automated canary and rollback.

Do not infer completion from roadmap intent. Reauthenticate repository settings,
workflow state, branch protection, image digests, and deployment state at each
boundary.
