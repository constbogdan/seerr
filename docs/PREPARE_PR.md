# Safe pull-request preparation

`scripts/prepare-pr.ps1` is Mosaic's publication command. Codex and repository tooling must not invoke it merely because work appears complete. Running it, or explicitly instructing Codex to run it, is the user's **READY TO PUBLISH** decision. For an ordinary non-Draft PR, that authorization also asks GitHub to merge the exact published head automatically after repository protection succeeds. Upstream attention Drafts retain a separate human **READY TO MERGE** decision.

Prepare-pr accepts exactly `constbogdan/Mosaic` as `origin`. Lookalikes, different owners, forks,
the retired pre-rename identity, malformed identities, and casing variants are refused. Every `gh`
target is derived from the exact origin identity after that check.

The current workflow is described below. The original PR #9 integration and later acceptance
records are historical evidence in [the handoff](CODEX_HANDOFF.md), not a prerequisite for using
the command. See [validation architecture](VALIDATION.md) for the authoritative hosted contract.

## Normal autonomous workflow

From a purpose-specific branch rooted in current `origin/main`:

``` powershell
.\scripts\prepare-pr.ps1
```

After that one publication authorization, the script performs preflight, audits the complete eventual PR scope, runs cheap local feedback, verifies snapshot stability, stages only the exact scope, verifies the staged tree, generates a Conventional Commit title, commits, verifies the committed tree, safely pushes, and delegates existing-PR lookup or PR creation to authenticated GitHub CLI. It then authenticates the exact ordinary PR and published head and asks GitHub to enable native merge-commit auto-merge. Authoritative integration validation and merge timing remain owned by GitHub. The script does not ask routine scope, local-check, stage, title, commit, push, PR, or merge questions when policy provides one safe answer.

A clean branch that is already ahead of `origin/main` is also valid publication input. Prepare-pr
audits every branch-only commit and changed path as the complete PR scope, records the exact existing
`HEAD` and `HEAD^{tree}`, and skips local checks, staging, and commit creation that apply only to
uncommitted content. It then applies the same ancestry, remote-divergence, no-force, and PR-reuse
checks before publication. It never creates an empty commit or amends the reviewed commits. A clean
branch equal to `origin/main` still refuses because it has nothing to publish; any working-tree or
index change keeps the normal reviewed validate/stage/commit path. Committed-only publication always
uses the complete branch diff, so `-Files` and `-Exclude` do not apply.

Supply actual focused JVM test patterns when a narrower known seam is useful:

``` powershell
.\scripts\prepare-pr.ps1 -TestFilter '*RelevantTest*'
```

Fast is the autonomous default. It runs changed-scope pre-commit, one narrow existing offline-tooling mapping when one applies, explicitly supplied focused JVM tests, and the cheap whitespace check. If multiple tooling mappings would expand to `test_*.py`, Fast defers that complete suite to authoritative PR CI. A high-risk or unmapped path likewise does not make normal preparation run a broad local fallback. Explicit patterns remain local feedback, not reusable authority. The canonical distinction between local feedback and hosted authority is in [validation architecture](VALIDATION.md).

Full remains available as an explicit diagnostic or on-demand regression command, but it is not a normal publication prerequisite:

``` powershell
.\scripts\prepare-pr.ps1 -Level Full
```

Resolved upstream-sync branches still require meaningful explicitly derived JVM filters before publication. Prepare-pr runs that focused Fast feedback once; the upstream PR is forced through authoritative hosted Full. It does not repeat the former local Standard-then-Full sequence.

The committed-only shortcut does not bypass native upstream safeguards. A clean upstream-sync
branch must use the existing preserved-merge identity arguments; it continues through focused local
feedback and the parent/tree/Draft checks instead of taking the ordinary committed-only skips.

## Authority and safety boundaries

Publication starts only from an explicit user instruction such as “prepare the PR,” “publish this,” or an unambiguous equivalent. Passing tests or an agent's belief that work is ready is not authorization. Once authorized, the normal successful path has no further interaction before a PR exists.

It never resets, restores, cleans, stashes, force-pushes, merges, or deletes branches/worktrees. It refuses protected `main`, detached HEAD, active Git operations, unmerged paths, unexpected remotes, branches not descended from current `origin/main`, out-of-scope dirty work, ignored/local artifacts, stale validation state, staged-snapshot drift, and publication requiring a force push.

In a dedicated task worktree, one coherent non-ignored dirty set is selected automatically. Existing branch-only commits, tracked changes, legitimate new files, deletions, and mode/type changes all form the eventual PR scope. `-Files` and `-Exclude` remain advanced exact-scope controls; any remaining out-of-scope dirty path causes a refusal. Use a separate worktree rather than asking automation to guess ownership.

