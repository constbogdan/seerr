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
