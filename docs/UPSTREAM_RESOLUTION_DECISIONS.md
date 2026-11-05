# Upstream resolution decisions

This is the durable decision ledger for human semantic resolution of managed
Seerr upstream Drafts and explicitly approved manual native integrations. It
complements the operating contract in
[UPSTREAM_SYNC.md](UPSTREAM_SYNC.md); it does not replace machine evidence,
Git history, PR review, or validation.

Unrelated PR numbers, paths, product rules, and historical decisions are not Seerr
evidence and are intentionally not carried into this ledger.

## What belongs here

Add one entry only after an authenticated resolver session or approved manual
review produces a semantic decision. Manual entries must not invent a managed
episode identity. Record durable information that a future maintainer cannot
reconstruct safely from the final diff alone:

- managed PR number and episode ID;
- exact original candidate and live pre-publication Draft head;
- recorded `seerr-team/seerr:develop` SHA;
- recorded and, when applicable, reconciled `downstream-main` SHA;
- attention/conflict paths actually reviewed;
- upstream intent and downstream behavior that had to coexist;
- the chosen semantic result and rejected unsafe alternatives;
- focused tests added or selected;
- exact final parent/tree shape when reconciliation was required; and
- remaining manual or hosted acceptance.

Do not copy credentials, raw environment output, unbounded logs, temporary paths,
or complete machine artifacts into this document. Link the managed PR or hosted
run where durable external evidence is useful.

## Required decision standard

For every attention path:

1. reconstruct the exact upstream intent from retained evidence and Git history;
2. inspect current downstream behavior;
3. preserve both when compatible;
4. never choose ours or theirs merely because Git selected a side;
5. retain already-integrated clean upstream changes;
6. add or identify focused tests for behavior changed or preserved; and
7. record why the resulting tree is semantically correct.

A decision is incomplete while conflict markers remain, unrelated paths are in
scope, required focused coverage is missing, or the final Draft ancestry cannot
be authenticated.

## Publication boundary

The resolver owns the authenticated merge commit and the handoff to prepare-pr.
It binds any semantic test-filter handoff to the exact PR number, episode, branch,
and source-controlled test targets. A malformed, stale, foreign, or weaker
handoff is refused.

The final publication remains fast-forward-only on the same managed Draft.
Neither this ledger nor passing tests authorize Draft readiness, auto-merge,
direct merge, branch replacement, or force push.

## Seerr resolution entries

### Manual Stage 1: pre-lockfile integration

This operator-approved manual integration was not a managed Draft episode. The
resolution-stage entry did not authorize publication; separate approval later
produced PR #51 (see the completion record below). The reviewed native merge on
`chore/manual-upstream-pre-lockfile` retained ordered parents:

1. downstream `edcc0a66a9db456ce2e8da6f29ef14989a1cd0f4`;
2. upstream target `6f63b08d5c610217c75580340ce78b69b8a0bd61`.

The authenticated upstream observation was
`b185621e8e48743bb38adaa0d15b334626b7b100`. The bounded range contains 26 commits
after integrated anchor `103976d1b4d72fb2278995c2e9b9ab51891d5b8f`. Commit
`53299c12ac538200cac5687f882400754aeab5e2` and subsequent changes are excluded.

#### Approved lifecycle policy: upstream #3578

Preserve the downstream scanner behavior. Present-but-unmonitored media with no
downloaded files may retain the existing availability reset, but must not acquire
a new automatic APPROVED-to-DECLINED request transition. Missing-from-all-servers
cleanup retains its existing completeness, empty-response, quality and provider
verification guards. No request/season deletion or invented history is added.

The base, Radarr and Sonarr scanner implementation remains identical to the
authenticated downstream parent. The incoming deferred-reset collector and
processing-ID sets are not retained: their purpose was the unapproved expansion
of request declines. Upstream ancestry is retained through the native merge,
not simulated by cherry-picking or rewriting commits.

