# Safe pull-request preparation

`scripts/prepare-pr.ps1` is the downstream publication command for
`constbogdan/seerr`. Running it, or explicitly directing an agent to run it, is
the operator's **READY TO PUBLISH** decision. Passing tests or an agent's belief
that work is ready is not publication authority.

This document preserves the Mosaic publication contract for Seerr. The copied
implementation must not be used until its repository, branch, validation, and
presentation constants have been adapted and its Seerr tests pass.

## Repository authority

Prepare-pr accepts only this topology:

- downstream repository: `constbogdan/seerr`;
- protected base: `downstream-main`;
- upstream repository: `seerr-team/seerr`;
- upstream branch: `develop`.

The exact `origin` identity is authenticated before any GitHub target is used.
Lookalikes, forks, casing variants, malformed identities, unexpected push URLs,
and other owners or repositories fail closed.

## Ordinary pull requests

From a purpose-specific branch descended from current
`origin/downstream-main`, the normal command is:

```powershell
.\scripts\prepare-pr.ps1
```

After explicit authorization, prepare-pr:

1. authenticates repository, branch, base, remotes, worktree, and Git state;
2. audits the complete eventual PR scope;
3. runs bounded local feedback appropriate to that scope;
4. proves the reviewed snapshot did not change;
5. stages and commits only the authenticated scope when uncommitted work exists;
6. refuses stale base state or divergent publication that would require force;
7. pushes by normal fast-forward Git publication;
8. creates or reuses exactly one downstream-owned PR;
9. reauthenticates the PR repository, base, branch, and exact head; and
10. requests GitHub-native merge-commit auto-merge for that exact head.

GitHub remains merge authority. Prepare-pr never directly merges, bypasses
branch protection, uses `--admin`, changes repository settings, or treats local
validation as permission to integrate. Native auto-merge waits for the required
`Downstream validation` check and any other configured protection.

A clean branch already ahead of `origin/downstream-main` is valid input. Its
complete branch diff and commits are the publication scope; prepare-pr does not
amend them or create an empty commit. A branch equal to the base has nothing to
publish and is refused.

## Local validation feedback

Fast local feedback is intentionally distinct from hosted authority. Full local
validation remains an explicit diagnostic:

```powershell
.\scripts\prepare-pr.ps1 -Level Full
```

The Seerr Full contract is:

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

Focused tests may be supplied through the adapted Seerr test-filter interface.
They are additional local feedback, not a substitute for hosted Full validation.
If a formatter or other local check changes a file, prepare-pr must stop without
silently publishing the changed snapshot. The operator reviews the change and
runs validation again.

See [validation architecture](VALIDATION.md) for the authority boundary.

## Worktree and Git safety

Prepare-pr never resets, restores, cleans, stashes, force-pushes, deletes a
branch or worktree, or guesses which unrelated dirty work belongs to the task.
It refuses:

- `downstream-main` itself or detached HEAD;
- active or unresolved Git operations;
- an unexpected repository or remote identity;
- a branch that does not descend from the authenticated current base;
- ambiguous, ignored, or out-of-scope work;
- validation, index, tree, or head drift;
- a remote branch that is ahead or divergent; and
- any publication that cannot be completed by normal fast-forward push.

Resumable state and diagnostic logs are non-authoritative. They may preserve a
reviewed scope boundary, but a changed branch, base, head, worktree, index, or
tree invalidates the corresponding phase.

## GitHub publication and recovery

Authenticated GitHub CLI access is required. Ordinary PR creation/reuse is
idempotent only when exactly one open PR matches the authenticated downstream
repository, base, branch, and reviewed head.

The native auto-merge request must use merge-commit mode and an expected-head
guard equivalent to:

```powershell
gh pr merge <number> --repo constbogdan/seerr --auto --merge --match-head-commit <reviewed-head>
```

If auto-merge is disabled or GitHub refuses the request, the PR remains open.
The tool reports the refusal and does not attempt an immediate merge or bypass.
An interrupted ordinary publication is resumed by reauthenticating the existing
branch and PR; it is never repaired with force.

## Managed upstream Drafts

Managed upstream attention PRs are deliberately outside ordinary auto-merge.
Prepare-pr may publish a resolver-reviewed head only after authenticating:

- the same open Draft PR number;
- the managed branch and exact pre-push Draft head;
- the episode and original candidate identity;
- current `downstream-main`;
- recorded upstream identity and native ancestry;
- exact merge parents and reviewed tree; and
- fast-forward safety.

When `downstream-main` moved after the Draft was created, the resolver preserves
the same Draft and separately authenticates reconciliation. The reconciliation
is either exact `[Draft head, current downstream-main]` or current main is
already contained by the Draft. The final reviewed upstream merge remains exact
`[reconciliation, recorded upstream]`.

After push, GitHub may briefly report the authenticated old Draft head.
Prepare-pr may retry for a short bounded interval only while that exact old head
is observed. Success requires the exact reviewed head. Any third SHA or timeout
fails closed.

Prepare-pr does not mark a managed attention Draft Ready, enable auto-merge for
it, merge it, replace it, or rewrite its history. Human semantic review and the
Ready/merge/reject decision remain mandatory.

## After integration

Update a clean local product branch without rewriting it:

```powershell
git switch downstream-main
git pull --ff-only origin downstream-main
```

Branch and worktree cleanup remains a separate manual action.

## Responsibility boundary

Prepare-pr owns local repository safety, complete-scope review, snapshot and
tree identity, normal fast-forward publication, exact PR authentication, and
the ordinary native auto-merge request. GitHub owns authoritative PR validation,
branch protection, merge execution, and durable PR state. The upstream resolver
owns authenticated semantic-resolution handoff; humans own managed Draft
readiness and merge/reject decisions.
