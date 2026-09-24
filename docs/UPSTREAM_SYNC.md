# Repository and upstream synchronization policy

This document is the operating contract for observing, classifying, publishing,
and resolving upstream Seerr changes. It adapts Mosaic's current authority model
without granting new automation authority.

The copied Mosaic implementation is not operational in Seerr until its exact
repository, branch, policy, validation, and presentation identities have been
adapted and tested.

## Repository topology

- maintained fork: `constbogdan/seerr`;
- protected product branch: `downstream-main`;
- official upstream: `seerr-team/seerr`;
- official upstream branch: `develop`.

`downstream-main` receives changes through reviewed pull requests. Upstream
contribution branches remain based directly on `upstream/develop`; downstream
product work and sync candidates target `downstream-main`.

No repository alias, redirect, owner-only match, fork, casing variant, or
operator-supplied arbitrary target is trusted.

## Hosted Observe and Publish authority

Hosted synchronization is split into two jobs with separate authority.

### Observe

Observe has read-only repository and pull-request access. In a disposable,
isolated Git repository it:

1. authenticates the exact downstream repository and protected ref;
2. fetches exact `origin/downstream-main` and `upstream/develop` tips;
3. proves upstream ancestry has not been rewritten relative to retained
   observations;
4. classifies the complete incoming range;
5. constructs and authenticates the deterministic candidate without pushing;
6. inspects existing managed branches and PR decisions; and
7. emits a complete, versioned observation artifact and bounded job summary.

Observe cannot push, create or update a PR, mint a publication credential, or
publish an image.

### Publish

Publish begins with read-only authority. It consumes Observe's exact handoff,
then independently repeats observation and refuses if repository, upstream,
downstream, branch, candidate, existing PR, or blocking PR state drifted.

A repository-scoped GitHub App token may be minted only for outcomes that need
candidate branch or PR publication. It is limited to the authenticated
`constbogdan/seerr` repository and the minimum Contents and pull-request write
permissions. Waiting, no-delta, excluded, malformed, ambiguous, and failure
states cannot acquire publication authority.

Publish owns the final operator-facing result. It never merges a PR, marks a
Draft Ready, enables auto-merge for a managed attention Draft, bypasses branch
protection, publishes an image, or mutates unrelated GitHub state.

## Classification and candidate construction

Every path in the complete upstream range has one effective ownership class:

- `FOLLOW`: accept the upstream path when current downstream has not diverged;
- `REVIEW`: require semantic review before accepting the result;
- `DOWNSTREAM-OWNED`: preserve the downstream bytes or approved absence.

The checked-in ownership policy is the machine contract. Unknown automation and
workflow paths default to `REVIEW`. A normally followed path that has also been
changed downstream becomes `REVIEW`; silent overwriting of downstream work is
not allowed. Rename boundaries and path additions/deletions are classified as
complete Git changes rather than as filename-only guesses.

Seerr-sensitive downstream policy includes the downstream-owned maintenance,
validation, image-publication, and workflow-inventory surface. Inherited
upstream workflows remain source-identical under the established Strategy C
model; an upstream workflow change is therefore review-sensitive and also
requires external enable/disable-state review.

Textually clean candidates are native two-parent Git merges with exact parents:

```text
[current downstream-main, recorded upstream/develop]
```

If Git reports textual conflicts, automation publishes only a deterministic
single-parent review workspace based on the downstream commit. It records the
exact upstream/downstream/baseline/policy/conflict identity but does not claim
upstream ancestry. Only the resolver may complete the reviewed native merge.

## Managed PR outcomes

- A clean `FOLLOW` candidate may be a normal managed PR, subject to required CI
  and human repository policy. Hosted sync itself does not merge it.
- `REVIEW` or textual conflict creates or reuses a human-controlled Draft.
- The same deterministic SHA pair is reused rather than duplicated.
- A newer observation with the same semantic episode reuses the same proven
  Draft and preserves human descendant commits.
- A distinct unresolved episode waits on exactly one authenticated older
  managed open PR.

`waiting_on_existing_pr` is successful expected waiting only when the blocker's
PR number, repository, base, managed branch, exact live head, candidate history,
and episode identity are authenticated. Observe retains the complete newer
observation. Publish reauthenticates the blocker, mints no App token, and performs
no branch or PR mutation.

Multiple candidates, malformed evidence, a foreign PR, head drift, missing
ancestry, rewrite uncertainty, unexpected merge failure, or GitHub/API
infrastructure failure remains red.

## Publication and recovery

Candidate branches use deterministic identities derived from the exact upstream
and downstream SHA pair. Publication is fast-forward-only. Existing different
work is preserved and refused; force push is never offered.

The lifecycle is safely rerunnable:

- repeated observation of the same state produces the same candidate identity;
- an existing matching branch or PR is authenticated and reused;
- if a run pushed the deterministic branch but failed before PR creation, a
  later run authenticates that exact branch and completes PR creation;
- partial or interrupted publication never authorizes overwriting divergent
  remote state; and
- closed PR decisions are not silently reopened or duplicated.

## Semantic resolution

`scripts/resolve-upstream.ps1` is the only supported local entry point for an
attention Draft. It authenticates the live PR, complete retained observation,
episode, branch, exact head, candidate ancestry, upstream/downstream SHA pair,
classification range, attention paths, and current CI state before preparing a
resolution workspace.

Human changes already present on the Draft are preserved only when the live head
is a proven descendant of the original candidate and its extension remains
inside the authenticated review scope.

If `downstream-main` moved, the resolver requires a later successful hosted
outcome that explicitly binds the exact existing Draft to current main. It then
reviews reconciliation separately:

```text
B = [live Draft head, current downstream-main]
R = [B, recorded upstream]
```

If current main is already contained by the Draft, the redundant reconciliation
commit is not invented. In every case, final upstream ancestry, parent order,
tree, Draft identity, and fast-forward relationship are reauthenticated before
publication.

The resolver never guesses conflict semantics. It prepares a bounded handoff,
requires meaningful focused tests for behavior changed or preserved, and invokes
prepare-pr only after explicit publication approval. See
[upstream resolution decisions](UPSTREAM_RESOLUTION_DECISIONS.md).

## Validation and image boundary

Every sync PR targets `downstream-main` and receives authoritative
`Downstream validation` as described in [validation architecture](VALIDATION.md).
Passing CI does not replace semantic review or Draft readiness authority.

Upstream synchronization never publishes a Docker image. The downstream image
workflow may run only after reviewed state lands on protected
`downstream-main`; its repository/ref guards and digest reporting remain a
separate delivery authority.

## Required external configuration

Before hosted mutation is enabled, operators must verify:

- the GitHub App is installed only for the intended repository;
- its permissions are limited to repository metadata plus Contents and pull
  requests needed for publication;
- App client ID and private key are stored in the expected variable/secret;
- Actions default token permissions remain read-only;
- `downstream-main` protection requires `Downstream validation`;
- unsafe inherited workflows remain disabled externally; and
- the workflow inventory matches the reviewed checked-in list.

External configuration is not inferred from source. Drift is an operator-visible
failure, not a reason to weaken source authentication.

## Failure policy

Expected authenticated human-review waiting is green. Authentication,
integrity, ambiguity, ancestry, publication, or infrastructure failure is red.
Diagnostics must remain bounded and sanitized: no token, credential-bearing URL,
control sequence, or unbounded command output may enter retained evidence.

No failure path permits force push, direct merge, silent conflict choice, Draft
readiness mutation, image publication, or replacement of human-reviewed work.
