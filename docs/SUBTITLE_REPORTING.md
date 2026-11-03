# Subtitle issue reporting — backend contract (Stage A)

`POST /api/v1/integrations/jellyfin/subtitle-issues`

```http
Authorization: Bearer <Jellyfin user access token>
Content-Type: application/json

{"itemId":"<Jellyfin item GUID>"}
```

The only body field is `itemId`. Query parameters, user/metadata identities,
descriptions and destination URLs are not accepted. A new report returns
`201 {"status":"created"}`; an equivalent open report returns
`200 {"status":"already-reported"}`. Neither response exposes issue IDs,
other reporters or comments. Errors contain a `message` (see OpenAPI for statuses).

## Trust and deployment prerequisites

- In the existing Jellyfin service settings, enable **Subtitle Issue Reporting**
  explicitly (default **disabled**, including existing settings). The section's
  read-only **Jellyfin Web Origin** reuses the HTTPS origin of the existing
  **External URL**; there is no second connection or persisted origin field.
  Path-based External URLs remain valid. Enabling, or changing that URL while
  enabled, rejects non-HTTPS URLs, userinfo, queries and fragments server-side.
  Disabled reporting permits no CORS authorization or provider/issue access.
- Configure Seerr's existing **application URL** with its public HTTPS base URL;
  generated links never use request Host/Origin. Base paths are supported.
- Terminate public HTTPS at Seerr or a correctly configured trusted reverse
  proxy. Seerr must see `req.secure`; preserve Authorization and Origin. Do not
  permit arbitrary clients to spoof trusted forwarding headers. HTTP is allowed
  only for loopback development when the configured application URL is loopback.
- The configured internal Jellyfin destination may retain its existing LAN HTTP
  configuration. Protect that network leg appropriately; the user's token is
  sent to this fixed destination, never to a client-specified server.
- Users must already be linked by Jellyfin GUID and have `CREATE_ISSUES` or
  `MANAGE_ISSUES`. `/Users/Me` is checked on every report, including duplicates;
  disabled users or responses without an explicit enabled policy fail closed.
  There is no separate Seerr disabled-account flag. No user is provisioned.
- A typed Seerr Media row must already exist. Reporting creates no Media,
  request, availability, Watchlist or provider state.

Native clients may omit Origin but must supply the same user token. Browser
requests require JSON plus Authorization (preflight permitted only for the
configured origin). Cookies and Seerr API keys are not authentication for this
route. Only its exact POST/OPTIONS path is exempt from the cookie CSRF middleware;
all other routes retain their existing protection. CORS is not authentication.

Provider requests have five-second timeouts, bounded response sizes and **no
redirects**. Tokens are neither persisted nor placed in URLs, logs or error
objects returned to clients. Provider errors are translated to fixed messages.
Read-only authentication/item lookups are the only Jellyfin operations.

Abuse limits per process: 10 reports/verified user/minute, 30 attempts/IP/minute,
120 attempts globally/minute and eight concurrent verifications. State is bounded
to 4,096 expiring counter keys. `429` includes `Retry-After: 60`. Multi-replica
deployments also need edge limits; these counters are not distributed.

## Identity, issue scope and notifications

Movies use Movie TMDB identity; Series use Series TMDB identity. Episodes always
fetch the parent Series through the verified user's access context. Episode TMDB
IDs are never interpreted as Series IDs. Missing coordinates, nonintegers,
out-of-range values or multi-Episode ranges are rejected without a Series-wide
fallback. Season 0 / positive Episode is a Special; 0/0 remains Series-wide.
Seerr's existing issue views/notifications distinguish those scopes.

Regular Seasons resolve the parent Series through Jellyfin's authoritative
`SeriesId` and take their scope only from the Season's positive integer
`IndexNumber`. They use the existing `problemSeason=N`, `problemEpisode=0`
representation (selected Season, all Episodes). Child provider IDs and title
text are never used to infer identity or Season. Season 0 detail pages do not
show the action, and direct Season 0 reports are rejected rather than falling
back to Series-wide. Individual Specials Episodes remain supported as `0/N`.
Regular Season reports retain the same permission, attribution, duplicate and
notification paths; no scope discriminator or schema change is introduced.

The message contains the authoritative Jellyfin title, Movie year or SxxExx,
configured Seerr details URL and the submitted Jellyfin item GUID. Creation reuses
the normal Issue/initial-comment persistence and notification subscribers. A
duplicate adds neither a comment nor a notification and retains original
attribution. Existing issue permissions and manual workflows remain unchanged.

## Database serialization

