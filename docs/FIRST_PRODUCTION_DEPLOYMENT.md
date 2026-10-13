# First Library-enabled production deployment

This runbook is for the first Library-enabled deployment of the maintained
downstream Seerr build on the UGREEN NAS. The target is one Dockhand-managed
Seerr container, one persistent `/app/config` mount, and the existing production
SQLite database. This is an in-place database upgrade: existing users, requests,
settings, and Watchlist data must survive while migrations add the Foundation
tables.

Use an immutable image digest, never the rolling `custom` tag, as deployment and
rollback authority. Commands below use placeholders deliberately; record the
actual container name, host-side config path, image identities, and backup path
before making a change.

## Release gate: startup synchronization containment

Set `SEERR_SYNCHRONIZATION_MODE` on the single Seerr container to select one of
three immutable process modes:

- `normal`, or an unset variable, preserves normal startup catch-ups, schedules,
  and manual execution;
- `contained` registers jobs and preserves schedules but suppresses startup
  recovery, catch-ups, recurring callbacks, and manual synchronization; and
- `commissioning` continues suppressing automatic work while allowing the
  administrator to run Library Sync, Jellyfin Activity Sync, Watchlist Play State
  Sync, and optionally Fresh Sync in that enforced order.

Values are strict. An invalid value prevents startup instead of silently falling
back to normal. The mode cannot change inside a running process. Verify the
effective state in **Settings â†’ Jobs & Cache** and **Settings â†’ Import historical
data** after every restart; do not infer it from the deployment manifest alone.
Editing cron schedules never bypasses containment.

The relevant job behavior is:

| Display name | Internal ID | Default recurring schedule | Startup behavior / gate |
| --- | --- | --- | --- |
| Jellyfin Activity Sync | `current-jellyfin-viewing-sync` | every 5 minutes at second 45 | Immediate catch-up for Jellyfin/Emby; no independent enabled setting. |
| Library Sync | `library-history-hydration` | daily at 05:30 | Catch-up after 30 seconds; no independent enabled setting. |
| Watchlist Play State Sync | `watchlist-play-state-sync` | every 5 minutes at second 30 | Immediate catch-up for Jellyfin/Emby, with bounded database-contention retries; no independent enabled setting. |
| Fresh Sync | `fresh-sync` | every 5 minutes | Immediate catch-up only when Fresh is enabled. |
| Fresh Reconciliation | `fresh-reconciliation` | daily at 03:15 | Scheduled only; no startup catch-up. |
| Removal Scan | `removal-candidate-selection` | every 14 days at 01:00 | Scheduled only and callback is a no-op unless Removal Scan is enabled. Movie/Series participation is checked separately. |
| Removal Processing | `scheduled-removal-processing` | daily at 01:30 | Scheduled only and callback is a no-op unless Removal Processing is enabled. |

In normal mode, startup first awaits recovery of expired current-viewing runs,
then registers jobs and starts the catch-ups above. In contained and
commissioning modes, recovery and catch-ups are suppressed before they can
change checkpoints. Normal server startup and initial media-server setup use the
same policy-aware registration path.

## Fixed topology and safety rules

- Run exactly one Seerr application process in exactly one container.
- Mount the existing persistent configuration at `/app/config`.
- Use the existing SQLite database at `/app/config/db/db.sqlite3`.
- Never attach a replacement and rollback container to that database at the
  same time.
- Keep Removal Scan, Removal Processing, automatic Movie participation, and
  automatic Series participation disabled throughout this procedure.
- Do not import the history artifact into the legacy development harness.
- Do not run the old image against a database that has been migrated by the new
  image. Rollback restores the matching pre-upgrade database and configuration.

## 1. Pre-deployment record

In Dockhand, record the stack/project, container name, complete deployment
manifest, bind mounts or named volumes, environment, network attachments,
restart policy, and health check. From the NAS shell, use the recorded container
name to capture read-only evidence:

```bash
export SEERR_CONTAINER='<current-seerr-container>'
export SEERR_CONFIG='<host-path-mounted-at-/app/config>'
export RELEASE_DIR='<protected-backup-root>/seerr-first-library-<UTC-timestamp>'
export NEW_IMAGE='ghcr.io/constbogdan/seerr@sha256:<approved-new-digest>'

mkdir -p "$RELEASE_DIR"
chmod 700 "$RELEASE_DIR"
docker inspect "$SEERR_CONTAINER" > "$RELEASE_DIR/container-before.json"
docker inspect --format '{{.Config.Image}}' "$SEERR_CONTAINER" \
  > "$RELEASE_DIR/image-reference-before.txt"
docker inspect --format '{{.Image}}' "$SEERR_CONTAINER" \
  > "$RELEASE_DIR/image-id-before.txt"
```

