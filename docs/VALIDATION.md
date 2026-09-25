# Validation architecture

This document owns the Seerr downstream validation contract. Validation proves
the reviewed source state; it does not grant publication, merge, release, image,
or semantic-resolution authority.

## Authority model

Validation has two distinct layers:

1. **Local feedback** gives fast, bounded information before publication.
2. **Hosted pull-request validation** is the authoritative integration check for
   PRs targeting protected `downstream-main`.

Local success is never reusable hosted authority. Hosted success applies only to
the exact GitHub PR head/check context that produced it. A changed head, branch,
repository, or required-check context requires validation again.

The stable required job name is `Downstream validation`. Branch protection and
GitHub remain responsible for deciding whether that check authorizes merge.

## Full Seerr contract

Authoritative hosted validation uses the repository's pinned Node and pnpm
expectations and runs:

```text
pnpm install --frozen-lockfile
node bin/check-i18n.js
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
workflow inventory verification
git diff --check
```

The sequence must use existing package scripts rather than duplicate their
implementation. Frozen installation authenticates the lockfile contract.
Translation, formatting, lint, type, unit-test, and production-build failures are
real validation failures and propagate non-zero.

Workflow inventory verification compares `.github/workflows/` with the reviewed
downstream inventory. An upstream workflow addition, removal, or rename fails
until its mutation/publication safety is explicitly reviewed and the inventory
is deliberately updated.

## Local feedback

The adapted local validator exposes bounded Fast feedback and explicit Full
diagnostics. Fast should select only checks whose cost and meaning are known for
the changed scope. It must not claim complete hosted coverage or silently expand
into an unrelated broad suite merely because classification is uncertain.

Full is explicit and mirrors the authoritative command contract where practical:

```powershell
.\scripts\validate-local.ps1 -Level Full
```

Local platform differences must not replace hosted semantics. In particular,
the translation check is `node bin/check-i18n.js`, matching hosted validation;
an extraction-and-diff substitute that fails only because of Windows filesystem
ordering is not the authority.

Focused tests supplied by prepare-pr or the upstream resolver are additional
feedback. They never remove `pnpm test` from hosted Full validation. Missing or
malformed explicitly requested tests fail rather than reporting a false pass.

## Snapshot and mutation safety

Prepare-pr binds local feedback to the reviewed working/index/tree state and
checks that validation did not silently change it. If formatting or another tool
rewrites a file, publication stops so the operator can review the new snapshot.

Validation must not:

- stage or commit changes as a side effect of success;
- push a branch or create/update a PR;
- mint publication credentials;
- modify repository settings;
- publish an image; or
- convert a managed Draft into Ready or merged state.

Autofix-capable tools may be useful local feedback, but their modifications are
new work requiring review and a fresh validation pass.

## Upstream-resolution validation

Managed attention Drafts retain two independent requirements:

- focused semantic tests prove the behavior deliberately changed or preserved
  during resolution; and
- the resulting PR still receives complete hosted `Downstream validation`.

The resolver authenticates any machine-readable focused-test handoff against the
exact PR number, episode, managed branch, and test targets. A missing handoff may
use a conservative deterministic fallback only when the adapted implementation
can prove it does not reduce coverage. Wrong, stale, partial, or foreign bindings
fail closed.

Passing tests do not replace review of `REVIEW` paths, conflict semantics, native
upstream ancestry, exact parent/tree identity, or human Draft readiness.

## Delivery boundary

The downstream image workflow is not validation authority. It runs only after
reviewed state reaches protected `downstream-main` and independently
authenticates its repository/ref publication boundary. Validation does not
publish GHCR packages, tags, Releases, Pages, Helm artifacts, or other delivery
outputs.

No Mosaic Android, Gradle, APK, signing, Development, Stable, Hold, or release-
promotion concept belongs to Seerr validation. Those were separate Mosaic
delivery authorities, not generic source-validation guarantees.

## Failure and recovery

Failures remain non-zero and actionable. Recovery fixes the underlying source,
environment, dependency, or reviewed inventory state and reruns validation. It
does not suppress checks, reuse stale success, weaken branch protection, or
reinterpret a tool crash as a pass.

When hosted and local results differ, hosted pull-request validation is the
integration authority. Local tooling should then be corrected to mirror the
hosted contract where the difference is deterministic and portable.