## Resumable state and advanced phases

Human-readable state is stored at the Git path `.git/wholphin-prepare-pr-state.json` (or the worktree-specific equivalent). It records only data needed to preserve the otherwise unreconstructable reviewed scope/tree boundary across diagnostic phases: branch/base/HEAD, already committed PR paths and commits, confirmed candidate paths, their publication union, intended snapshot hash, local-check level, staged snapshot/tree hashes, approved title, and completed phase. It is not validation authority. A changed branch, base, HEAD, working snapshot, or index invalidates the relevant phase.

Each invocation creates one ignored run directory under `.logs/prepare-pr/<run>/`, including
`prepare-pr.log`, a summary, and per-stage logs. The obsolete repository-root compatibility log is
no longer written because it had no runtime consumer. Guided success output shows the six phase
start/result lines, duration, one scope/classification line, concise diff statistics, commit title,
PR create/reuse result, native auto-merge state, pending required CI, expected hosted validation
path, and the final run-log location. Complete Git identities, remote/ref diagnostics, hashes, path
inventories, and command output remain in the logs.

Supporting terminals receive OSC 8 `[log]` links on stage-start lines to exact stage logs and
`[open]` links to the PR. PASS/FAIL lines do not repeat the stage link.
Redirected or unsupported terminals instead show the stage-log filename and full PR URL; the final
`.logs/prepare-pr/<run>` location is always printed. Failure output keeps the semantic refusal reason
and relevant stage-log location visible. ANSI/OSC presentation is never written into the forensic
logs. Logs are diagnostic and non-authoritative, and never contain credentials, tokens, environment
dumps, or PR-body contents.

Advanced diagnostic commands remain available after an intentional stop:

``` powershell
.\scripts\prepare-pr.ps1 -Phase Audit
.\scripts\prepare-pr.ps1 -Phase Validate -TestFilter '*RelevantTest*'
.\scripts\prepare-pr.ps1 -Phase Stage
.\scripts\prepare-pr.ps1 -Phase Commit -Title 'chore: describe the reviewed change'
.\scripts\prepare-pr.ps1 -Phase Publish
```

The advanced phase/state interface does not define normal usage and is not a custom rollback engine. Recovery must use safe Git-native inspection and corrective operations without resetting, restoring, cleaning, or stashing unrelated work.

## Local checks and autofixes

Prepare-pr uses the shared classifier only to select useful local Fast feedback. It does not claim that feedback is the authoritative PR policy and does not fall back to all offline tests or Android Full merely because local mapping is incomplete. Explicit meaningful filters are supported and required for resolved upstream candidates. Local checks run before real staging and are bound to a read-only, Git-filter-aware identity of each intended working entry, including mode, object type, object ID, and deletion state.

Selected pre-commit hooks may apply autofixes. The normal Fast path uses changed-scope checks; explicit Full uses the repository-wide baseline and complete local graph. If any local check changes a file, prepare-pr stops without staging, reports the dirty paths, and requires review followed by a new Audit/Validate pass. Formatter changes are never silently included.

On managed Windows systems, local validation launches pre-commit through the selected trusted Python
interpreter with `-m pre_commit` rather than the generated `pre-commit.exe`. The pinned EOF and
trailing-whitespace hooks likewise invoke their exact `pre_commit_hooks` v6.0.0 modules through the
hook environment's Python interpreter. This preserves the same pinned configuration, autofix and
failure semantics used by hosted pre-commit while avoiding generated console-script launchers that
Windows Application Control may refuse. Machine policy is not weakened and cache executables are not
allowlisted.

## Publishing and GitHub CLI

The first push uses `git push -u origin <branch>`; subsequent pushes use ordinary fast-forward `git push`. Remote divergence is refused and force push is never offered.

Authenticated `gh` is required. The script checks `gh auth status` before pushing, reuses an existing open PR, or creates one with a factual generated title/body. Missing or unauthenticated `gh` stops before push with setup guidance; after setup, resume the already verified local commit with `.\scripts\prepare-pr.ps1 -Phase Publish`. There is no parallel PowerShell GitHub API or manual compare-URL fallback.

The generated ordinary PR body leads with the approved change title and a compact scope line
(`N files`, release relevance and validation risk). Review-sensitive paths stay prominent; the
complete confirmed path inventory is retained in a collapsed section. The body also states the
already-selected hosted validation path, pending required check, local-feedback status, and whether
the current classification requires a Development APK. Protected main still rechecks release
eligibility independently. This is presentation only: the complete publication scope and all tree,
staging, mutation, PR-head and no-force checks are unchanged.