Rejected alternatives: taking #3578 unchanged, adding a new guarded decline
policy, or changing persistence/orchestration beyond the approved baseline.
Incoming scanner tests are adapted to the approved request-intent policy rather
than asserting the rejected new transitions or deferred availability behavior.
Regressions retain missing-media declines, both scan orders, disabled/empty/failed
servers, request identity and season history.

#### Five textual conflicts

- `server/api/servarr/radarr.ts`: retain Overflow placement and tag replacement;
  gate explicit existing-movie searches on Radarr availability, including the
  placement-update response. New-movie add options are unchanged. Reject losing
  routing or retaining ungated search. Test ordinary and Overflow paths across
  availability and search settings.
- `server/entity/Media.ts`: retain acquisition presentation and add upstream
  privacy filtering as separate methods. Preserve per-user watch state and
  response fields without mutating loaded persistence entities. Reject either
  dropping privacy filtering or dropping downstream acquisition behavior.
- `server/lib/scanners/jellyfin/index.ts`: retain authoritative parent metadata
  resolution, fallback, typed deduplication, canonical coordination, cancellation
  and boolean completion results. This already fulfills upstream #3551's parent
  dispatch intent. Reject the weaker direct SeriesId-only dispatch.
- `server/lib/scanners/jellyfin/jellyfin.test.ts`: retain both the downstream
  Recently Added parent/dedup regression and upstream empty-show request test.
- `server/subscriber/MediaSubscriber.ts`: retain sequential guarded scalar
  transitions. These satisfy upstream #3630's sequential-save intent without
  restoring stale entity-graph saves. Add real multi-request completion coverage
  for savepoint behavior, quality separation and retained identities.

#### Clean semantic overlaps

The 15 clean downstream overlaps were reviewed, not accepted solely on Git's
merge result:

- `User.ts` and `routes/auth.ts`: keep downstream identity/metrics and expose only
  upstream's safe settings projection; no later startup-reset change is imported.
- `routes/movie.ts` and `routes/tv.ts`: retain user-specific media attachment
  before applying privacy projection.
- `routes/request.ts` and its test: creation-date sorting retains deterministic
  ID ties, requester authorization and profile scoping.
- `baseScanner.ts` and the Sonarr scanner: retain downstream settlement guards and
  immutable provider evidence; preserve baseline lifecycle policy as above.
- The incoming user Watchlist privacy fixture explicitly selects the downstream
  local-Watchlist branch by clearing only its synthetic user's Plex token. A
  token-bearing profile correctly selects the live Plex source instead; do not
  change that routing or permit test network access to satisfy the upstream test.
- `job/schedule.ts` and SettingsJobsCache: accept Plex minute units and the
  three-minute selector while retaining custom jobs and asynchronous startup.
- Radarr API tests retain availability coverage alongside Overflow regressions.
- `seerr-api.yml` accepts Watchlist POST contract corrections while retaining
  downstream API extensions.
- `Dockerfile` changes the upstream Node pin but retains downstream build metadata.
- Backup heading fixes retain SQLite snapshot/single-writer guidance.
- English validation text changes retain downstream translation keys.

#### Validation and workflow boundary

The unchanged downstream baseline passed 374 tests in 25 selected files, with
zero failures or skips. The resolution gate required the same file lists,
plus privacy, lifecycle, scanner, scheduler and integration regressions, server
and client types, targeted lint/formatting, and Fast validation. Full remains
hosted authority and is not authorized locally for this task. Exact candidate
tree identity and validation evidence are recorded in the operator handoff,
not a self-referential tree hash in this document.

All 19 inherited workflows must match the bounded upstream target. The two
downstream workflows and policy-protected `upstream-sync.yml` retain downstream
bytes. External unsafe-workflow disablement, read-only token defaults and the
22-file workflow inventory must be reverified. No `actions.lock` is introduced.
The incoming Telegram documentation trailing blank line is removed for whitespace
validation. Hosted Full and runtime acceptance were outstanding at resolution;
subsequent publication evidence is recorded below. Local success alone did not
authorize publication or deployment.

