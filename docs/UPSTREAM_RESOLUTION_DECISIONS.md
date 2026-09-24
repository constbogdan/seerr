# Upstream resolution decisions

This compact log preserves useful context from completed semantic reviews. Previous decisions are
context, not authority: every future `REVIEW` path must be evaluated against its new upstream
change, current Mosaic behavior, and the authenticated candidate evidence.

## PR #106 — upstream `365f8f8`

- Episode: `0d04a7ca2773ce58dd1b7f33d0d8c86be29f4f17b19d85c5e51ea5a163844916`
- Upstream: `365f8f8adacf4dcaf7d05317917830ed3a439668`
- Original downstream baseline: `4a6db6df866c4182576a3a9f96e3de697d5596e7`
- `.github/workflows/main.yml` and `.github/workflows/release.yml` remain absent as
  `DOWNSTREAM-OWNED` publication authorities.
- `.github/workflows/pr.yml` remains absent by deliberate semantic `REVIEW`; it remains a
  `REVIEW` path. Mosaic's `.github/workflows/ci.yml` is the canonical PR-validation authority, but
  future upstream `pr.yml` changes remain worth reviewing for underlying CI improvements.
- This upstream `pr.yml` changed Gradle heap from 8 GiB to 12 GiB and metaspace from 512 MiB to
  1024 MiB. Mosaic currently uses `org.gradle.jvmargs=-Xmx2048m -Dfile.encoding=UTF-8` without an
  explicit metaspace cap; no resource-setting change was adopted implicitly.
- `.github/actions/setup/action.yml` retained Mosaic's explicit Android platform, Build Tools, and
  NDK provisioning while accepting compatible upstream pinned-action digest updates.
- `IntentService` retained upstream home/missing-item navigation and playback validation together
  with Mosaic's dynamic application-ID playback action and legacy compatibility.
- `HomeViewModel` retained upstream reactive user/settings loading and Mosaic acquisition-state
  collection. Acquisition items must survive the user/settings reset and reload transition.
- Focused regression coverage: `HomeViewModelTest`, `IntentServiceTest`,
  `HomeAcquiringSourceTest`, and `HomeAcquiringFixturesTest`.