Resolve and record the current image's repository digest as `OLD_IMAGE`; an
image ID alone is insufficient rollback authority:

```bash
export OLD_IMAGE='<registry/repository>@sha256:<current-known-good-digest>'
docker image inspect "$OLD_IMAGE" \
  --format '{{json .RepoDigests}}' > "$RELEASE_DIR/image-digests-before.json"
docker image inspect "$NEW_IMAGE" \
  --format '{{json .RepoDigests}}' > "$RELEASE_DIR/image-digests-candidate.json"
```

Stop if the mount does not resolve to the expected persistent directory, the
current digest cannot be established, the new digest is not the approved release
candidate, more than one Seerr container uses this config, or the application is
already reporting database/integrity errors.

Before shutdown, verify in **Settings → Removal** that all four controls remain
off:

- Removal Processing;
- Removal Scan;
- automatic Movie scheduling; and
- automatic Series scheduling.

Also record the current Jobs & Cache state, provider configuration, user count,
request count, active Watchlist count, and application version for comparison.

## 2. Consistent pre-upgrade backup

Do not assume Seerr creates a pre-migration backup. Stop the existing container
through Dockhand, then verify it is not running before copying SQLite or config:

```bash
docker ps --filter "name=^/${SEERR_CONTAINER}$" --format '{{.ID}} {{.Status}}'
```

The command must return no running container. Confirm `$SEERR_CONFIG` is the
resolved host directory and is neither empty nor `/`, then create both a SQLite
backup and a full config archive while the application is stopped:

```bash
test -n "$SEERR_CONFIG" && test "$SEERR_CONFIG" != / && \
  test -f "$SEERR_CONFIG/db/db.sqlite3"

sqlite3 "$SEERR_CONFIG/db/db.sqlite3" \
  ".backup '$RELEASE_DIR/db.sqlite3'"
sqlite3 "$RELEASE_DIR/db.sqlite3" 'PRAGMA quick_check;'

tar -C "$(dirname "$SEERR_CONFIG")" -cpf "$RELEASE_DIR/config.tar" \
  "$(basename "$SEERR_CONFIG")"
sha256sum "$RELEASE_DIR/db.sqlite3" "$RELEASE_DIR/config.tar" \
  > "$RELEASE_DIR/backup.sha256"
chmod 600 "$RELEASE_DIR/db.sqlite3" "$RELEASE_DIR/config.tar" \
  "$RELEASE_DIR/backup.sha256"
```

`PRAGMA quick_check` must return `ok`. Preserve the Dockhand manifest export,
`container-before.json`, old digest, and backup checksums with the database and
config archive. The config archive contains secrets and must remain protected.

## 3. Deploy the immutable candidate

In Dockhand, duplicate or revise the existing deployment without changing the
`/app/config` mapping, networks, ports, or restart policy. Replace the image with
`$NEW_IMAGE`, add `SEERR_SYNCHRONIZATION_MODE=contained`, and ensure no old
container remains attached to the config volume before starting the candidate.

At production startup, Seerr automatically runs TypeORM migrations before it
loads settings or registers background jobs. The migration chain is additive and
creates Foundation, current-viewing, removal-schedule, durable removal-execution,
hydration-generation, and run-lease structures. It does not automatically back
up the database. Do not interrupt migration startup.

Start one candidate container and follow its logs. Before proceeding, require
both the structured startup log and administrator status UI to report
`contained`. Stop and roll back on any migration error, foreign-key error,
schema-authority error, repeated restart, unverifiable mode, or evidence that a
startup synchronization escaped containment.

## 4. Verify Foundation initialization

Before importing history or enabling current synchronization:

1. Confirm the application reaches healthy/ready state and reports the expected
   downstream version and image digest.
2. Confirm existing login, users, requests, settings, provider definitions, and
   Watchlist data remain present.
3. Confirm the migration table contains the current migration chain.
4. Confirm the Foundation tables exist, including `canonical_media`,
   `canonical_season`, `canonical_episode`, `library_presence`, `library_file`,
   `viewer`, `viewing_evidence`, `current_viewing_state`, `hydration_run`,
   `source_checkpoint`, `library_hydration_epoch`, `removal_schedule`,
   `removal_execution`, and `removal_execution_claim`.
