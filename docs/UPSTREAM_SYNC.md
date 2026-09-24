# Repository and upstream synchronization policy

This document is the current operating authority for upstream ownership, observation, candidate
publication, semantic resolution, and failure behavior. Historical sync episodes and implementation
acceptance remain below as evidence; they do not create alternate procedures.

## Current hosted lifecycle and authority

Scheduled or manual **Observe** runs read trusted Mosaic `main`, authenticate
`damontecres/Wholphin`, classify the complete incoming range as `FOLLOW`, `REVIEW`, or
`DOWNSTREAM-OWNED`, and emit a versioned evidence handoff. **Publish** independently reobserves and
reauthenticates the exact inputs before it owns the final operator outcome. It creates or reuses the
deterministic `wholphin-upstream-*` candidate only when the authenticated state authorizes that
mutation.

- `FOLLOW` produces a normal native-ancestry PR, still subject to required CI and review.
- `REVIEW` or a textual conflict produces/reuses a human-controlled Draft. The authenticated
  `resolve-upstream.ps1` lifecycle is the semantic-resolution entry point; it preserves reviewed
  parent/tree identity and never makes the Draft ready or merges it.
- `DOWNSTREAM-OWNED` preserves Mosaic's exact bytes or approved absence while retaining evidence of
  the incoming upstream change.
- `waiting_on_existing_pr` is green only for exactly one fully authenticated older managed open
  candidate. Observe retains the newer observation; Publish reauthenticates the blocker and reports
  waiting without minting an App token or mutating a branch or PR.

Unknown automation paths default to review. Ambiguity, multiple candidates, head/ref drift,
malformed evidence, ancestry/rewrite uncertainty, API/infrastructure failure, or any authentication
failure remains red. No force push, automatic conflict resolution, direct main mutation, Draft
readiness change, or merge authority exists. The GitHub App token is minted only after the exact
repository/state checks that authorize candidate publication, is limited to Contents and pull
requests, and is never available to Observe or waiting/no-delta paths.

Ordinary PR mechanics are owned by [prepare-pr](PREPARE_PR.md), and authoritative integration
checks by [validation architecture](VALIDATION.md). Passing validation never replaces semantic
review of upstream changes.

This document is the authoritative policy for branch use and synchronization of Mosaic with Wholphin upstream.

## Remotes and integration baseline

- `origin` is authenticated as exactly `constbogdan/Mosaic`; no other owner/name, including the
  retired pre-rename identity, is trusted for current operation.
- `upstream` is `damontecres/Wholphin`, the original Wholphin project.
- `origin/main` is the known-good integration branch: upstream Wholphin plus our validated enhancements.

`main` must remain buildable and validated. Do not perform active development directly on it. Update local `main` from `origin/main`, then create a purpose-specific branch.

R4 removed the temporary downstream repository-name bridge. Upstream remains exactly
`damontecres/Wholphin`; managed `wholphin-upstream-*` markers and human-controlled Draft authority
are unchanged. The App token targets `constbogdan/Mosaic` only after the workflow and hosted
implementation authenticate that exact current identity.

## Branch classes

- `main`: known-good integration baseline; receives changes through pull requests and is the base for new work.
- `feature/<name>`: product work, such as `feature/watchlist`, `feature/collections`, or `feature/discovery-sources`.
- `fix/<name>`: focused correctness or regression fixes.
- `chore/<name>`: repository, tooling, and maintenance work, such as `chore/ci` or `chore/repository-policy`.
- `chore/sync-upstream-YYYY-MM-DD`: dedicated upstream integration branch created from current validated `main`.
- `chore/sync-upstream-<full-upstream-SHA>-<full-downstream-SHA>`: deterministic hosted candidate for one exact input pair; see the hosted v2 section.

Normal development follows:

```text
main
  -> feature/fix/chore branch
  -> implementation
  -> focused validation during development
  -> user explicitly authorizes publication
  -> autonomous prepare-pr audit and cheap local feedback
  -> exact stage / commit / push / PR via gh
  -> required GitHub risk-tiered PR validation
  -> user reviews completed PR and decides merge / reject
  -> update local main
```

