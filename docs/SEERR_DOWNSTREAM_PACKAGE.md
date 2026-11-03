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
