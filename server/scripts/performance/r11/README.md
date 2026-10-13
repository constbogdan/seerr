# R11 performance fixtures

These fixtures preserve the pre-optimization R11 workloads. They are diagnostic
benchmarks, not timing-sensitive unit tests. Unit tests validate workload shape;
the benchmark commands record measurements and compare later R11 batches against
the checked-in baseline.

## Safety and isolation

- Backend measurements force `NODE_ENV=test`, create an in-memory SQLite schema,
  use a temporary configuration directory, and expose TMDB only to a loopback
  mock server.
- Browser measurements require the exact supported production Turbopack build
  produced by `pnpm build:next` and start a
  frontend-only custom Next server whose same-origin API routes are fulfilled by
  local mocks. Unknown API routes fail the benchmark. No Seerr backend or
  scheduler is started.
- Ports 5070 and 9229 must be free. The runner refuses to reuse them.
- Chrome uses a temporary profile which is removed on exit.
- Neither command writes results unless `--output <path>` is supplied.

## Commands

```powershell
pnpm build:next
pnpm benchmark:r11:backend -- --output .tmp/r11-backend.json
pnpm benchmark:r11:browser -- --output .tmp/r11-browser.json
pnpm benchmark:r11:browser -- --cold-presentation-only --output .tmp/r11-cold-presentation.json
pnpm benchmark:r11:browser -- --r11d-only --output .tmp/r11d-browser.json
pnpm benchmark:r11:browser -- --r11e-only --output .tmp/r11e-browser.json
pnpm benchmark:r11:browser -- --r11f-cross-page-only --output .tmp/r11f-cross-page.json
pnpm benchmark:r11:browser -- --r11f-interactions-only --output .tmp/r11f-interactions.json
pnpm benchmark:r11:browser -- --r11g-library-only --output .tmp/r11g-library.json
pnpm exec ts-node -r tsconfig-paths/register --files --project server/tsconfig.json server/scripts/performance/r11/chromeSmoke.ts --recovery-only
```

Set `R11_CHROME_PATH` when Chrome is not in a standard platform location.

## Workloads

- Library: 10, 25, 50, and 100 cards, three production-browser repetitions.
  Every card carries six Watchlist users, six Last Active users, four Watched
  users, three Requesters, storage roots, ratings, Series Seasons, and normal
  plus 4K Radarr/Sonarr external actions. The browser runner rejects unsupported
  SVG module output and asserts that every external action contains an SVG.
- Eligibility: 10, 50, and 100 mixed Movie/Series/Season targets. Each ten-target
  block has four unscheduled targets and one each of scheduled, live legacy lease,
  whole-Series conflict, non-current, ambiguous-source, and configuration cases.
- TMDB: cold, warm, ten-way concurrent duplicate, configured finite-timeout,
  delayed-response, and benchmark-bounded timeout-control cases. Post-R11-C
  output also records the process-shared request coordinator limits.
- Cold Library presentation: the focused production-browser mode proves the
  canonical first render, one bounded batch-status request, one Library
  revalidation, localized titles, and Collection banners without starting the
  application backend.
- Responsive: 390, 640, 900, and 1440 CSS-pixel viewports.
- Infinite scroll: Watchlist mounts 60 cards, receives five scroll events, then
  navigates away to verify listener cleanup.

## Interpreting results

Hard correctness requirements fail the runner:

- fixture cardinality and identity are exact;
- eligibility reasons exactly match the deterministic ten-case pattern;
- SQL counts are identical across repetitions;
- Library renders the requested row count;
- representative focus-triggered tooltips open and close;
- every requested API endpoint is locally mocked;
- the Watchlist route mounts and unmounts successfully.

Performance targets do **not** fail R11-A because they describe defects that later
R11 batches are expected to correct. Compare medians and p95 values on the same
machine/build. Latency, heap, and long-task measurements should be treated as
directional when the host differs; SQL counts, provider-call counts, listener
counts, and overflow pixels are deterministic regression signals.

The original R11-A measurements remain in `baseline.json`, including their
Webpack provenance. The corrected authoritative production-browser measurements
are in `browser-baseline-turbopack.json`. Runners can write their full raw records
outside the checkout with `--output`; those files intentionally include more
diagnostic DOM geometry than the compact checked-in baselines.

Accepted post-optimization targets are defined in `fixtures.ts`:

- no more than 12 eligibility SQL statements at 100 targets;
- SQLite p95 below 75 ms at 100 targets on the reference host;
- one concurrent request for identical cold TMDB identities;
- at most one closed-tooltip document listener;
- maximum 100 ms single and 250 ms aggregate long-task time at 100 cards;
- zero horizontal overflow at every measured viewport.

Do not replace the baseline simply because a number changed. Baseline updates
require an explicit workload or measurement-method review.

## Build precondition

The browser runner inspects the emitted `/library` chunks before starting Chrome.
It refuses Webpack-style static-image Radarr/Sonarr modules with an instruction to
rebuild using `pnpm build:next`. At runtime it also requires accessible Radarr,
Radarr 4K, Sonarr, and Sonarr 4K links to contain real SVG elements and rejects
console errors or uncaught exceptions. Webpack is not an R11 production target.

`--r11d-only` runs the four responsive Library overflow checks and the Watchlist
scroll-listener mount/scroll/unmount probe without repeating the DOM, heap, or
TMDB workloads. It requires zero overflow, sticky chrome aligned to the Layout
container, stable listener counts while scrolling, exactly one listener-pair
cleanup on unmount, and no duplicate Watchlist pagination request.

`--r11e-only` repeats the authoritative 10/25/50/100-card workload three times,
then probes the shared Tooltip at every responsive width. It asserts that closed
tooltips own no native mousemove or document positioning listeners, verifies
focus, pointer, cursor-following, touch, Escape, and outside-click behavior, and
confirms an active Watchlist tooltip releases its portal and document listener
when the TitleCard page unmounts. Timing and heap targets remain reported
measurements rather than correctness shortcuts.

`--r11f-cross-page-only` cycles Library, Watchlist, Leaving Soon, Fresh, and
Requests three times at mobile, tablet, and desktop widths. It records heap, DOM,
listener, focus, tooltip, and overflow state after garbage collection and
rejects unmocked API access or browser runtime errors.

`--r11f-interactions-only` measures the incremental production-browser work for
single-item selection, Series expansion/collapse, sorting, searching, and page
size replacement after a 100-card Library page has settled.

`--r11g-library-only` repeats the production Library workload and records the
first mounted batch, every subsequent batch, time to complete mounting, browser
yield delay, cumulative layout shift, and the existing DOM/heap/listener/long-task
measurements. `--r11g-smoke` limits this mode to one 100-card run while choosing
a batch size. The interaction mode also selects a card during the first batch,
starts sort and search changes before mounting settles, and navigates away from
an incomplete mount to verify cancellation and state preservation.

The cross-page mode installs a measurement-only `EventTarget` audit before the
application loads and records live listener types and target categories. This
distinguishes listeners on the current DOM from framework counters and makes
capture-option cleanup regressions attributable without retaining DOM nodes in
the audit itself.

The isolated Windows browser runner uses `--no-sandbox`. Chrome 154's sandboxed
GPU and renderer subprocesses cannot access their disposable profile under the
managed validation environment: the GPU exits with `0xC0000022`, followed by
`GPU process isn't usable`, or page-domain commands never answer. The runner is
restricted to a temporary profile, loopback-only mocked endpoints, and a
dedicated debugging port. `chromeSmoke.ts --recovery-only` verifies two targets,
six sequential navigations, clean browser exit, and profile cleanup before a
larger benchmark is attempted.