Equivalent means `(Media.id, SUBTITLES, Season, Episode, OPEN)`. Reports lock the
existing Media parent before searching for an open issue, including when there
is not yet an Issue row. Resolved issues do not block new reports.

- PostgreSQL: short READ COMMITTED transaction, parent `FOR UPDATE`, bounded
  two-second lock wait, then fresh duplicate lookup and normal creation.
- SQLite: first transactional statement is a no-op parent UPDATE, acquiring the
  database write reservation before reading issues. The raw statement does not
  touch Media timestamps/subscribers. The existing write coordinator additionally
  prevents overlapping report transactions on TypeORM's shared SQLite connection;
  independent connections remain guarded by the database lock.

There is no migration, new table or process-only uniqueness assumption. Jellyfin
verification finishes before the transaction; existing notification subscribers
retain their TMDB metadata lookups. Busy/lock errors return sanitized `503`; retrying
rechecks the same key. This does not impose a new uniqueness policy on manual
issue creation/reopening. Existing notification subscribers retain their normal
delivery model, not a new durable outbox/exactly-once transport guarantee.

## Delivery boundary

Stage A implements the backend contract. Stage B's disabled-by-default Jellyfin
Web integration is described below; Mosaic is not implemented. The operator has
reported manual functional acceptance for Movie, Series, regular Season and
Episode reports, duplicate prevention, linked-user attribution, Jellyfin Web and
the Windows app. This is operator-reported local acceptance, not a claim that
all native Jellyfin clients or versions are supported. PR preparation does not
create live issues, deploy the integration or change installed Injector scripts.

## Original Stage B same-origin investigation (2026-10-25; superseded)

This section preserves the earlier routing evidence. The direct HTTPS design
below supersedes the proposed same-origin proxy prerequisite; no proxy changes
are required or authorized for the current candidate.

Read-only inspection on 2026-10-25 confirmed Jellyfin Server 10.10.7 and an active
JavaScript Injector 3.5.0.0. The Web entry page loads the Injector's public bundle
and authenticated private-script loader. The public bundle is empty; the enabled
private `Native User Likes` script supplies the existing Like/Dislike controls.
No subtitle-report script has been installed or enabled.

The existing Likes script locates `.detailButtons, .mainDetailButtons` and uses
`.jf-like-button.like` / `.jf-like-button.dislike`. The version-pinned Web details
template uses `#itemDetailPage .mainDetailButtons` and `.btnUserRating`. Its
controller sets rating buttons from the current authoritative item and handles
`viewshow`, `viewbeforehide` and `viewdestroy`, including restored views after
playback. The deployed API-client bundle exposes `getItem`, `getCurrentUserId`
and `accessToken`. These are compatibility findings, not an implemented action
or a verified toast-module loader.

The required same-origin route was **not verified**. Non-mutating probes of the
exact `/api/v1/integrations/jellyfin/subtitle-issues` path produced:

| Probe                               | Deployed Jellyfin HTTPS origin                 | Required restricted handler               |
| ----------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| GET                                 | Empty 404, matching Jellyfin's direct listener | Unsupported method; no issue creation     |
| OPTIONS, configured Jellyfin origin | 204, `Access-Control-Allow-Origin: *`          | 204, exact configured origin, no wildcard |
| OPTIONS, unrelated origin           | 204, `Access-Control-Allow-Origin: *`          | 403, no permissive CORS header            |

These responses do not demonstrate forwarding to Stage A. A generic edge/Jellyfin
preflight response must not be mistaken for working Seerr integration. No POST,
issue creation, provider mutation or production configuration change was made.
Per the Stage B instruction, client implementation is paused at this routing gate.
If a restricted proxy already exists under another path, its exact approved path
and forwarding policy must be supplied and verified instead of guessing aliases.

### Required routing (operator prerequisite, not deployed configuration)

Use the existing reverse proxy; no additional service or container is needed:

- On the Jellyfin Web HTTPS origin, match **only** the exact
  `/api/v1/integrations/jellyfin/subtitle-issues` path.
- Forward POST and OPTIONS to the same exact path on an explicitly approved
  Seerr instance running Stage A. Reject other methods with 405. Do not expose
  Seerr's general API, administrative routes, or a client-selected upstream.
- Preserve the user's `Authorization: Bearer ...`, JSON Content-Type and original
  Origin header. Never inject a Seerr API key, impersonation header, administrator
  token or a synthetic trusted Origin. Strip unrelated Cookie, X-Api-Key and
  X-Api-User headers on this dedicated location.
- Forward OPTIONS to Seerr's route rather than answering it through Jellyfin's
  wildcard CORS policy. Preserve Seerr's status, JSON acknowledgement/error and
  origin-restricted CORS headers, including Retry-After and Cache-Control.
