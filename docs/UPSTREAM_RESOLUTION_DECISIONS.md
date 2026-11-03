# Upstream resolution decisions

This is the durable decision ledger for human semantic resolution of managed
Seerr upstream Drafts. It complements the operating contract in
[UPSTREAM_SYNC.md](UPSTREAM_SYNC.md); it does not replace machine evidence,
Git history, PR review, or validation.

Unrelated PR numbers, paths, product rules, and historical decisions are not Seerr
evidence and are intentionally not carried into this ledger.

## What belongs here

Add one entry only after an authenticated resolver session produces a reviewed
semantic decision. Record durable information that a future maintainer cannot
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

This operator-approved manual integration is not a managed Draft episode. No PR,
publication, merge commit, or protected-main update is authorized by this entry.
The native merge remains pending on `chore/manual-upstream-pre-lockfile` with
ordered parents:

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
zero failures or skips. Candidate validation must rerun those same file lists,
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
validation. Hosted Full and runtime acceptance remain outstanding; local success
does not authorize publication or deployment.

### Manual Stage 2: GitHub Actions lockfile

Stage 1 was subsequently merged through
[PR #51](https://github.com/constbogdan/seerr/pull/51). This separate, uncommitted
manual integration uses the ordered native merge parents
`[60022ec0f6f0be35cbc5749f6d0b0db19b251be0,
53299c12ac538200cac5687f882400754aeab5e2]`. The second parent is the single
upstream squash commit for [#3632](https://github.com/seerr-team/seerr/pull/3632),
directly following Stage 1 target `6f63b08d5c610217c75580340ce78b69b8a0bd61`.
The authenticated upstream tip was `b185621e8e48743bb38adaa0d15b334626b7b100`;
later commits and the original PR commits are not imported.

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
image operation is authorized here. The Stage 1 image run is independent.
Future review-only publication requires separate authorization: the existing
ordinary prepare-pr path enables auto-merge, while its preservation mode needs
an already-existing managed Draft and does not bootstrap this manual branch.
