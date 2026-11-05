# Seerr downstream package

`ghcr.io/constbogdan/seerr` is a personal downstream build of
[Seerr](https://github.com/seerr-team/seerr). It tracks upstream `develop` and may include selected
custom features and fixes. It is not an official Seerr release.

The application remains Seerr; the downstream identity applies only to maintenance, image delivery,
and provenance.

## Image identities

- `custom-v1.0.N` is the human-readable immutable downstream version.
- `custom` is the rolling update tag for Dockhand and local deployments.
- the full source SHA is an immutable source-identity tag.
- the published image digest is the authoritative deployment and rollback identity.

`N` advances only when the exact range since the previous published image contains a product-relevant
or conservatively unknown change. Documentation-only and tooling-only merges do not publish or consume
a version. The `custom-` namespace prevents confusion with official Seerr versions.

Each publication summary records the version, source SHA, digest, build link, comparison with the
previous protected-main image, and whether authenticated upstream synchronization provenance was
available. Managed upstream provenance is claimed only when exact candidate trailers agree with native
merge parents and ancestry; ordinary or ambiguous merge history is reported without an upstream claim.

## Supported deployment topology

### v1.0.42 reference and evidence boundary

The [custom-v1.0.42 release](https://github.com/constbogdan/seerr/releases/tag/custom-v1.0.42)
was published on November 4, 2026 (UTC), after the bounded integrations recorded
in the [decision ledger](UPSTREAM_RESOLUTION_DECISIONS.md).

- Image: `ghcr.io/constbogdan/seerr:custom-v1.0.42`.
- Source and Git tag: `c25e3eb82be9b8710ac1d38e52e83c09cfb5cf9b`.
- Immutable deployment reference:
  `ghcr.io/constbogdan/seerr@sha256:6ecba09dc0ba3ce03c8f61b99d2219e57de30fb761902b9e4dd8785266b44d1b`.
- [Image run 41926803244](https://github.com/constbogdan/seerr/actions/runs/41926803244)
  succeeded. The public `linux/amd64` manifest/config matches that digest, source
  revision and version, and declares Node 22.23.4.
- The source Dockerfile pins Node 22.23.4 / Alpine 3.23. The frozen dependency
  tree selects the `sqlite3` **driver** 6.0.1; this is not a SQLite engine version.
  Successful image construction alone is not a production database acceptance test.

November 5, 2026 deployment acceptance has separate evidence levels:

- **Operator-reported Docker/UI observations:** the NAS container used the
  expected digest/source, was healthy with zero restarts, and the manually
  inspected UI appeared correct.
- **Supplied runtime-log observations:** the operator's acceptance summary of
  `seerr-custom-logs.txt` reports successful startup, SQLite-backed operation,
  scheduled jobs, Jellyfin synchronization, Library History hydration, Watchlist
  synchronization, Fresh and acquisition-provider checks. These are observations
  from that deployment, not exhaustive feature or data-integrity acceptance.
- **Backup evidence:** the operator recorded
  `/volume2/docker/_backup/seerr/seerr-pre-v1.0.42-20261105-102648.tar.gz`.
  Its existence as reported does not prove a restore rehearsal or archive integrity.

No consolidated local acceptance report exists. This reconciliation did not
access production or independently reparse the earlier uploaded runtime log and
Docker inspect output; it records the operator-supplied observations separately
from the public artifact checks above. Effective mode and persistent mount
identity must be checked from their explicit runtime/config evidence, not inferred
from HTTP health or successful jobs alone. Long-term stability, exhaustive feature
acceptance and a verified backup restore remain unclaimed.

### Runtime and persistence contract

The first Library-enabled deployment uses one Seerr application process in one container with one
mounted configuration directory and the default SQLite database. Do not run replicas, overlapping
supervisors, or two containers against the same SQLite database or `settings.json`. In-process request
identity locks and coordinated JSON/database settings updates assume this single-writer application
topology; SQLite file locking is not a replacement for application ownership.

PostgreSQL remains a supported upstream database target, but this downstream release does not claim
multi-replica application support. Servarr configuration continues to be stored in the local JSON
configuration while Storage Root presentation is stored in the database, so sharing PostgreSQL alone
does not make multiple application processes safe. Multi-process deployment requires a separate design
and runtime validation.

The production database target for the first Library-enabled release is SQLite.
Paired PostgreSQL migrations remain in the source tree, but downstream runtime
and concurrency acceptance on PostgreSQL is still outstanding. TMDB queueing,
cold-request coalescing, request-identity locks, and settings serialization are
process-local even when the database is PostgreSQL.

Follow the [first-production deployment runbook](FIRST_PRODUCTION_DEPLOYMENT.md)
for the UGREEN/Dockhand upgrade, history-import evidence, backup, and rollback
procedure. The rolling `custom` tag is not deployment authority; Dockhand must
be pinned to the approved immutable GHCR digest.

Normal operation uses `SEERR_SYNCHRONIZATION_MODE=normal` (also the unset default),
with ordinary schedules, recovery and catch-ups. Contained/commissioning modes
are explicit commissioning tools, not the normal deployed operating model.
Verify the effective mode after restart. The image has no Dockerfile `HEALTHCHECK`;
record the Dockhand/container healthcheck separately. An HTTP response proves
reachability, not provider connectivity or complete synchronization coverage.

Retain the previous immutable image and an application-consistent database plus
matching settings/config backup. Stop the single writer for a full config copy,
or use an approved consistent snapshot/SQLite backup procedure; never copy a live
SQLite file as though it were a consistent backup. Verify restore integrity in
isolation. Across forward migrations, restore the matching pre-upgrade recovery
set before starting the old image; do not assume switching image tags reverses
schema or settings changes. Retained legacy Fresh tables are not a rollback plan.