### Manual Stage 2: GitHub Actions lockfile

Stage 1 was subsequently merged through
[PR #51](https://github.com/constbogdan/seerr/pull/51). The initial Stage 2
manual integration used the ordered native merge parents
`[60022ec0f6f0be35cbc5749f6d0b0db19b251be0,
53299c12ac538200cac5687f882400754aeab5e2]`. The second parent is the single
upstream squash commit for [#3632](https://github.com/seerr-team/seerr/pull/3632),
directly following Stage 1 target `6f63b08d5c610217c75580340ce78b69b8a0bd61`.
The authenticated upstream tip was `b185621e8e48743bb38adaa0d15b334626b7b100`.
This was the initial lockfile boundary, not the eventual final PR #52 scope:
separate approval incorporated the official Cypress startup correction through
`f288fff37dcc8b3ef89ebe20f2ed5cb45fb92ec1` and reconciled merged PR #53.

All 19 incoming files are retained source-identical: 18 workflow reference
updates and the generated `actions.lock`. Parsed workflow structure, triggers,
permissions, commands and job/step topology are unchanged apart from action
references. All replacement pins preserve the old action commits except
`upload-pages-artifact`, which advances v4 to v5 in the externally disabled
Pages workflow. Do not describe that change as a reference-only rewrite.

The v0.0.3 lockfile covers 19 inherited workflows, including the action-free
Seerr Labeller, with 29 direct dependency entries and seven additional transitive
entries. Read-only checks on November 3, 2026 verified all 36 repository/owner
identities and commit/ref mappings, plus 39 action manifests and their nine
declared transitive edges. This does not audit arbitrary downloaded tools,
bundled JavaScript dependencies, container contents or reusable workflow code.

GitHub executes locked commits for onboarded workflows, as described in its
[lockfile documentation](https://docs.github.com/en/actions/concepts/security/workflow-dependency-lockfiles).
This does not itself enable repository-wide Require lockfile enforcement. The
two downstream workflows and policy-protected `upstream-sync.yml` remain
byte-identical, outside this upstream lockfile; adding them or regenerating the
file across all downstream workflows requires separate review. The executable
workflow inventory remains 22 files, so its checked-in list is unchanged.

Rejected alternatives: editing the generated lockfile, restoring old SHA syntax
in inherited workflows, onboarding downstream workflows, enabling enforcement,
or changing unsafe workflow enablement. Preserve all 14 externally disabled
unsafe workflows and read-only default token permissions. Existing active
CodeQL, Cypress, docs-link, Helm-lint and docs-test workflows retain their
previous scopes and authority; candidate PRs may run existing read-scoped Cypress
and docs-link checks, not upstream publication workflows.

Baseline and candidate checks use the same ten isolated maintenance regression
modules covering provenance, ownership, publication, release/version authority,
and validation, plus executable YAML/lockfile checks and Fast validation. No
application tests, local Full run, commit, publication, enforcement change or
image operation was authorized at that initial gate. The Stage 1 image run was
independent. Later review-only publication required separate authorization: the existing
ordinary prepare-pr path enables auto-merge, while its preservation mode needs
an already-existing managed Draft and does not bootstrap this manual branch.

### Manual Stage 3: bounded final upstream range

This operator-approved local resolution was not a managed Draft episode. The
reviewed native merge on `chore/manual-upstream-final` retained ordered
parents `0c7af80598c3dc65552832eef96b4f97412a6b66` and
`b185621e8e48743bb38adaa0d15b334626b7b100`. The incoming range contains exactly
13 commits after `f288fff37dcc8b3ef89ebe20f2ed5cb45fb92ec1`. The observed official
develop tip was `886adac27597b45cd901099cd02a0b46d9d3cb7f`; later commits are
excluded. Publication was separately approved after this resolution gate.

#### Approved lifecycle override: upstream #3579

Retain the downstream BaseScanner and Sonarr implementation, including guarded
scalar settlement, source-current observations and quality-specific evidence.
Present or partially available media must not cause new automatic declines.
Unfinished requested seasons retain their rows, identities and factual history;
removing them cannot manufacture completion. Existing genuinely missing-media
cleanup retains its complete-scan, empty/failed-server, quality and independent
provider-verification guards. The Stage 1 override of #3578 remains in force.

The upstream season-reset collectors, abandonment-linked persistence and rollup
extraction were reviewed together. The extraction has no independent behavioral
benefit without the rejected second persistence path. Do not import its flags,
direct entity-graph declines, season deletions or completion-after-deletion.
Native ancestry still retains the upstream commit. Reject both taking #3579
unchanged and inventing an alternative cleanup policy during this integration.

All baseline scanner tests remain. Incoming multi-server and abandoned-season
fixtures are adapted to the approved contract: assert retained request/season
IDs, creation dates, unfinished intent and prior completion, not newly permitted
re-requests or fabricated completion. Both server orders and failed metadata
lookup remain exercised. Existing settlement/lifecycle regressions cover quality,
source identity, stale observations, duplicate completion, retry and cancellation.

#### Six conflicts and compatible improvements

- Cypress configuration combines downstream synthetic provider tasks and optional
  browser-isolation hooks with upstream failure-video retention. Any failed retry
  attempt preserves its video. Three downstream-only credential consumers move
  from `Cypress.env` to Cypress 16's `Cypress.expose`; assertions are unchanged.
- Scheduler setup remains asynchronous with all downstream jobs, policy guards,
  recoveries and catch-ups. Repeated setup cancels only old schedule handles,
  after recovery succeeds, never active job ownership. A shared startup promise
  coalesces overlapping setup and releases on failure. Read the current server
  configuration after awaited recovery so owner setup cannot register stale
  NOT_CONFIGURED schedules. Reject a synchronous reset copied ahead of recovery:
  overlapping continuations would register duplicates. The new Plex-owner auth
  path awaits setup like the existing two setup paths, retaining error handling.
- BaseScanner, its conflict tests and the Sonarr scanner preserve the downstream
  semantics above. No replacement lifecycle framework or migration is introduced.
- TV request creation retains copied, sorted validated season selection and all
  initial/visible-season guards. POST and PUT 202 responses are informational;
  PUT returns before approval and neither path reports false completion. Existing
  create, edit, approval, cancellation and finally/updating behavior remains.

#### Clean overlaps, dependencies and acceptance boundary

All nine downstream overlaps were reviewed. Requested-server Override Rules keep
existing permission/routing guards and fall back only for an absent or invalid
server ID. Tests cover explicit, other and unknown server IDs for Movie and TV.
The auth change retains identity/privacy and awaited startup. Trending changes
only URL-backed filters; shared discovery pagination and Fresh remain unchanged.
English translations retain downstream keys. Cypress maintenance retains current
navigation, storage-provider fixtures and request-ordering assertions.

The Dockerfile retains downstream build/version/channel metadata and copies
compiled server migrations, templates and translations. `next.config.mjs`
preserves options without requiring a runtime TypeScript compiler. Runtime COPY
exclusions intentionally remove sources and build-only modules; Alpine native
module/image acceptance is still distinct from Windows local validation.

Use a fresh frozen install for Next 16.4.2, SQLite driver 6.0.1 and Cypress 16.2.0;
baseline dependency links are not candidate evidence. Compare all 527 baseline
test identities in the same 36 files, plus incoming Override Rules tests,
history-preservation tests and executable scheduler/TV-response regressions.
Retain isolated SQLite migration, existing-data/savepoint, build/runtime, browser,
type, lint, translation and Fast evidence in the operator handoff. Exact staged
tree identity belongs in that handoff, not a self-referential hash here.

All 19 inherited workflows must remain source-identical to the bounded target;
the two downstream workflows and protected `upstream-sync.yml` retain downstream
bytes. `actions.lock` remains unchanged and consistent with direct references.
Reverify the 22-file inventory, 14 unsafe external disablements and read-only
Actions defaults. No external settings were changed. Ubuntu 26.04, hosted Full
and unexecuted platform acceptance were separate pending gates at resolution;
local validation alone did not authorize publication or protected integration.

### Completed integration record through v1.0.42

The following commits and trees are authenticated from Git history, not inferred
from PR descriptions. Short SHAs below uniquely identify the full Git objects.
Protected PR merges preserve the already-reviewed native merge as a parent.

| PR                                                  | Reviewed head  | Protected merge | Head/merge tree                            |
| --------------------------------------------------- | -------------- | --------------- | ------------------------------------------ |
| [#51](https://github.com/constbogdan/seerr/pull/51) | `a955672a1188` | `60022ec0f6f0`  | `9023a2a45a4c37990d45e30a9006d9d3ccd9ff7a` |
| [#53](https://github.com/constbogdan/seerr/pull/53) | `79db0a110117` | `10e4c8f77d54`  | `b1faf26a4c5d8f38ec27ff575643e2d92cf95633` |
| [#52](https://github.com/constbogdan/seerr/pull/52) | `531f90bf3d6d` | `0c7af80598c3`  | `e20359d6666368995a76e5afa0d2633c6702c6d7` |
| [#54](https://github.com/constbogdan/seerr/pull/54) | `0cc93e8d9557` | `c25e3eb82be9`  | `c177a9f895faf772845b5ccecb0590fcad172a4a` |

PR #53 landed before #52 and changed only nine Cypress configuration/spec/support
files. Its corrected 83-test suite passed against Stage 1 and Stage 2 application
revisions. Do not conflate the pre-existing browser-test defects with the earlier
Cypress startup problem, or infer lockfile causality from chronology.
PR #52's final head reconciles parents `[47ab40317ab8, 10e4c8f77d54]`, retaining
the official lockfile/startup-fix ancestry and the accepted Cypress maintenance.
Stage 1 and Stage 3 native parent order remains exactly as recorded above.

Stage 3 local evidence recorded 540 passing tests, including all 527 baseline
test identities, plus 27 focused regressions and 47 browser scenarios in ten
specs. These counts describe those selected suites, not a permanent repository
test total. Hosted [Downstream validation](https://github.com/constbogdan/seerr/actions/runs/41916930351)
and [Cypress](https://github.com/constbogdan/seerr/actions/runs/41916930325)
subsequently passed. No local Full claim is added.

The accepted upstream anchor is `b185621e8e48743bb38adaa0d15b334626b7b100`.
The 26-commit Stage 1 range, lockfile/startup-fix integration and 13-commit Stage 3
range retain native ancestry and the #3578/#3579 overrides; this does not accept
later upstream commits. PR #55 remains a separate attention workspace as
[documented here](UPSTREAM_SYNC.md#observed-attention-example-pr-55).
All 19 inherited workflow sources match that accepted anchor; the two downstream
workflows and protected `upstream-sync.yml` retain their downstream authority.
On November 5, read-only GitHub checks confirmed 14 unsafe inherited workflows
disabled, eight active workflows, read-only Actions defaults and an active
`Protect downstream-main` ruleset requiring an up-to-date `Downstream validation`
check and PR integration. A legacy branch-protection endpoint alone is not a
complete ruleset check. External state must be reauthenticated at publication.

The protected merge is the v1.0.42 image source. Public artifact verification and
operator-reported NAS/runtime acceptance are deliberately separated in the
[package reference](SEERR_DOWNSTREAM_PACKAGE.md#v1042-reference-and-evidence-boundary).
