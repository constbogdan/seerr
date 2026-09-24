# Upstream resolution decisions

This is the durable decision ledger for human semantic resolution of managed
Seerr upstream Drafts. It complements the operating contract in
[UPSTREAM_SYNC.md](UPSTREAM_SYNC.md); it does not replace machine evidence,
Git history, PR review, or validation.

The copied Mosaic implementation must be adapted and validated before the first
Seerr entry is produced. Mosaic PR numbers, paths, product rules, and historical
decisions are not Seerr evidence and are intentionally not carried into this
ledger.

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

No Seerr upstream semantic resolution has been recorded in this adapted ledger
yet. Add the first entry only from a completed authenticated Seerr resolver
session; do not pre-populate it from Mosaic history or planning assumptions.
