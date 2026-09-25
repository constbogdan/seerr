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

`N` is the protected `downstream-main` first-parent distance from the fixed downstream image epoch.
Upstream side-history commits do not independently allocate versions. The first-parent model and
`custom-` namespace prevent confusion with official Seerr versions.

Each publication summary records the version, source SHA, digest, build link, comparison with the
previous protected-main image, and whether authenticated upstream synchronization provenance was
available. Until upstream-sync automation records a durable upstream base/tip pair, the publisher
does not claim one.