PR #72 live-validated this body with `Scope: 9 files · tooling-only · high risk`. Application/UI
implications and review-sensitive paths were visible, confirmed paths were collapsed, and the
expected `NON_ANDROID` path plus release consequence were explicit. Required CI ran changed-range
pre-commit and the complete offline tooling suite without Android validation; native auto-merge
waited for it. Protected main authenticated the exact PR evidence, reused it in about 10 seconds,
then independently reported `No build required` and skipped Development Build/Sign/Publish.

For an ordinary PR, prepare-pr requires one unambiguous open non-Draft PR and authenticates its repository, base branch, head repository/branch, exact reviewed head SHA, and current auto-merge state. It confirms that repository auto-merge and merge commits are enabled, rereads the PR immediately before mutation, and invokes:

``` powershell
gh pr merge <number> --repo <exact-authenticated-repository> --auto --merge --match-head-commit <reviewed-head>
```

The expected-head guard binds authority to the reviewed commit. A changed, foreign, stale, Draft,
closed, merged, wrong-base, wrong-branch, or ambiguous PR is refused. Existing matching auto-merge is
idempotent success only when its method is `MERGE`. The command never uses `--admin`, never requests
an immediate bypass merge, and never changes repository settings. If `Allow auto-merge` is disabled,
the PR remains open and the operator must explicitly enable that repository setting before rerunning
`-Phase Publish`.

Merge-commit mode preserves the normal two-parent final-main shape used by exact-tree PR evidence.
GitHub still waits for branch protection and `CI / Full validation`; if the base moves or final tree
cannot be authenticated, protected main retains its complete fail-safe validation fallback.

Preserved upstream REVIEW/conflict publication is deliberately excluded. Prepare-pr reauthenticates
and updates the same Draft but neither enables auto-merge nor changes Draft readiness. Human semantic
review and merge/reject authority remain mandatory for that path.

An upstream Draft reconciled after unrelated `main` movement uses the separate
`-PreserveReconciledUpstreamMerge` contract. It requires exact original candidate, pre-publication
remote Draft head, current main, reconciliation commit, final upstream parents, and reviewed final
tree identities. The reconciliation is either exact `[Draft head, current main]` or current main is
already contained by the Draft head; the final merge remains exact `[reconciliation, recorded
upstream]`. Main/head drift refuses before the same no-force fast-forward push, and the Draft remains
excluded from auto-merge.

Public fork PRs are also outside prepare-pr's auto-merge authority. The script requires an exact
downstream-owned PR head, so a foreign/fork head cannot pass authentication and Mosaic automation
does not arm it. A contributor without repository write permission cannot independently enable
GitHub-native auto-merge; a maintainer may deliberately enable or perform merge subject to repository
protection. Fork PR CI remains unprivileged and its policy artifact is not reusable protected-main
authority, even when correctly named. After a maintainer accepts the contribution into protected
`main`, complete main validation runs before normal Development eligibility; Stable authorization
remains separate.

Prepare-pr does not wait or poll, bypass checks, rewrite a failed PR, or delete branches/worktrees.

## After merge

From a clean working tree, update the local integration branch safely:

``` powershell
git switch main
git pull --ff-only origin main
```

Local/remote branch and worktree deletion remains manual and outside prepare-pr.

## Portability

Other downstream repositories should reuse this UX and safety contract, not Mosaic's implementation details. Seerr likely retains `develop` as its protected integration branch and must supply its own pnpm/Node/Docker validation, integration baseline, high-risk paths, workflow guards, artifacts, and release policy before adapting the flow. Its `origin/develop` versus `upstream/develop` divergence must first be deliberately reconciled.

## Current boundary

Prepare-pr owns repository/worktree safety, complete-scope audit, cheap local feedback, exact staging, actionable Git diagnostics, Git index/tree identity, safe ordinary push, exact PR/head authentication, and the native auto-merge request through `gh`. Authoritative validation, durable PR status, protection enforcement, merge execution, notifications, and post-publication recovery belong to GitHub. Upstream Draft review and merge/reject remain human-owned.

Keep this adapter thin and autonomous after authorization, using `gh` as the standard GitHub interface. Hosted clean upstream candidates do not call prepare-pr; resolved Draft candidates use it only for the focused semantic check and exact native-merge publication boundary. The normal flow is implementation, optional focused local feedback, prepare-pr, then authoritative GitHub PR validation. Full remains an explicit diagnostic/on-demand command.