5. Confirm Removal remains disabled in all four controls.

Do not use TypeORM `synchronize: true`, manually create tables, or run a second
container to inspect the database.

## 5. Verify the approved October 4 artifact

The default first-production input is the existing `wholphin-history-v1`
artifact whose observed range ends October 4, 2026. Copy it into a protected
operator staging directory; do not alter it. Verify the file before presenting
it to Seerr:

```bash
export HISTORY_FILE='<protected-path>/wholphin-history-v1.json'
sha256sum "$HISTORY_FILE"
jq '{schema,datasetId,contentHash,jellyfinServerScope,coverage,counts:{viewers:(.viewers|length),media:(.media|length),seasons:(.seasons|length),episodes:(.episodes|length),libraryFacts:(.libraryFacts|length),viewingFacts:(.viewingFacts|length),completionFacts:(.completionFacts|length),activityFacts:(.activityFacts|length),untimedEvidenceFacts:(.untimedEvidenceFacts|length)}}' "$HISTORY_FILE"
```

Expected identity and scope:

| Field | Expected value |
| --- | --- |
| File SHA-256 | `77d8aa5ad74eb59ce16f9b9f7c1ccd5751e6e95508eac1f694265362d3cbd306` |
| Schema | `wholphin-history-v1` |
| Dataset ID | `wholphin-history-v1:6d19c5e622b0642c6d6281b10e774367cc9962db4fd04a4d90a68b1286d073e2` |
| Embedded content hash | `sha256:6d19c5e622b0642c6d6281b10e774367cc9962db4fd04a4d90a68b1286d073e2` |
| Jellyfin server scope | `91ed610f57154c3596f5c018e0ba7f6b` |
| Observed start | `2025-12-19T23:32:08.961Z` |
| Observed end | `2026-10-04T19:03:29.072Z` |

Expected counts:

| Fact type | Count |
| --- | ---: |
| Viewers | 4 |
| Media | 588 |
| Seasons | 283 |
| Episodes | 2,649 |
| Library facts | 111 |
| Viewing facts | 2,030 |
| Completion facts | 562 |
| Activity facts | 6 |
| Untimed evidence facts | 82 |

The file checksum covers the serialized JSON file; the embedded content hash is
the artifact contract's normalized-content identity, so the two values are not
expected to match.

## 6. Validate and import history

Open **Settings → Import historical data** as an administrator. Select the
verified artifact and choose **Validate** before **Import**.

For a first import into new Foundation tables, the required disposition is
`first import`, with the exact schema, content hash, observed range, and counts
above. Stop for investigation if validation reports corrected facts, historical
omission, regressive artifact, an identity conflict, a different server scope,
or different counts. `repair` is only valid when restoring demonstrably missing
facts from the same accepted artifact. `additive cumulative` describes a
different cumulative artifact and is not expected for this deployment.

Import is one database transaction. Success means the artifact was accepted and
the checkpoint became CURRENT; it does **not** assert exhaustive historical
coverage. Verify after import:

- accepted content hash and observed range match the table above;
- completeness is displayed as `not asserted`;
- the import created no `CurrentViewingState` rows;
- imported Library presence is non-current and has no invented file size,
  resolution, path, or removal date;
- current Seerr users, requests, Watchlist state, and provider settings are
  unchanged; and
- validating/importing the identical artifact again reports `exact repeat` and
  performs no run or checkpoint update.

Record the validation and import summaries. Keep the original artifact and its
checksum with the deployment evidence. Jellystat is not a continuing sync
source, and no newer export is required unless a concrete coverage gap is
demonstrated.

## 7. Release current synchronization in order

After historical acceptance, stop the contained container and change the same
deployment to `SEERR_SYNCHRONIZATION_MODE=commissioning`. Start exactly one
container and verify the administrator status reports `commissioning`. Recurring
callbacks and catch-ups remain suppressed. From **Jobs & Cache**, start and await
successful completion in this enforced order:

1. **Library Sync** to establish authoritative current Radarr/Sonarr/Jellyfin
   membership and the current Library generation.
2. **Jellyfin Activity Sync** to capture current per-user Jellyfin `UserData`
   against that generation.
3. **Watchlist Play State Sync** to refresh current Watchlist completion.
4. **Fresh Sync** only when Fresh is intentionally enabled and its autobrr
   configuration has been reverified.