Use the validation policy in [AGENTS.md](AGENTS.md#validation-workflow). Local commands provide developer feedback; required PR CI is authoritative. Resolved upstream work keeps one meaningful focused local JVM pass, while every upstream PR is forced through hosted Full.

## Manual upstream synchronization

This section describes the existing workstation recovery/manual path. The separate
[hosted path](#hosted-upstream-synchronization-v2) prepares a candidate without
workstation validation and relies on required PR CI before human merge/reject.

Never merge `upstream/main` directly into our `main`. Use this sequence:

```text
update local main from origin/main
  -> fetch upstream
  -> create chore/sync-upstream-YYYY-MM-DD from main
  -> merge upstream/main
  -> resolve conflicts deliberately, if any
  -> inspect high-risk auto-merges
  -> complete the native merge commit after semantic review
  -> user explicitly authorizes publication
  -> prepare-pr runs focused Fast feedback and publishes the sync PR through gh
  -> required authoritative GitHub Full validation
  -> user reviews and decides merge / reject
  -> update local main
```

The mechanical portion can be started from clean local `main` with:

```powershell
.\scripts\sync-upstream.ps1
```

The helper verifies the working tree and remotes, fetches `origin/main` and `upstream/main`, fast-forwards a strictly-behind local `main`, creates the dated sync branch, and runs a normal `git merge --no-edit upstream/main`. It never force-resets, overwrites a branch, resolves conflicts, pushes, creates a pull request, or merges a pull request.

If Git can merge without conflicts, normal Git behavior applies: it may report already up to date, fast-forward, or create the ordinary merge commit. The helper reports the result and stops for review and validation; it does not push or open a pull request.

If conflicts occur, the helper leaves the merge in progress, lists every unmerged file, exits non-zero, and requires manual semantic resolution:

```text
inspect and resolve conflicts
  -> git add resolved files
  -> git commit
  -> user explicitly authorizes publication
  -> prepare-pr with meaningful -TestFilter (focused Fast once)
  -> required hosted Full and human PR review / merge decision
```

Do not create or merge the sync pull request if validation fails. Diagnose and correct the integration on the sync branch.

An in-progress merge must first be resolved, staged, semantically reviewed, and completed with its local merge commit; prepare-pr refuses active Git operations even when all conflict markers are gone. That local integration step does not authorize push or PR creation. After the merge is complete and the user explicitly authorizes publication, `scripts/prepare-pr.ps1` performs the mechanical preparation. It recognizes `chore/sync-upstream-*`, requires meaningful focused JVM filters, runs that Fast feedback once, and preserves the reviewed native parents/tree. This support does not resolve conflicts, select `ours`/`theirs`, replace high-risk auto-merge review, or weaken authoritative hosted Full.

## Conflict-resolution policy

Every resolution must preserve both upstream changes that should apply to us and our validated Mosaic behavior. Never mechanically choose `ours` or `theirs` unless inspection proves that one side completely supersedes the other.

For every conflict:

1. Inspect ours, upstream, and the common-base intent where useful.
2. Inspect surrounding callers and tests.
3. Preserve upstream fixes, refactors, and features that remain applicable.
4. Preserve validated enhanced behavior and architectural boundaries.
5. Remove local logic only when upstream genuinely supersedes it.
6. Avoid unrelated refactoring while resolving the merge.

`upstream/main` is the behavioral reference for deciding what Mosaic enhancements OFF means. OFF removes enhanced capabilities; it does not disable independent upstream behavior, bug fixes, UI improvements, navigation fixes, ordering fixes, or every line that our fork has changed.

Conflict-sensitive integration areas currently include:

- `SeriesViewModel.kt` and `SeriesDetails.kt`
- `HomePage.kt` and `HomeViewModel.kt`
- `DownloadsPage.kt` and `NavDrawer.kt`
- Discover request and series code
- preferences and protobuf schema
- shared strings and resources

An automatic merge is only a textual result. If both sides changed related behavior in these areas, inspect the merged semantics even when Git reports no conflict.

## Upstream-specific validation boundary

Manual synchronization and local conflict recovery retain meaningful focused feedback before
publication. Hosted conflict-free candidates need no workstation validation. Every resulting
upstream PR receives authoritative hosted Full. Neither path removes semantic review or required
runtime/device validation before merge.

Use `.\scripts\validate-local.ps1` and follow the handoff conventions in `docs/AGENTS.md`.

- Supply the narrowest meaningful JVM filters for behavior changed or preserved by semantic resolution. Prepare-pr runs them once with changed-scope hygiene and refuses any autofix or unexpected mutation before staging/publication.
- Do not run routine local Standard then Full merely to repeat the required PR gate. Explicit Full remains available for diagnosis or a separately justified comprehensive local check.
- The resulting `chore/sync-upstream-*` pull request receives the same required fork-owned `CI / Full validation` job, with unknown/sensitive integration scope conservatively selecting its Full path.
- Protected main authenticates exact PR evidence or runs its complete conservative fallback.
- If local focused feedback or hosted Full fails, keep the work on the sync branch and investigate; do not advance the pull request.

CI requires no Jellyfin, Seerr, Servarr, download-client, extension-repository, or signing credentials. It does not replace deliberate conflict resolution, high-risk auto-merge inspection, or Android TV visual/focus/runtime validation.

## Reference sync: September 2026

> Historical acceptance evidence. Current policy is defined above.

The first completed lifecycle synchronized six upstream commits through `chore/sync-upstream-2026-09-07`, followed by a pull request into our `main` and a local-main fast-forward.

Conflicts occurred in `RequestSeasons.kt`, `SeriesViewModel.kt`, and `strings.xml`. Resolution incorporated upstream localized season formatting, the `MediaReportService` to `ServerReportService` refactor, and localized season/episode resources while preserving enhanced request-season behavior, `MediaProductStateCoordinator`, acquisition/integrity projection, exact season identity, Home Acquiring, and enhanced resources. High-risk auto-merged Series and Home files were reviewed. Standard and Full validation passed before the sync pull request was merged.

This is historical evidence for the process, not a prediction of future conflict files.

## Hosted upstream synchronization v2

The Actions workflow displays **Upstream Synchronization**. Its run title distinguishes a
`Manual` or `Scheduled` check without embedding a future wall-clock time. For a candidate-producing
run, Observe records a compact authenticated handoff and Publish owns the single final operator
outcome. A no-delta or observation failure remains final in Observe because Publish does not run.
The final outcome leads with review attention or candidate readiness and a canonical direct link to
the exact downstream PR; bulk upstream history follows in a collapsible navigation section. Exact
machine evidence remains in the summaries and retained JSON; I06 identities and behavior are
unchanged.

Hosted observation loads a versioned policy from trusted downstream `main`:

- **FOLLOW**: normal integration candidate, still subject to automation/security review.
- **REVIEW**: Draft candidate requiring semantic review even when Git merges cleanly.
- **DOWNSTREAM-OWNED**: preserve Mosaic's bytes or approved absence while retaining upstream
  status/blob evidence. It never means invisible or a global `ours` strategy.

The absent `.github/workflows/main.yml` and `.github/workflows/release.yml` paths are explicit
DOWNSTREAM-OWNED policy entries. Their absence is the approved downstream state: accepted upstream
changes are still observed and recorded, but cannot resurrect the retired publishers. Baseline T0
does not currently own the release workflow's historical Appstore/Fire TV AAB distribution
capability.

Unknown `.github/**` paths and ownership-crossing renames are REVIEW. `no_delta` and
DOWNSTREAM-OWNED-only observations retain complete machine evidence without creating a candidate.
A clean FOLLOW candidate creates/reuses a normal PR. REVIEW or textual conflict creates/reuses a
Draft PR until semantic/manual work is resolved. No journal Issue duplicates the PR lifecycle.

REVIEW presentation deliberately distinguishes a Git textual conflict from a textually clean merge
that still requires semantic review under downstream ownership policy. The final Actions summary
puts those decision paths first and gives each one exact `Current Mosaic` and `Incoming upstream`
blob links derived from the authenticated downstream/upstream SHAs. This provides truthful review
navigation even when a preserved path is absent from the candidate's Files changed tab; it does not
fabricate a candidate diff. Candidate PR bodies remain quiet toward upstream and order attention,
reason, automatic FOLLOW integration, preserved downstream state, next action, then collapsed
technical provenance/history. The next action continues to be `resolve-upstream.ps1`; its generated
authenticated Codex handoff is not duplicated into the PR.

Natural hosted acceptance used a manual check against existing review candidate PR #58. Observe
displayed only `Upstream observation recorded` and explained the exact handoff to Publish. Publish
owned the single `29 upstream changes · review candidate already open` result, put REVIEW and the
exact PR #58 link first, reused the candidate without creating another PR, and showed the one
attention path `.github/workflows/pr.yml` before bulk history. Because that path is absent in current
Mosaic, the summary truthfully said `current Mosaic absent` and supplied the exact incoming upstream
blob link rather than inventing a candidate diff. It separately identified the Git textual conflict
and the trusted-policy semantic REVIEW, directed the operator through `resolve-upstream.ps1`, and
kept 1 attention / 26 FOLLOW / 2 preserved as secondary context. This closes the presentation batch
without changing I06 behavior or evidence.

PR #79 and scheduled run #47 subsequently live-validated the distinct newer-episode waiting state.
Run #47 completed green in about 35 seconds: Observe retained the complete newer observation and
bound PR #58 plus its exact authenticated head; Publish reauthenticated both, received no App
publication token, performed no push or PR mutation, and owned the final `Waiting on PR #58`
outcome. The retained evidence reported 3 attention paths, 32 FOLLOW paths, and 2
DOWNSTREAM-OWNED paths. This establishes the operational distinction: expected authenticated
human-review waiting is green, while ambiguity and authentication, integrity, infrastructure, or
API failure remain red. PR #58 predates the final candidate-body presentation and remains unchanged
under the Draft/human-authority contract; future naturally created candidates use the current
format.

An unresolved candidate is identified by trusted policy version plus the paths requiring
attention, their ownership/status and downstream blob identities, and their textual-conflict
signature. It excludes the whole downstream HEAD, so unrelated downstream movement can reuse the
same Draft without force-updating it. The exact upstream SHA/run and complete classification remain
in the PR and machine artifact. A changed attention signature, policy decision, relevant downstream
blob, or native PR disposition is materially different. Closed/rejected PRs are never reopened.

Conflict workspaces never contain unresolved indexes or conflict markers. Their deterministic
single-parent commit starts at downstream, carries safe non-conflicting changes, preserves
downstream conflict bytes, and records exact context in `.upstream-sync/blocked-context.json`.
It deliberately does not claim upstream ancestry; retries authenticate its sole parent and
context identities before reuse. Local `resolve-upstream` then authenticates the exact Draft,
recorded downstream baseline and current upstream ancestry before starting a real merge with the
recorded upstream SHA. Human/Codex resolves that active merge. The reviewed result must be a
two-parent commit whose first parent is the remote blocked Draft head and whose second parent is
the recorded upstream tip; the blocked Draft head is itself bound to the exact downstream baseline.
This parent shape lets publication fast-forward the same Draft without rewriting it. The committed
tree must equal the reviewed index and contain neither blocked context nor conflict markers.
Ready-for-review, CI, and merge/reject remain explicit human steps.

When unrelated Mosaic main movement leaves an existing same-episode Draft on an older baseline,
the Draft is actionable only after a fresh successful Upstream Synchronization outcome on exact
current `main` binds the same episode to the exact PR number, branch, and live head. The resolver
keeps the original candidate evidence separate from this reuse proof. Starting from authenticated
Draft head `C`, it reviews an exact `B = merge(C, M)` with parents `[C, M]`; if `M` is already an
ancestor of `C`, `B = C`. Only then does it resolve the original recorded upstream `U`, producing
`R` with exact parents `[B, U]`. Reconciliation conflicts and upstream semantic conflicts are shown
as separate stages. The remote remains at `C` until one reviewed, no-force fast-forward `C -> R`.

The schedule `0 6,15,21 * * *` is UTC: approximately 08:00/17:00/23:00 Bucharest in winter
and 09:00/18:00/00:00 in summer. GitHub cron does not follow DST and may start late; evidence
separates configured cron from actual observation time. Complete observations retain excluded
paths for future Repo Intelligence without modifying that system.

**CURRENT CHECKPOINT:** I06 and the later authenticated upstream waiting-state correction are
complete/hosted validated. T0-1 CP8 found no remaining functional inconsistency and closed T0-1;
the next roadmap phase is T0-2.

```yaml
Detection: OPERATIONAL
Ownership-aware observation: IMPLEMENTED + OFFLINE TESTED
Normal/Draft candidate publication: NATIVE MERGE MODEL + OFFLINE TESTED
Native FOLLOW + quiet no-delta acceptance: LIVE VALIDATED
Native lifecycle simplification: COMPLETE + OFFLINE TESTED
Authenticated older-candidate waiting: COMPLETE + HOSTED VALIDATED
```

PR #55 is the representative native live episode: observation `34701161886`, PR Full
`34701197155`, protected-main/release run `34702111274`, and follow-up no-delta run
`34702881758` proved exact parents/tree, human merge, accepted upstream ancestry, required CI,
exact-tree reuse and Development publication. REVIEW/conflict/DOWNSTREAM-OWNED/retry evidence is
still recorded only when it occurs naturally. One concurrency group still serializes runs and
never cancels an active publication.

The read job and publication job each use a fresh process-owned temporary Git
repository. Trusted helper code comes from the workflow's downstream main SHA,
outside the integration checkout. Both canonical fetch and push identities are
validated exactly before publication:

```text
origin   https://github.com/constbogdan/Mosaic.git
upstream https://github.com/damontecres/Wholphin.git
```

Only official `refs/heads/main` is fetched from upstream. Full ancestry is retained;
no application scripts, local Actions, hooks, filters, build tools or upstream code
are executed in the candidate checkout. System/global Git configuration is disabled.
The publisher repeats observation and requires the read job's exact upstream and
downstream SHA pair, then checks remote main tips immediately before publication.
Ref drift stops the run for a fresh observation; main is never pushed or modified.

### Detection, integration and deduplication

- The reviewed initial ancestry anchor is
  `1778bdb34caa699c0590232a7de709a889839765`, already contained in downstream main
  at implementation. Downstream must retain it. Upstream must descend from that
  anchor and every retained hosted PR/native candidate anchor.
- Hosted branch refs retain attempts interrupted between push and PR creation;
  hosted PR head refs retain attempted ancestry even after branch deletion.
  A missing object, rewrite or rollback
  that breaks these proofs stops for human judgment. A rejected rewrite is not
  promoted into a new trusted observation anchor.
- If upstream HEAD is already an ancestor of downstream main, succeed with
  `no_delta`: no branch, PR or comment. The run summary/JSON still records it.
- Otherwise require a single merge base and enumerate `downstream..upstream`.
  Changed paths describe merge-base-to-upstream; incoming commits exclude commits
  already reachable downstream. The comparison baseline is not a custom sync ledger.
- Branch identity is `chore/sync-upstream-<full-upstream-SHA>-<full-downstream-SHA>`.
  The dated branch convention remains for the manual helper only.
- Classify the full merge-base-to-upstream path delta before integration. FOLLOW paths
  enter a normal candidate; REVIEW paths enter a Draft even without textual conflicts;
  DOWNSTREAM-OWNED paths retain the exact downstream bytes or absence while their
  upstream status/blob evidence remains recorded. If every path is owned, emit
  `observed_excluded` without a branch, PR or fabricated upstream ancestry.
- Prepare an isolated normal Git merge without choosing ours/theirs. A clean candidate
  has exact downstream/upstream parents; REVIEW makes it Draft. Fixed parent-derived
  timestamps and metadata make retries of the same SHA pair deterministic.
- A textual conflict becomes a deterministic single-parent Draft workspace. It retains
  the clean integration context, restores downstream bytes for unresolved paths and adds
  `.upstream-sync/blocked-context.json`; it never contains markers or claims upstream
  ancestry. `resolve-upstream` authenticates that transport workspace and starts the exact native
  merge locally. Human/Codex resolution must deliberately produce the reviewed merge tree;
  `prepare-pr` runs focused local feedback, preserves that existing merge commit, and can only fast-forward the
  same Draft PR.
- Reuse an exact open PR only when its head equals the deterministic candidate.
  An open Draft carrying the same episode marker is also reused when unrelated downstream
  movement changes the exact-pair branch or continued upstream movement refreshes evidence.
  Its branch is not rewritten. Preserve human changes to existing branches or PRs; never force push.
- If exactly one older open managed sync PR is fully authenticated as its named native
  merge or blocked review workspace, a distinct current episode emits
  `waiting_on_existing_pr`. Observe retains the complete newer range and blocker identity;
  Publish reobserves the range, reauthenticates the same PR number and head, then reports
  `Waiting on PR #N` without a publication token, branch push or PR mutation. Automation
  does not stack, rebase, overwrite or auto-close PRs. Multiple, drifting, malformed or
  unauthenticated managed candidates remain hard failures.
- A closed PR for the exact pair is a human decision: do not reopen or recreate it
  automatically. A later distinct pair can be considered after older open PRs close.
  Intentional rejection of individual changes across all future upstream states is
  is not automated; reviewers must revisit prior rationale.
- A retry after successful push but failed PR creation reuses the exact remote
  branch. Different branch content fails closed. Recheck PR decisions before push.

Candidate PR text is intentionally quiet: upstream PR numbers
are plain `PR N` text, commit identities are non-autolinking short code, attention paths are
filenames, upstream-controlled subjects/titles are sanitized, and no live upstream URL or
qualified reference is emitted. The downstream Actions run remains clickable. The
Actions run summary owns rich operator navigation to upstream PRs, commits and exact upstream/
Mosaic file versions. The versioned JSON artifact owns complete exact URL/SHA/ref/object
provenance, including every changed path and ownership decision. This separation preserves
provenance and operator navigation without making routine Mosaic activity visible in upstream
Issue/PR timelines.

The generated candidate commit messages and branch names contain only fixed prose and SHA
identities. Normal FOLLOW candidates necessarily retain the original upstream commits and their
unaltered messages as ancestry. Whether GitHub re-emits cross-references when an already-known
upstream commit object becomes reachable in a fork is a separately tracked platform question;
I06 does not rewrite ancestry or upstream commit messages to suppress hypothetical activity.

### CI handoff and human semantic review

The detector does not run `validate-local.ps1` or duplicate Gradle validation.
The App-authored normal/Draft PR path targets `main` and triggers existing
`CI / Full validation`; PR #55 live-validated that exact handoff for a genuine FOLLOW delta.
CI retains repository-wide pre-commit and the full compile/test/assembly graph,
and now includes offline hosted-helper safety tests. No required-check name or
repository rule is changed. An open candidate is not a validated integration.

Human review must inspect high-risk auto-merges even without textual conflicts:
Series/Home/Downloads, navigation, Discover requests, preferences/protobuf, shared
resources, acquisition/integrity and Mosaic enhancements OFF behavior. Passing CI
does not authorize merge or substitute for this review or necessary device checks.
Textual conflicts remain blocked but now have a safe Draft workspace. Normal CI may
validate human/Codex resolution on that branch; changing Draft readiness and merge/reject
remain deliberate human actions. Ordinary Codex publication still follows `PREPARE_PR.md`.

### Resolving an attention candidate locally

Use the repository helper as the standard local entry point. With no argument it discovers open
I06 candidates and always presents a selector; direct use may supply the only operator identity:

``` powershell
.\scripts\resolve-upstream.ps1
.\scripts\resolve-upstream.ps1 -Pr 33
```

The helper verifies the repository, clean worktree (including untracked files), Git, authenticated
GitHub CLI, open I06 PR marker, exact GitHub-provided head branch and current head
SHA before switching branches. It fetches that exact remote branch and either creates a tracking
branch or reuses an existing exact, non-divergent tracking branch. It never guesses a branch,
stashes, resets, cleans, force-checks out, force-pulls, pushes or mutates GitHub. Any identity,
evidence or local-branch uncertainty is a refusal.

Trusted machine evidence comes from the latest retained I06 outcome/observation artifact when
available and is bound to candidate, repository, branch, run/attempt and candidate SHA. The durable
PR technical evidence provides the safe fallback when a retained artifact has expired.
Current PR checks provide concise CI status and the downstream run URL; brittle full-log scraping
is intentionally omitted. The helper prints an operator summary and creates the ignored local
prompt `.logs/upstream-resolution/pr-<N>/codex-prompt.md` with actual candidate, incoming
commit, attention-path, provenance and CI evidence.

The terminal does not duplicate that generated prompt. It prints only a concise instruction to
read `.logs/upstream-resolution/pr-<N>/codex-prompt.md` and carry it out exactly. The prompt requires
Codex to write the ignored ephemeral `.upstream-sync/resolution-handoff.json`, bound to the exact PR,
episode and managed branch, with the narrowest meaningful JVM test filters based on behavior
actually changed or preserved. The resolver authenticates that binding, verifies source-controlled
test targets, and refuses any handoff that removes its deterministic derived coverage floor. An
absent handoff retains the existing derived-filter fallback. Malformed, stale, or mismatched
handoffs fail closed before prepare-pr is invoked.

Compact context from completed semantic reviews is retained in the
[upstream resolution decision log](UPSTREAM_RESOLUTION_DECISIONS.md). Those entries inform future
review but never authorize reusing an old decision without evaluating the new upstream change.

The local resolver does not impose additional global serialization when multiple durable candidates
already exist. Exact attention-path overlap, shared semantic production/ownership paths, upstream
ancestry and downstream observation baselines form a deterministic dependency graph. A proven predecessor is `Ready for resolution`; a dependent is
`Waiting on PR #N`; unrelated candidates are `Independent`. Closed/satisfied candidates are
`Superseded`. Incomparable ancestry or evidence observed against an older current-main baseline is
`Dependency ambiguous` and cannot be selected. A stale same-episode Draft becomes
`Ready for current-main reconciliation` only when a retained fresh outcome authenticates exact
current main plus the exact live Draft identity. Missing/expired evidence, disagreement, head or
main drift, non-descendant Draft history, or unexplained Draft scope remains ambiguous/refused. The
local helper never rebases or overwrites a Draft.
The current hosted I06 publisher still retains its earlier one-open-sync-PR guard, so normal hosted
operation does not yet create concurrent independent candidates. Changing that hosted creation
policy is a separate explicit follow-up, not part of this local operator helper.

The helper is re-entrant rather than long-running. First use selects, checks out, writes the prompt
and exits. After semantic edits, run the same task again on the candidate branch. It refreshes the
PR, artifact, remote head, main and dependency graph; requires a normal descendant with a
non-empty resolution diff; rejects unrelated or unmapped scope; and derives focused JVM filters
from I03 mappings plus changed test classes. Filters must match source-controlled tests. The exact
scope and filters are displayed before `Ready to PUSH? [y/N]`; only explicit `y` delegates to
prepare-pr. Blank, EOF, cancellation or any drift performs no commit or push.

After that explicit authorization, `prepare-pr.ps1` updates the same existing candidate PR: its
upstream-sync branch pattern requires meaningful focused JVM filters followed by Full, its remote
check permits only a normal fast-forward push, and its PR lookup reuses the open PR by exact head
branch. It does not mark the Draft Ready. This remains conditional on the candidate descending
from current `origin/main`; if unrelated main movement makes that unprovable, prepare-pr refuses
and the operator must reconcile the candidate deliberately rather than bypassing the guard.

Merge/close state and accepted ancestry are read directly from Git and the native PR. No
`pull_request: closed` Upstream Synchronization run, journal finalizer, or terminal Issue state
exists. PR #55 proved this replacement: its obsolete finalizer failed independently after the
native integration and publication had already succeeded.

This lifecycle closure does not change ancestry policy. A conflict workspace and its ordinary
semantic-resolution commits may integrate upstream behavior without making the original upstream
commits ancestors, so GitHub can truthfully continue to show the fork behind. Preserving ancestry
would require a separately approved, tree-preserving two-parent merge commit after resolution and
validation, bound to the exact upstream range and reviewed resolved tree. Cherry-picking creates
new object identities and does not solve the behind count; rebasing or grafts rewrite or localize
history; and an unaudited `ours` merge can cause future sync detection to skip changes that were
never integrated. Until that design is implemented, do not fabricate ancestry.

### Least privilege and activation prerequisites

A read-only settings query on 2026-09-08 returned
`default_workflow_permissions: read` and
`can_approve_pull_request_reviews: false`. Repository secrets were empty.
Under the current setting, `GITHUB_TOKEN` cannot create PRs. Even when permitted,
GitHub documents approval-required PR workflow runs for token-created PRs, while
App installation tokens allow the normal unattended trigger path:
[GITHUB_TOKEN behavior](https://docs.github.com/en/actions/concepts/security/github_token).

The user confirmed external setup complete on 2026-09-09: the App then named **Wholphin Sync Bot**
was installed on the downstream repository with Contents read/write, Pull requests read/write and
Metadata read. R2 renamed its display metadata to **Mosaic Sync Bot**; the same installation follows
repository ID `1351255476` and selects `constbogdan/Mosaic` with no permission widening. Repository variable
`SYNC_BOT_CLIENT_ID` and secret `SYNC_BOT_PRIVATE_KEY` remain configured. The earlier empty-secret
result is historical.

The pinned official `actions/create-github-app-token` v3 action uses `client-id` and `private-key`,
restricts `owner`/`repositories` to `constbogdan/Mosaic` only after exact current-repository
authentication, and requests only Contents/PR write. The key is supplied only to the
token action and only when ready, REVIEW or semantic-conflict state requires a branch/PR mutation.
Excluded and no-delta paths never mint it. Default job-completion token revocation remains enabled.
No PAT fallback or additional App permissions are introduced.

The v1 workflow's first authorized manual detection smoke test and the native FOLLOW lifecycle
through PR #55 succeeded as recorded historically. I06's ownership-aware native candidate model
is operational; App setup and hosted operation grant no ordinary agent publication or merge
authority.

For a separately authorized follow-up dispatch when a genuine upstream delta exists:

``` powershell
gh workflow run upstream-sync.yml --repo constbogdan/Mosaic --ref main
```

Inspect exact candidate branch/PR identities and required PR Full CI; an authorized
repeat can verify reuse without another branch/PR. A no-delta run skips token
creation and cannot establish App/PR-path operation. Do not fabricate a delta to
force publication. Dispatching another branch skips jobs because execution is
intentionally guarded to `main`. No follow-up run was executed for this docs update.

The read and publish jobs' repository tokens have only Contents/PR read. Only branch push and PR
creation receive the scoped App token.
Neither checkout persists credentials; candidate Git operations receive no token.
Only the explicit push subprocess receives the publication credential. No build
or untrusted upstream code runs in a write-credential context.

### Operational records and failure recovery

There is no custom database, state branch, Issue journal or service. Run summaries and retained
versioned JSON record observations; the deterministic branch and native PR represent candidate
work. Exact retries reuse the authenticated candidate. Native PR merge/close and accepted Git
ancestry are terminal facts. A `waiting_on_existing_pr` artifact is transient evidence, not a
new ledger: it retains the complete current upstream/downstream pair, deterministic candidate,
commit/path/classification/conflict evidence and authenticated blocker PR identity for 14 days.
After the blocker is resolved, the next run recomputes the remaining range from native Git
ancestry; no branch or PR is created merely to preserve an advancing observation. A
semantic-conflict Draft remains open with status `Blocked — semantic integration required`.

Expected blocked semantic state returns a structured outcome rather than impersonating a
crashed tool. Trust/provenance uncertainty and permission, rate-limit, not-found, transient
network or other required-operation failures still fail the job with their category and
durable evidence where identity permits. External Git and GitHub CLI failures also retain a
sanitized native reason in that existing evidence: the excerpt is flattened, bounded to eight
non-empty source lines and 1,200 characters, and visibly marked if truncated. Operation tokens,
credential-bearing URL userinfo, authorization values, ANSI/control presentation, and GitHub
Actions command syntax are removed or neutralized before the reason reaches logs, summaries, or
the JSON artifact. This diagnostic is never a state-machine input: it cannot turn a failed
operation green, authorize a retry, broaden credentials, force a push, or permit PR creation after
a failed candidate push.

Ref and PR checks are repeated immediately before publication, but Git/GitHub do
not provide an atomic transaction across upstream, downstream, branch and PR state.
Later base changes remain visible on the PR and require current required CI/review.
Keep existing branch changes for human inspection; use corrective work, not force.
After an intentional upstream rewrite, reconcile/review the new lineage and its
retained observation anchors explicitly; there is no automated override/reset switch.

### FUTURE RI ENRICHMENT

Repo Intelligence is absent from the control path. Each job writes versioned JSON
and a workflow summary with repo/ref/SHA identities, comparison baseline, changed
paths, ownership/exclusion decisions, incoming commits/count, configured schedule and
observation time, workflow/run/attempt, candidate, outcome, conflict information and
PR URLs where applicable. A later
read-only consumer may ingest these records asynchronously. No callback, dispatch,
RI credential, external database or synchronous analysis dependency exists.

### Implementation validation

Run the offline helper suite without GitHub interactions:

```powershell
python -B -m unittest discover -s scripts -p test_hosted_upstream.py -v
```

Tests create disposable Git repositories and mock GitHub. Their fixture-only force
push simulates an upstream rewrite; production publication never force pushes.
Validate workflow YAML/actionlint, Python syntax, repository-wide pre-commit and
`git diff --check`. Newly untracked implementation files also need explicit
pre-commit file checks because `--all-files` follows Git's tracked inventory.
Do not run the hosted helper against a developer checkout or create a real sync PR
as an implementation test. Genuine upstream episodes have now live validated branch/PR
publication, CI handoff, native ancestry, no-delta, candidate reuse, and authenticated waiting.

## Onboarding another maintained downstream repository

Mosaic defines the workflow and safety guarantees, not a universal build implementation. Use this checklist when adapting the model to Seerr or another independently maintained service:

- [ ] Identify and verify `origin` and `upstream`.
- [ ] Establish and protect the downstream integration branch (one appropriate protected branch, not necessarily `main`).
- [ ] Establish feature/fix/chore branch and PR-only integration policy.
- [ ] Inspect every inherited workflow and its permissions, triggers, secrets, writes, publishing, and artifacts.
- [ ] Define repository-specific Fast, Standard, and Full validation equivalents where appropriate.
- [ ] Establish local/required-CI validation parity.
- [ ] Add required, read-only PR CI.
- [ ] Guard or disable inherited release and publishing automation until downstream ownership is explicit.
- [ ] Add a safe upstream-sync helper that stops for semantic conflict resolution.
- [ ] Document high-risk merge surfaces and semantic conflict policy.
- [ ] Establish repository-local agent, handoff, roadmap, and upstream-policy documentation.
- [ ] Add a guarded `prepare-pr` workflow.
- [ ] Add automated upstream-change detection and sync-PR preparation without automated conflict resolution.
- [ ] Define downstream build, artifact, versioning, signing, and release ownership.

Seerr standardization remains deferred until `origin/develop` versus `upstream/develop` divergence is deliberately reconciled. Seerr likely retains `develop`, which is part of its upstream integration and development-container lifecycle; it needs pnpm/Node/Docker validation and repository-specific release handling. Mosaic itself needs no permanent staging/develop branch; see the [engineering direction](MOSAIC_ROADMAP.md#engineering-direction).

Do not copy Mosaic's Gradle tasks, Windows prerequisites, CI runner, tag-fetch behavior, or artifact assumptions blindly. Each repository must derive its build toolchain, validation commands, language/runtime requirements, formatting and lint tooling, CI runner, required secrets, artifact and release behavior, upstream tag/versioning requirements, and high-risk merge surfaces. The target is the same workflow and safety guarantees with a repository-specific implementation.