- Preserve verified HTTPS/client-address information through a correctly trusted
  proxy chain. Do not accept client-spoofed forwarding headers or disable CSRF.
- Do not cache requests/responses or follow upstream redirects. Do not record
  Authorization headers or include tokens in access logs, URLs or query strings.
- Configure Seerr's existing application URL and Jellyfin external hostname as
  described above. The local harness's application URL is currently unset; no
  harness or production settings were changed during this inspection.

Before resuming, verify the allowed/disallowed-origin OPTIONS behavior and
method restriction without creating issues. The browser implementation can then
use a fixed relative URL with the current Jellyfin item ID and current user token;
there is no need for cross-origin fallback, separate login or new credentials.
Install the reviewed self-hosted code as a separate authenticated Injector script,
leaving `Native User Likes` unchanged. Script installation, executable UI tests
and desktop/mobile acceptance remain pending; nothing is ready to enable yet.

## Stage B — direct HTTPS integration (2026-10-26)

Direct HTTPS works with the existing Stage A contract. A same-origin relay is not
required when Jellyfin Web can reach the explicitly configured Seerr HTTPS origin
and Seerr permits that exact Jellyfin Web Origin. No backend authentication,
request contract, CSRF or CORS code was changed for Stage B.

### Script and installation

Source: `public/integrations/jellyfin-subtitle-report.js`. It is a standalone,
self-hosted IIFE with no build, CDN or extra service dependency. The delivered
`SEERR_ORIGIN` is deliberately **empty**: supported details pages show a disabled
button and even a programmatically dispatched click cannot submit a report.

After review, configure only `SEERR_ORIGIN` in the trusted script source with an
explicit HTTPS origin, without a path, trailing slash, query, fragment or userinfo.
There is no production URL in the browser asset and it never reads its destination
from media metadata, DOM attributes, URL parameters, storage or server responses.
The API path is fixed. Invalid configuration also leaves the action disabled.

In Dashboard → Plugins → JavaScript Injector, add a separate script entry, paste
the reviewed source, and select **Requires Authentication**. Do not replace or
edit `Native User Likes`. Enable only in a separately approved installation and
reload the Web client. No script entry or production setting was changed here.

### Runtime and security

- The current `window.ApiClient` supplies `getCurrentUserId()`, `getItem()` and,
  only on explicit activation, `accessToken()`. The item ID is read from the
  details route and checked against the authoritative returned identity/type.
  Movie, Series, regular Season and Episode are supported. Season 0, malformed
  Season indexes and unrelated pages do not show the action.
- The compact native `button-flat detailButton` subtitle icon follows the current
  `#custom-jellyfin-likes` group, or the native Favorite control when Likes is
  absent (including Episodes). Existing controls and handlers are untouched.
- View show/hide/destroy events, hash/history navigation and page hide/show manage
  lifetime. A coalesced MutationObserver watches only the active detail view for
  late action rendering. Stale reads, user/server/item changes, repeated injection,
  disposal and in-flight navigation are guarded without interval polling.
- POST contains only `{itemId}` and `Authorization: Bearer <current Jellyfin user
token>`. Fetch uses `mode: cors`, `credentials: omit`, `redirect: error`, no-store
  and no-referrer. There is no extra token store, Seerr key or separate login.
- Pending clicks are disabled/guarded. Navigation aborts the client wait; it cannot
  undo a request already accepted by the server. No automatic retries occur;
  Stage A remains responsible for duplicate protection.
- Success, already-reported and fixed sanitized error messages use Jellyfin's
  existing toast classes, with a polite live region. The upstream toast function
  is module-private, so the adapter reuses its deployed CSS/DOM convention rather
  than reaching into webpack or displaying dialogs. No provider payload is shown.

### Isolated acceptance and limits

Run the explicit browser acceptance (not the full application suite):

```powershell
pnpm test server/test/subtitleReporting.browser.ts
```

This uses the real Stage A router/OpenAPI validator and CSRF middleware under a
temporary HTTPS listener on **127.0.0.1:5058**, an in-memory SQLite test database,
mocked Jellyfin/notification calls and a disposable Chromium profile. It does not
import application startup, run jobs or use harness configuration. Port 5057's
existing harness is not used. The temporary listener, profile and certificate
are closed/removed after the run.

Chrome and OpenSSL must be installed. `SUBTITLE_TEST_CHROME` and
`SUBTITLE_TEST_OPENSSL` may select their executables. The fixture certificate is
pinned by SPKI only in that temporary profile; TLS/CORS checks are not globally
disabled. Synthetic Jellyfin-origin documents are fulfilled by CDP and production
network requests are blocked. Only the local HTTPS fixture may reach a socket.
Its loopback-network permission is explicitly granted in that temporary profile
to test CORS independently of Chromium's separate Local Network Access gate.

