# Validation architecture

This document is the current authority for Mosaic's validation architecture. It explains which
boundary proves what; it is not an acceptance ledger. Historical rationale and measurements remain
in the [T0-1 operator UX ledger](T0_1_OPERATOR_UX_INVENTORY.md) and the
[CP7 performance audit](T0_1_CP7_PERFORMANCE_AUDIT.md).

## Authority model

```text
local Fast feedback
  -> authoritative pull-request validation
  -> native protected-main merge
  -> exact-tree evidence reuse or complete conservative fallback
  -> independent Development eligibility
```

These boundaries are deliberately different. Local feedback helps an author before publication;
it is not reusable integration authority. Pull-request CI proves the proposed integration tree.
Protected main authenticates that proof against the final merge. Development then independently
decides whether the validated main range requires an APK. Signing, publication, Stable Promotion,
and Hold remain separate authority boundaries.

## Local feedback

`scripts/validate-local.ps1 -Level Fast` is the normal local command and the check used by
`prepare-pr` for uncommitted work. It derives scope from the repository's shared change
classification and validation policy, then runs changed-scope pre-commit, explicitly mapped
bounded offline or JVM feedback where available, and `git diff --check`.

Fast does not turn an unknown or high-risk path into a broad local suite. Heavy process-integration
tests, complete offline tooling, and Android Full remain explicitly runnable through focused,
Standard, or Full commands, while hosted PR CI owns authoritative integration coverage. Autofixes
or any unexpected tree mutation stop preparation for review. See [safe PR preparation](PREPARE_PR.md)
for reviewed-snapshot and publication behavior.

## Authoritative pull-request validation

The required GitHub check is `CI / Full validation`; its job identity is `Full validation`. Every
pull request runs changed-range pre-commit hygiene and the complete offline tooling suite
(`test_*.py`). The authoritative policy classifies the complete PR range into exactly one evidence
class:

| Evidence class | Required work |
| --- | --- |
| `NON_ANDROID` | Changed-range pre-commit plus complete offline tooling; Android validation is not required. |
| `ANDROID_FULL` | The same checks plus Android setup and complete `defaultDebug` validation, including compilation, the complete JVM test graph, and APK assembly. |

Only proven non-Android scope receives `NON_ANDROID`. Android, build-sensitive, unknown, or
otherwise uncertain scope receives `ANDROID_FULL`. This fail-closed choice is independent of
release relevance: tooling can require Android validation without requiring a Development APK.

## Exact-tree policy evidence

A successful PR emits versioned `pr-policy-v1` evidence under the stable
`wholphin-pr-policy-v1-*` artifact identity. The historical protocol name is intentional and must
not be treated as product branding. Evidence binds the repository, workflow, PR and run, base/head
parents, tested synthetic merge and tree, validation class, required outcomes, artifact identity,
and contract version.

On a protected-main push, the consumer reauthenticates those fields and requires the final main
tree to equal the tested PR tree. Exact authenticated equivalence reuses the complete PR policy and
skips only work already proven by that class: pre-commit, complete offline tooling, Android setup,
and Gradle validation as applicable.

Any missing, failed, cancelled, expired, ambiguous, foreign, stale, parent-, tree-, class-,
workflow-, artifact-, outcome-, or contract-mismatched evidence fails closed to the complete main
fallback: repository-wide pre-commit, complete offline tooling, Android setup, and complete
`defaultDebug` validation. Direct changes use the same fallback. Evidence reuse never converts
uncertainty into a skip.

## Delivery boundaries after validation

After protected-main validation succeeds, Development eligibility authenticates the last published
Development baseline and classifies the complete unpublished range. Proven docs/tooling or other
non-APK scope reports `No build required`; APK-relevant or uncertain scope enters the separate
Release Build, isolated signing, and Development publication chain. PR validation class and release
relevance are separate dimensions.

Stable Promotion does not rebuild or sign. It separately authenticates an immutable Development
candidate, waits for `release-promote`, and publishes the exact signed bytes. Hold uses its own
authorization and preserves published bytes and provenance. See the current
[Development](MOSAIC_DEVELOPMENT_RELEASE.md), [signing](MOSAIC_SIGNING.md), and
[Stable/Hold](MOSAIC_STABLE.md) contracts.

## Failure and recovery routing

| Failure or state | Current route |
| --- | --- |
| Local feedback or PR validation failure | Fix the branch and rerun the normal PR lifecycle. |
| Protected-main evidence mismatch or uncertainty | Run the complete conservative main fallback. |
| Development build/sign/publish failure | Use the Development failed-job recovery rules while exact artifacts remain valid; otherwise forward-fix on main. |
| Signing identity or credential diagnosis | Use the isolated signing boundary and zero-input Signing Diagnostic; do not expose credentials to other stages. |
| Stable release problem | Hold the current Stable release when urgent, then forward-fix through a higher-version Development and promote those exact bytes. |
| Upstream `REVIEW` or conflict | Use the authenticated human/Codex resolver lifecycle; validation does not replace semantic review. |

No row creates a bypass, rollback, artifact substitution, or new publication authority.

## Human and device validation

Hosted validation is authoritative for repository integration, not for every product judgment.
Semantic review and Android TV visual, focus, navigation, installation, and integration checks
remain necessary when the changed behavior requires them.
