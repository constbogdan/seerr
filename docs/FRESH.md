# Fresh discovery

Fresh intersects release evidence from one authenticated numeric autobrr filter
with deterministic TMDB identity and downstream discovery policy. It is not
request, acquisition, download, Jellyfin availability, or permanent tracker
state.

## Identity and admission

- A movie identity is `(movie, tmdbId)`. Its first selected-filter observation
  may qualify inside the configured movie window or the fixed 14-day
  first-observation grace. Digital observations prefer TMDB Digital dates;
  Blu-ray/UHD observations prefer Physical dates. Fallbacks are deterministic
  and never invent a date.
- An ordinary TV identity is `(tv, tmdbId, seasonNumber)`. Admission uses the
  latest episode aired by the observation time (with the bounded one-day date
  tolerance), then a trustworthy season date when episode dates are absent.
  Parent-series age is not admission evidence.
- An explicit special is `(tv, tmdbId, special, episodeNumber)` and uses the
  exact special episode's air date. A bare or uncorroborated season zero remains
  unknown.
- Public TV presentation remains one canonical series card. When more than one
  season/special is currently visible, the newest immutable admission controls
  ordering; the individual histories remain independently durable.
- Canonical identity is always the typed pair `(mediaType, tmdbId)`. Numeric
  TMDB IDs are not globally unique across Movie and TV namespaces.

An admitted Movie, Season, or Special has one irreversible Fresh clock.
Additional episodes, packs, PROPER/REPACK/REMUX releases, qualities, title
punctuation variants, source-generation changes, and rebuilds may add evidence
but cannot reset `firstFreshAt` or `visibleUntil`.

## Automatic and human state

Fresh preserves source/parsed evidence, automatic typed resolution, automatic
admission and content-policy reasons, optional typed manual resolution, optional
admission override, and effective presentation as separate concepts.

- **Resolve** validates the administrator-selected Movie/TV namespace and TMDB
  ID server-side. The durable decision is bound to versioned sanitized source
  evidence and can correct both type and ID without rewriting parsed evidence.
- **Reset resolution** deactivates that human mapping and restores the current
  automatic result. It does not erase source evidence or discovery history.
- **Admit to Fresh** overrides a stable automatic policy exclusion only after a
  typed identity and Movie/Season/Special identity exist. It cannot override No
  Match, Ambiguous, transient provider failure, unknown TV season, an already
  active item, or expired history.
- **Remove override** restores automatic policy. Re-adding an override reuses
  the original history and cannot create a new Fresh clock.

All mutations are administrator-only, revision-bound, and serialized with sync,
reconciliation, and rebuild operations. Candidate Diagnostics is the durable
work queue; transient Pipeline decisions are operational telemetry.

## Rebuild and continuity

**Rebuild Fresh Data** clears and reconstructs only source-derived observations,
candidates, checkpoint state, and the current source projection. It preserves:

- typed canonical media metadata;
- irreversible Movie/Season/Special histories;
- typed manual resolutions and provenance;
- admission overrides and provenance.

Evidence already pruned by autobrr cannot be recovered. A missing authenticated
checkpoint must remain `GAP_PRESERVED`; use the explicit Fresh reconciliation
operation after backing up the isolated runtime. Reconciliation establishes a
new source generation from retained history without claiming the missing source
interval was observed. Old-generation evidence cannot activate current cards,
while matching durable histories and human decisions remain available.

## Data minimization

Fresh persists bounded, sanitized observation evidence and durable identity /
decision history. It must never persist or expose autobrr tokens, credentials,
download URLs, tracker/private URLs, passkeys, cookies, raw action payloads,
Axios objects, raw provider errors, or full TMDB responses. Public `/fresh`
returns the paginated effective media projection only; candidate evidence and
mutation endpoints remain administrator-only.