The server rejects an overlapping job, an out-of-order job, and any unapproved
job with HTTP 409. A failed phase remains the required phase and can be retried;
it never unlocks the next phase. Fresh Sync is optional and is allowed only when
Fresh is enabled intentionally.

Wait for each required job to complete before interpreting the next result.
Failed or incomplete runs must remain failed/incomplete; do not mark checkpoints
CURRENT manually. After the required sequence, stop the commissioning container,
remove the variable or set it to `normal`, and restart the same single
deployment. Verify the status reports `normal` and schedules are active. Normal
startup catch-ups may run again and must remain idempotent.

## 8. Functional smoke test

Without issuing any destructive or provider-mutating action, verify:

- administrator and regular-user login;
- Discover, Movies, Series, Requests, Watchlist, Fresh, Library, and Leaving Soon;
- existing users, requests, permissions, and Watchlist ownership;
- Library Current/Archive/All counts, one Movie, one Series, expanded Seasons,
  Last Active, Watched, requester details, storage labels, and Collections;
- History Import accepted status and `not asserted` completeness;
- Radarr/Sonarr settings and Storage Root names, colors, and Animation flags;
- Jobs & Cache labels, schedules, completion state, and absence of overlapping
  duplicate application processes; and
- no unexpected provider mutations, removal claims, or uncertain executions.

Reverify that Removal Processing, Removal Scan, automatic Movie scheduling, and
automatic Series scheduling remain disabled. Navigation visibility never grants
destructive permission; server authorization remains authoritative.

## 9. Rollback

Forward migrations are not reversed automatically. A safe rollback restores the
pre-upgrade SQLite database and matching configuration before returning to the
old image.

1. Stop the candidate in Dockhand and verify no Seerr container is running.
2. Preserve the failed candidate logs and a separate copy of its config for
   investigation; do not overwrite the known-good backup.
3. Verify `backup.sha256` and `PRAGMA quick_check` on the saved database.
4. Move the candidate config directory aside without deleting it.
5. Restore `config.tar` to the exact original host path, or restore
   `db.sqlite3` plus every matching configuration/secret file from the same
   backup set.
6. Configure Dockhand to use `$OLD_IMAGE`, the recorded immutable digest.
7. Confirm only the rollback container references the restored config.
8. Start one container, verify the recorded pre-deployment version and counts,
   and repeat the non-destructive smoke checks.

Never point the old image at the forward-migrated database, mix a pre-upgrade
database with post-upgrade settings, or run old and new containers concurrently.

## 10. Post-deployment evidence and backup

After acceptance, stop the container during a maintenance window and create a
new verified database backup and complete config archive using the same commands
as the pre-upgrade backup. Record the deployed immutable digest, migration list,
artifact identity and disposition, observed range, job/checkpoint status,
Removal-disabled evidence, smoke-test results, and backup checksums. Restart one
container only after the backup has passed `PRAGMA quick_check`.

## Known operational limitations

- **SQLite/single process:** this release supports one application process and
  one container. Process-local request identity, settings serialization, and
  TMDB request coalescing do not provide multi-replica coordination.
- **PostgreSQL:** paired migrations and schema parity exist, but the downstream
  release retains a PostgreSQL runtime/concurrency validation gap.
- **History:** accepted import coverage is an observed timestamp range with
  completeness `not asserted`. Current Jellyfin is authoritative for mutable
  watched state; historical Jellystat facts remain evidence only.
- **Removal uncertainty:** provider acknowledgement is not proof of physical
  deletion. Uncertain or reconciliation-required executions must be reconciled
  read-only before any retry; never repeat a destructive provider command
  blindly.
- **TMDB:** rate limiting, queueing, and cold-request coalescing are process-local.
- **Mobile Library:** the current responsive layout is accepted; the dedicated
  mobile Library redesign remains deferred.
- **Browser tooling:** Cypress cannot replace all authenticated production-mode
  Chrome acceptance; the release record must retain the documented tooling
  limitations.
- **Cold start:** 100-card Library rendering met the audited production workload,
  with documented cold-start variance retained rather than hidden.

See [Library foundation](LIBRARY_HISTORY.md), [Watchlist](WATCHLIST.md),
[Fresh discovery](FRESH.md), [backup guidance](using-seerr/backups.md), and the
[downstream package contract](SEERR_DOWNSTREAM_PACKAGE.md) for the underlying
data and release boundaries.