Coverage includes real HTTPS preflight/POST, exact-origin acceptance, unrelated
origin rejection, expired tokens, ordinary-route CSRF protection, Movie/Series/
Episode requests, default/invalid configuration, duplicates, fixed feedback,
current-token use, SPA races/cleanup, unsupported identities, redirect refusal,
touch and keyboard activation. All created Issues belong solely to test fixtures.

Deployment still requires an approved reachable Seerr HTTPS origin with a valid
certificate, the Stage A code and existing linked-user permissions/settings.
Jellyfin's CSP, if restricted, must permit that origin in connect-src. A public
Jellyfin page calling a LAN/loopback Seerr address may additionally require the
browser's Local Network Access permission; this is not solved by CORS and is not
bypassed by the script. A public HTTPS Seerr endpoint avoids that private-network
hop. Actual authenticated production-page visual acceptance remains manual and
not part of automated PR validation; the automated UI uses inspected DOM
conventions in local fixtures. The operator's manual acceptance is recorded above.

### Troubleshooting and rollback

- A disabled button means the trusted script origin is empty or invalid. Set
  only an explicit HTTPS origin; do not disable certificate validation or add
  credentials to work around an error.
- For a missing button, verify the authenticated Injector entry is loaded, the
  current detail item is supported and its authoritative identity is available.
  Season 0 detail pages are intentionally excluded; individual Specials Episodes
  are supported.
- A browser network/CORS error requires checking certificate trust, the exact
  derived Jellyfin Web Origin, CSP `connect-src` and any Local Network Access
  permission. CORS does not replace authentication or grant issue permissions.
- `401` requires a valid current Jellyfin user session; `403` can indicate disabled
  reporting, an origin mismatch or missing linked-user issue permission. `404`
  requires existing typed Seerr Media, `422` indicates unresolved identity/scope,
  `429` requires waiting, and `502`/`503` require checking service availability.
  Do not include tokens or provider payloads in diagnostics.
- Roll back browser installation by disabling/removing only the separate subtitle
  Injector entry. Disable Subtitle Issue Reporting in Seerr's existing Jellyfin
  settings to reject new reports immediately. Existing issues remain available
  through ordinary issue management; no schema rollback or data deletion is needed.
- PostgreSQL lock ordering has executable query-contract coverage, but real
  PostgreSQL concurrent-report acceptance remains unverified. Process-local rate
  limits also require additional edge coordination for multi-replica deployments.

### Native User Likes initialization investigation (2026-10-26)

Read-only inspection of the installed JavaScript Injector 3.5.0.0 configuration
confirmed two enabled, authenticated entries: `Native User Likes` and
`Submit Subtitle Issue`. Neither installed script was modified by this task.
This is newer evidence than the earlier uninstalled-candidate checkpoint above.

The deployed Web entry's Injector loader checks authentication every 300 ms,
waiting for `ApiClient`, its current user and `serverInfo`, then downloads the
authenticated `private.js` once and executes both entries. That delivery wait is
shared; it does not explain the extra delay of Likes after the subtitle action.

In the installed Likes source, `context()` (lines 57–74) waits for `ApiClient`,
the visible details page, route item ID and current user ID. `render()` checks
the action bar and existing user/item control (112–126), then awaits the
user-scoped `getItem()` (132–142) for `UserData.Likes`. Only afterward are buttons
inserted (145–214). That wait is necessary to display the correct user rating.

The avoidable delay is the sole initializer: `setInterval(..., 1000)` (224–239),
with no immediate render, view events or DOM observer. Authentication/page/action
readiness and SPA changes are detected on the next tick; a missed readiness
condition waits another tick. The global `rendering` guard also defers a new
item while an old read is pending. Timer delay (up to a nominal one second per
readiness opportunity, longer if browser-throttled) plus the item request explains
the additional latency; these are source-derived bounds, not a measured trace.
The subtitle candidate instead schedules immediately and on Jellyfin view/history
events, with a coalesced active-page observer for late controls.

Smallest recommended correction, requiring separate installation approval:
retain the rating fetch, selected state, mutation handlers and generation checks;
replace the permanent interval with an immediate coalesced attempt plus
`viewshow`/hide/destroy and history listeners, and a scoped observer for late
action-bar readiness. Reconcile after an old pending read finishes, verify the
current user/page/item before insertion and clean up on navigation. Do not insert
unhydrated interactive Like/Dislike controls or delay the subtitle action to
match the polling script. No Likes implementation or provider rating was changed.
