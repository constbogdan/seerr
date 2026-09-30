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
- **Admit to Fresh** overrides ordinary automatic admission policy only after a
  valid typed canonical identity exists. Movie, explicit Season/Special, and
  typed TV-series identities are supported. A TV-series override with missing
  season evidence is stored as series-level `legacy_tv`; it preserves **Season
  Unknown** and never fabricates a season. No Match, Ambiguous, transient
  provider failure, unresolved identity, invalid TMDB identity, or an untyped
  numeric ID cannot be admitted directly. Automatic reasons remain visible and
  truthful while an override determines effective membership.
- **Remove override** restores automatic policy. Re-adding an override reuses
  the original history and cannot create a new Fresh clock.
- **Dismiss / Show** controls only whether a stable source-evidence identity is
  included in Candidate Diagnostics' default Visible view. This preference is
  durable across sync, restart, source-generation changes, and rebuild; it does
  not alter resolution, admission, discovery history, or public Fresh results.
  Administrators can select only the currently loaded diagnostics page and
  apply Dismiss or Show atomically; a stale selected revision rejects the whole
  bulk operation.

All mutations are administrator-only, revision-bound, and serialized with sync,
reconciliation, and rebuild operations. Candidate Diagnostics is the durable
work queue; transient Pipeline decisions are operational telemetry.

Candidate Diagnostics uses these operational categories:

| Category | Meaning | Corrective actions |
| --- | --- | --- |
| Needs Attention | Identity cannot be used safely: No Match, Ambiguous, or a technical identity conflict. | Resolve to an exact typed TMDB identity (or reset an existing manual resolution where present). |
| Reviewable | The typed identity is stable but automatic admission policy excluded it, including an old Movie, content-policy exclusion, or TV series with missing season evidence. | Admit to Fresh deliberately; remove an existing override when present. |
| Active Fresh | The durable identity is currently admitted and visible. | No admission correction is required. |
| Historical | Retained evidence is transient, pending, still resolving, expired, or inactive for the current source generation. | Informational by default; exact typed correction remains available for safely recognized inactive evidence. |

Dismiss is never considered a corrective action and therefore does not, by
itself, place a row in **Needs Attention**. No Match and Ambiguous candidates
must be resolved before they can be admitted. Stable typed policy exclusions,
including movie eligibility and content-policy exclusions, may retain **Admit
to Fresh**; an override cannot invent identity and does not erase the automatic
reason.

Date-named TV releases such as `The.Price.Is.Right.2026.09.29` remain explicit
source evidence but do not currently establish a season. The autobrr boundary
does not reinterpret the date as `SxxEyy`, and Seerr's current TMDB adapter can
only fetch episodes after a season is known. Searching arbitrary seasons would
weaken ambiguity and request bounds, so this case remains conservatively
**Season Unknown** unless an administrator supplies typed identity; no season
is guessed.

The **Source Samples** column is derived from bounded, sanitized
`FreshObservation.sourceTitle` evidence. It remains distinct from the parsed
candidate title and the canonical TMDB title. It may contain a release/event
name useful for diagnosis, but never raw provider payloads, authenticated URLs,
or credentials.

Single and bulk Dismiss/Show update the loaded Candidate Diagnostics page and
summary optimistically, preserving the current filters and page. If the last
row is removed, the nearest valid page is loaded. A background revalidation
then confirms the revision-bound server result without a disruptive full-table
reload.

Administrators can reach Candidate Diagnostics through an icon-only,
keyboard-accessible shortcut at the far right of the Discover Fresh row header
and inline with the filters on `/fresh`. The Discover shortcut is separate from
the Fresh-page navigation control. Its accessible label and tooltip are
**Candidate Diagnostics**, and it opens Fresh Settings at the stable
`#candidates` target. Non-administrators do not receive the shortcut.

## Rebuild and continuity

**Rebuild Fresh Data** clears and reconstructs only source-derived observations,
candidates, checkpoint state, and the current source projection. It preserves:

- typed canonical media metadata;
- irreversible Movie/Season/Special histories;
- typed manual resolutions and provenance;
- admission overrides and provenance.
- Candidate Diagnostics visibility preferences.

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
