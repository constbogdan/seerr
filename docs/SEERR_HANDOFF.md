# Seerr downstream handoff

## Current checkpoint

Establish the safe downstream workflow boundary before adding downstream features
or publishing images.

- Repository: `constbogdan/seerr`.
- Upstream: `seerr-team/seerr`, branch `develop`.
- Audited live upstream tip: `794743a45f17e3d6aba06d68e1716e8b15146673`.
- `origin/downstream-main`: `794743a45f17e3d6aba06d68e1716e8b15146673`.
- Current branch: `chore/downstream-workflow-guards`, based at the same SHA.
- Working tree before these documents: 14 modified inherited workflow files;
  those edits are temporary bootstrap guards and are not the permanent model.
- `.github/workflows/downstream-validation.yml` now defines the read-only
  `Downstream validation` job and checks the expected workflow inventory. It has
  not yet received hosted acceptance or been configured as a required check.

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

The prototype is in `C:\Projects\Wholphin\seerr-discovery` on `feature/fresh` at
`a3dbbd94a654dcf9f4273d7ba754f66c6d71d799`. It contains tracked and untracked
work and was observed 18 commits behind the audited `upstream/develop`. Preserve
that workspace. Transplant it only after the downstream foundation exists, using
reviewable commits and focused tests.

### Local harness

`C:\Projects\Wholphin\seerr-harness` is a clean, separate repository for running
queue or Fresh checkouts against isolated local configuration and real services.
Keep it outside the Seerr source repository and outside hosted CI.

## Immediate next actions

1. Review the temporary workflow guards, downstream validation, and continuity
   documents.
2. Merge the guarded bootstrap through a PR targeting `downstream-main` and
   authenticate the first hosted `Downstream validation` result.
3. Make `downstream-main` the default branch and let GitHub register workflows.
4. Disable and reauthenticate unsafe inherited workflow states.
5. Require the stable downstream validation check in branch protection.
6. Restore all inherited workflow files to exact upstream content.
7. Implement `downstream-image.yml`, then prove GHCR and Dockhand/NAS rollback.

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
