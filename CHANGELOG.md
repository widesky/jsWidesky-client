# Change Log
All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).

## [Unreleased]

### Added
- [CORE-9592](https://widesky.atlassian.net/browse/CORE-9592): Batch operations report progress per request and log each request's outcome.
  - A `progress` reporter can be given per call; `RequestProgress` is a ready-made line-based reporter.
  - Each request is logged at debug level with its duration, retries and size, and each operation ends with an info summary.
  - `client.features.batchProgress` reports that the client supports this.
  - `batch.hisDelete` also reports planning progress per group of points, before any delete is sent.
  - Batch operations log at trace (each request sent, each count query), debug (start, summary, each request, retry and planned group) and info (start and end of delete planning only).
- [CORE-9209](https://widesky.atlassian.net/browse/CORE-9209): `batch.hisDelete` options `maxBisectDepth`, `countBucketUnits`, `retries` and `retryDelay`, and `client.features.hisDeletePlanner` for feature detection.
- [CORE-9209](https://widesky.atlassian.net/browse/CORE-9209): `retries` and `retryDelay` options for every batch operation, retrying requests that fail with a 500/502/503/504 or network error.

### Changed
- [CORE-9592](https://widesky.atlassian.net/browse/CORE-9592): Client-wide `progress` counters now count requests, advance as each request completes and are removed when the operation ends.
  - With cli-progress, a finished bar is cleared from the terminal.
  - A fractional `batchSize` or `batchSizeEntity` is rounded down to a whole number of items or entities per request.
- [CORE-9209](https://widesky.atlassian.net/browse/CORE-9209): `batch.hisDelete` sizes deletes from server-side record counts instead of reading every row first, and accepts a Haystack range string as well as two Dates.
  - A request now holds at most 500 rows in total across at most 10 points (was 1500 rows per point / 100 points).
  - Requests rejected for the per-point record limit are halved and retried, up to `maxBisectDepth` times.
  - A range split into several requests keeps one form the server accepts; a date range is split in each point's timezone.
  - `today`, `yesterday` and a single date are split like a date range, in each point's timezone.
  - Ranges it cannot split within the row limit (mixed forms, no seconds, points without a timezone) are reported and not deleted.
  - `batch.hisDeleteByFilter` uses the same planner, new defaults (500 / 10) and the new options.
- [CORE-9656](https://widesky.atlassian.net/browse/CORE-9656): Proxy behaviour changes with the axios 1.20 upgrade; check deployments that set a proxy.
  - HTTPS requests through a proxy (`HTTPS_PROXY` or the `proxy` option) now go over a CONNECT tunnel.
  - `NO_PROXY` entries match exact host names only; use a leading `.` or `*` to cover subdomains.

### Fixed
- [CORE-9209](https://widesky.atlassian.net/browse/CORE-9209): `batch.hisRead` and `hisRead` return each point's history on that point when a request fails, the points span several requests, or a request holds one point.
- [CORE-9656](https://widesky.atlassian.net/browse/CORE-9656): axios upgraded to 1.20.0, clearing its 32 known security advisories (12 high), including credential-leak issues.

## [3.5.0] - 2026-08-13

### Added
- [CORE-9226](https://widesky.atlassian.net/browse/CORE-9226): `PublisherSession#pointUpdate`
  can now confirm persistence. Passing `opts.ack` returns a promise that settles once the
  server has finished storing the frame, as `{status: 'ack', applied}`,
  `{status: 'nack', applied, failed}`, or `{status: 'unacked'}` when no answer arrives
  within `opts.ackTimeoutMs` (default 30000). It never rejects, a late acknowledgement
  cannot re-settle it, and an unreadable ack payload resolves as a `nack` rather than a
  success. A caller publishing history (`{his: true}`) should ask for the acknowledgement;
  a `cur` frame is superseded by the next tick and does not need one. Additive by
  construction: without `opts.ack` the socket is emitted with exactly two arguments, the
  return stays `undefined`, and the pre-connect precondition still throws synchronously.

### Changed
- [CORE-9300](https://widesky.atlassian.net/browse/CORE-9300): `hisRead` now uses an HTTP POST instead of a GET.
- [CORE-9226](https://widesky.atlassian.net/browse/CORE-9226): `unacked` is now documented
  as UNCONFIRMED rather than as a way to recognise a server predating the acknowledgement.
  An unanswered frame may or may not have been stored, and the timeout is not licence to
  discard a buffered frame. No behaviour change: `ACK_TIMEOUT_MS` keeps its value and
  `unacked` keeps its shape. `docs/client/api.md` corrected, which had documented
  `pointUpdate`'s options as `{ts?, his?}` and its return as `void` — both false since the
  acknowledgement landed.

### Fixed
- [CORE-9300](https://widesky.atlassian.net/browse/CORE-9300): Large multi-point reads no longer fail with an HTTP 414 "URI Too Long" error.
- [CORE-9226](https://widesky.atlassian.net/browse/CORE-9226): Token refresh no longer
  trusts the local clock. The server's `expires_in` is an absolute epoch-millisecond
  instant, and it was compared against `Date.now()`; on a device whose clock boots behind —
  an Edge unit with no battery-backed RTC is routinely months out — that expiry is never
  reached, so the client never refreshed proactively and kept presenting a token the server
  had already retired. REST absorbed this by retrying the 401, but the socket path
  classified the rejected handshake as a credential fault and parked. The deadline is now
  derived from the token's own lifetime (absolute expiry minus the `Date` header of the
  response that carried it), anchored to the local clock at receipt, making it immune to a
  constant local offset. Falls back to the previous comparison whenever that subtraction is
  unavailable or nonsensical: no `Date` header, an unparseable one, or an expiry at or
  before the server's own clock.
- [CORE-9226](https://widesky.atlassian.net/browse/CORE-9226): The publisher and control
  socket handshakes read `.access_token` off a pending promise. A `connect()` racing a token
  acquisition sent `Authorization: undefined` and parked as a credential fault. Both entry
  points now await the credential before touching the socket, and reject with the
  acquisition error before any handshake is attempted.
- [CORE-9226](https://widesky.atlassian.net/browse/CORE-9226): The captured server-time
  sample is now one-shot — reset on every token response and consumed once — so a refresh
  carrying no `Date` header degrades to the raw fallback instead of pairing the new expiry
  with the login-era clock. The interceptor also reads the header case-insensitively, which
  a wire-case `Date` previously defeated, leaving the fix silently inert.

## [3.4.1] - 2026-07-20

### Fixed
- [CORE-8790](https://widesky.atlassian.net/browse/CORE-8790): Realtime
  publisher/control recovery hardening. Paced socket.io reconnection and raised
  the recovery backoff ceiling, park 401/403 auth denials instead of flapping the
  transport, rebind the shared `ControlSession` across publisher socket-loss
  recovery, forward `perMessageDeflate` to the socket transport, and re-check the
  live watch after a shared-control resub. Prevents hot reconnect loops, wedged
  recovery, and needless cellular-data burn on the edge publisher.
- [CORE-9107](https://widesky.atlassian.net/browse/CORE-9107): Invalid
  `options.client` values now throw a catchable `ValidationError` from
  `new WideSkyClient(...)` instead of crashing the process with an
  unhandled promise rejection and leaving the client half-initialised.

### CHANGED
- [CORE-9107](https://widesky.atlassian.net/browse/CORE-9107): Stricter
  `options.client` validation at construction; all failures throw catchably
  from `new WideSkyClient(...)`.
  - Unknown/typo'd option keys are now rejected instead of silently ignored
    (per-call `client.batch.*` options are unaffected).
  - `batch.hisRead.batchSize` is now capped at 1000, matching
    `batch.hisReadByFilter`.

## [3.4.0] - 2026-07-13

### Breaking
- [CORE-8484](https://widesky.atlassian.net/browse/CORE-8484): `WideSkyClient#impersonateAs(userId)`
  and `options.client.impersonateAs` now require a valid RFC 4122 UUID for non-email
  values. Empty strings, non-strings, email-like strings, and free-form names that
  previously passed through to the `X-IMPERSONATE` header now throw `TypeError`. The
  email-acceptance path (any string containing `@` in `options.client.impersonateAs`,
  and `impersonateAsEmail(email)` at runtime) is unchanged. Existing callers passing a
  legacy free-form name will need to migrate to a real user UUID or to the new
  `impersonateAsEmail(email)` method.

### ADDED
- [CORE-8891](https://widesky.atlassian.net/browse/CORE-8891): Added a
  Bitbucket Pipelines CI config (`bitbucket-pipelines.yml`) running the mocha
  suite + coverage on develop, pull-request, and manual triggers, migrating
  CI from Bamboo. Node bumped to 20.19.2 (`.nvmrc`).
- [CORE-8664](https://widesky.atlassian.net/browse/CORE-8664): Realtime
  publisher API. `createPublisher()` returns a `PublisherSession` that
  registers a cur-ingress watch (`watchPub`/`watchUnpub`), opens a socket and
  streams `pointUpdate` frames, surfacing server `pointCadence` hints and typed
  `pointUpdateError`s; a `pointUpdate` can opt into history persistence with
  `{ his: true }`. Adds `createControlListener()` (a `ControlSession` that
  receives `pointWrite` commands and replies `reportWrite`, over its own socket
  or shared on an owning publisher's) and `createWatchRenewer()` (a consumer
  watch lease auto-renewer). Sessions self-heal a socket loss by re-registering
  with a fresh watch.
- [CORE-8377](https://widesky.atlassian.net/browse/CORE-8377): Opt-in
  outbound request queue. Configure via `options.client.queue`
  (`maxConcurrent`, `minDelayMs`, `maxQueueDepth`, `highWaterPct`,
  `highWaterLogEveryN`); default off. One queue per `WideSkyClient`
  instance, composes with `client.batch.*`. Throws `QueueFullError`
  (exported via `clientErrors`) when `maxQueueDepth` is exceeded.
  `/oauth2/token` bypasses the queue so auth refreshes aren't subject
  to data-plane backpressure.
- [CORE-8484](https://widesky.atlassian.net/browse/CORE-8484): Added `impersonateAsEmail(email)`
  method on `WideSkyClient`, and accepted an email value for the `client.impersonateAs`
  option (resolved lazily on the first authenticated request). The email lookup uses
  `limit: 2` and rejects duplicate matches, malformed `userRef` values (non-UUID),
  and empty/whitespace inputs. The lookup always runs unimpersonated even when an
  earlier impersonation is already in effect. Filter interpolation now two-pass-escapes
  backslashes then double quotes. Concurrent calls (parallel lazy resolutions and
  explicit back-to-back invocations) are serialised through a single in-flight promise
  so order of resolution matches order of invocation and no request is ever sent without
  the resolved `X-IMPERSONATE` header. `impersonateAs(userId)` now rejects email-like
  and empty/non-string values with a `TypeError`, accepts `null` or `undefined` to
  clear (equivalent to `unsetImpersonate()`), and validates `options.client.impersonateAs`
  at construction. Impersonation state changes are logged at `info`; the email-to-user-id
  mapping is logged only at `debug` (PII). Error messages from the email lookup carry a
  redacted email (e.g. `a***@example.com`) in `err.message`, with the raw email on
  `err.email` for callers that need it. Synchronous `impersonateAs(userId)` now rejects
  malformed UUIDs with `TypeError`. The lookup itself goes through `submitRequest` with
  an internal Symbol-keyed flag (re-stamped on the cloned config so the 401-retry
  path inside the same `submitRequest` lifecycle still bypasses the join) so the
  recursive call to `_attachReqConfig` cannot deadlock on the in-flight
  `_impersonateLookup` promise. An internal `_impersonateGen`
  counter ensures synchronous caller mutations (`unsetImpersonate()`, `impersonateAs('other')`)
  during an in-flight lookup are not silently overwritten when the lookup completes.
- [CORE-1992](https://widesky.atlassian.net/browse/CORE-1992): `batch.hisWrite` now accepts a
  `batchSizeEntity` option capping the number of distinct entities per underlying request
  (default 100, max 1000). Mirrors the existing `batch.hisDelete` `batchSizeEntity` option.

### CHANGED
- [CORE-1992](https://widesky.atlassian.net/browse/CORE-1992): `batch.hisWrite` now defaults to a
  maximum of 100 entities per request. Callers that previously relied on sending more than 100
  entities in a single underlying request must set `batchSizeEntity` explicitly (up to 1000).

## [3.3.1] - 2026-04-17

### FIXED
- [CORE-8121](https://widesky.atlassian.net/browse/CORE-8121): Added request timeout to
  `_wsRawSubmit` when HTTP/2 is enabled. Prevents requests from hanging indefinitely when the
  server accepts TLS but never sends the HTTP/2 SETTINGS frame. Configurable via
  `options.http2.requestTimeout` (default 60 seconds).

## [3.3.0] - 2026-02-19

### FIXED
- [CORE-6773](https://widesky.atlassian.net/browse/CORE-6773): Fixed a bug where axios errors
  without `response.data` properties would cause the error parsing to fail and return an internal
  error. Now returns underlying axios error.

### ADDED
- [CORE-4878](https://widesky.atlassian.net/browse/CORE-4878): Added the fileDelete function
  to handle file [DELETE] requests. This function accepts pointId, a start date in ISO8601 format and
  end date in ISO8601 format, and sends a [DELETE] request to the api/file/storage endpoint.
- [CORE-5160](https://widesky.atlassian.net/browse/CORE-5160): Updated wsRawSubmit DELETE method
  to accept only the config.
- [CORE-6791](https://widesky.atlassian.net/browse/CORE-6791): Added optional `metadata` support to
  the `query` method, allowing callers to include object or JSON-stringified key/value pairs which
  are now appended to the outgoing GraphQL request body.

## [3.2.1] - 2025-06-02

### FIXED
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): `window undefined error` when used in a non-browser
  environment.

### CHANGED
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Defined property `unpkg` and `browser` in
  the `package.json` permit browser environments to use `unpkg` or similar to directly import the package
  rather than a file in the package.
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Created specific build files for browser and
  non-browser environments. These are minified files `index.browser.js` and `index.js`.

## [3.2.0] - 2025-05-29

### REMOVED
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Unused dependencies. **Bold** entries
  are NodeJS built-in modules that were improperly imported as part of unsafe browser usage:
  - @babel/core
  - @babel/preset-env
  - babel-loader
  - npm-run-all
  - webpack-dev-server
  - **readline**
  - **http2**

- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): `dist` directory from repo.
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Webpack dev server. This webpack
  config was never configured to work, so nothing is lost here.
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): NPM package no longer exports
  `jsWideSky.min.js` and `jsWideSky.develop.js`.

### FIXED
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Added a check for the process
  environment so that the client can be used in the browser. `http` and `https` agent options now
  only apply in a Node.js runtime (they will not work outside of it).
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Audited packages and updated to
  remove potential vulnerabilities.

### ADDED
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Added a new
  [option](./docs/client/options.md) group `http2` to allow enabling of http2 as a transport method.
  Can be enabled by setting `http2.enabled` to `true`.
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Support for typing in the published
  package via the generated `index.d.ts` file.
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Updated build to support ES6 import
  style.

### CHANGED
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Added an `engines` field to the
  package manifest specifying support for Node.js `>=16`. Previously, no engine requirement was
  declared, but the package implicitly required Node.js `>=15` due to usage of
  `String.prototype.replaceAll()`. Since development and testing have consistently used Node.js 16
  or higher, the `engines` field now explicitly reflects this.
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): No longer installs and tests when
  building (`npm run build`).
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Building with webpack
  `--mode production` now builds with `production` mode enabled. Allowing for smaller builds and
  minor performance increases.
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): `dist` directory is now populated
  with:
  - `index.js`
  - `index.js.LICENSE.txt` (module licenses)
  - `LICENSE` (WideSky license)
  - `README.md` (same from project root)
  - `docs/`
  - `CHANGELOG.md`
  - `package.json`

  The resulting package size is `243.1 kB`, down from `2.6 MB`.

- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): NPM package now exports a single
  `index.js` source file that is the production version of the code, to access a development package
  `npm link` should be used from source.
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Now uses the correct set of webpack
  `externals` and `fallbacks` to improve build reliability and reduce masking of incorrect browser
  support.
- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): When running in a browser environment
  the following built-in modules are no longer `require`'ed. These modules are also **not**
  polyfilled via a `fallback` (unchanged):
  - `http`
  - `https`

  Additionally, the following external modules are no longer `require`'ed, as they do not support a
  browser runtime. These modules are marked as `externals` in the build:
  - `dtrace-provider`
  - `fs`
  - `mv`
  - `os`
  - `source-map-support`

- [CORE-4871](https://widesky.atlassian.net/browse/CORE-4871): Client configuration validation from
  asynchronous to synchronous.

## [3.1.3] - 2025-04-09

### CHANGED
- Added support for `DELETE` method call for `WideSkyClient.submitRequest()`.

## [3.1.2] - 2025-03-12
### ADDED
- [CORE-1925](https://widesky.atlassian.net/browse/CORE-1925): Throw errors
  `HaystackError` and `GraphQLError` now include the original request error
  thrown by the client package in the `requestError` property, and the HTTP
  status in `status` for convenience.
- [CORE-1925](https://widesky.atlassian.net/browse/CORE-1925): Exported request
  errors:
  - `RequestError`: A base class for all request errors created.
  - `HaystackError`: A error for a Haystack type response error.
  - `GraphQLError`: A error for a GraphQL type response error.
- [CORE-4036](https://widesky.atlassian.net/browse/CORE-4036): Added modules:
  - `http2-wrapper`
  - `axios-http2-adapter`
- [CORE-4036](https://widesky.atlassian.net/browse/CORE-4036): `axios` module
  now uses a `http2` adapter which allows it to make calls using the HTTP/2.0
  protocol.


### FIXED
- [CORE-1907](https://widesky.atlassian.net/browse/CORE-1907): `HisWritePayload` class not accepting boolean values.

## [3.1.1] - 2024-06-03
### CHANGED
- The `http` option `keepAlive` will now default to `true` if it is not specified.

#### FIXED
- `WideSkyClient.batch.updateOrCreate` errored with list type tags.

## [3.1.0] - 2024-05-23
### ADDED
- Added new [options](./docs/client/options.md) under `http` which allows an optional configuration
  to be passed to the HTTP and HTTPS `Agent` used in `axios` requests. See
  [NodeJS 16.x - HTTP Agent options](https://nodejs.org/docs/latest-v16.x/api/http.html#new-agentoptions).

## [3.0.1] - 2024-03-21
No changes have been made. The package was released with a new tag `3.0.1` as NPM does not allow package version to be
duplicated, even in the case where a package's version was unpublished. This is documented in
[npm Unpublish Policy - Considerations](https://docs.npmjs.com/policies/unpublish#considerations).

## [3.0.0] - 2024-03-21
### FIXED
- Fixed minified file error "Invalid or expected token".

### CHANGED
- BREAKING CHANGE: Changed minified file name from "wideskyClient.min.js" to "jsWideSky.min.js".
- BREAKING CHANGE: Changed default export name of minified file from `wideskyClient` (assuming this was set as a default
  when not specified in the webpack configuration) to `JsWideSky`.

## [2.1.5] - 2024-03-13
### CHANGED
- `getWatchSocket` function now accounts for subpath in URL when retrieving a socket connection.

## [2.1.4] - 2024-01-31
### CHANGED
- Changed the error message produced when more than 1 GraphQL error is encountered. Previously, all that was logged
  was "More than 1 error encountered" which is too vague. This has been changed to "More than 1 GraphQLError
  encountered" with additional logs detailing each GraphQL error encountered as "<message> @ locations/s <locations>...".

## [2.1.3] - 2024-01-31
### FIXED
- Added utility class `EntityCriteria` to package exports.

## [2.1.2] - 2024-01-19
### FIXED
- Fixed bug `TypeError: Cannot read properties of undefined (reading '0')` when using `WideSkyClient.batch.hisWrite`.

### CHANGED
- Added empty payload check.

### ADDED
- Size property to `HisWritePayload` to get the number of rows currently added to the payload.

## [2.1.1] - 2023-12-08
### FIXED
- Fixed `getWatchSocket` function returning an invalid socket due to a missing namespace URL.

## [2.1.0] - 2023-11-24
### ADDED
- Added Haystack utility functions for ease of use. These include:
  - `removePrefix(value)`: Remove the Haystack prefix from the given String value if applied.
  - `getId(entity, tag)`: Get a UUID from the entity, or the Haystack reference tag is specified.
  - `getReadableName(entity)`: Get the `fqname` or `id` tag of the entity.
- Added new argument `options` to `WideSkyClient` constructor to accept configurations for the underlying `axios` client
  instance and WideSky client batch operations. The options argument is expected to have the following structure as
  defined in [Client Options](./docs/client/options.md).
- Added a new static function `make` to create a `WideSkyClient` instance from a configuration Object. The Object can
  have the following options:
  - `serverURL`: The URL to the WideSky API server (required).
  - `username`: The username for a WideSky user (required).
  - `password`: The password the above WideSky username (required).
  - `clientId`: The Client ID for OAuth 2.0 authentication (required).
  - `clientSecret`: The Client secret for OAuth 2.0 authentication (required).
  - `accessToken`: A valid WideSky access token for OAuth 2.0 authentication (optional).
  - `options`: An Object containing attributes axios and client for configuring the axios and WideSky client
    respectively. The options argument is expected to have the following structure as defined in
    [Client Options](./docs/client/options.md).
  - `logger`: This can be one of:
    - Empty, meaning a default Bunyan logger is used.
    - Object, for which a Bunyan instance will be created with:
      - name: Name of logging instance.
      - level: Bunyan logging level to shows logs higher than
      - raw: If true, output in JSON format. If false, output in prettified Bunyan logging format.
    - Bunyan logging instance
- Added new set of functions under property `v2` of the `WideSkyClient` instance. `v2` consists of client functions:
  - `find`: Same functionality as the existing `WideSkyClient.find` but returns only the rows.
- Added new function `performOpInBatch` to perform client operations in a batched and parallel manner. Will be used
  as the basis for all new batch functions added.
- Add new batch functions:
  - `client.batch.hisWrite(payload, options)`
  - `client.batch.hisRead(ids, from, to, options)`
  - `client.batch.hisDelete(ids, start, end, options)`
  - `client.batch.create(entities, options)`
  - `client.batch.update(entities, options)`
  - `client.batch.deleteById(ids, options)`
  - `client.batch.deleteByFilter(filter, limit, options)`
  - `client.batch.hisReadByFilter(filter, from, to, options)`
  - `client.batch.updateByFilter(filter, criteriaList, options)`
  - `client.batch.hisDeleteByFilter(filter, start, end, options)`
  - `client.batch.migrateHistory(fromEntity, toEntity)`
  - `client.batch.addChildrenByFilter(filter, children, tagMap)`
  - `client.batch.multiFind(filterAndLimits, options)`
  - `client.batch.updateOrCreate(entities, options)`
- Added new utility class `EntityCriteria`  to be used with `client.batch.updateByFilter`.
- Added new utility class `HisWritePayload` to more easily create payloads suitable for the `hisWrite` function.
- Added new function `entityCount(filter)` to get the number of entities from a filter via a GraphQL query.
- Added new function `findAsId(filter, limit)` to optimise functions that only require the ids of the entity,
  normally discarding any other information that would be returned from `client.find`.

### CHANGED
- Client no longer throws a Axios error if a response has been received and response is a Haystack of GraphQL error.
  Instead, the error found in the response as received from a WideSky API server is used as the error message.
  This has been changed as the WideSky API server already created good responses to request errors and changes should
  only be in API server.

## [2.0.6] - 2023-10-03
### FIXED
- Fixed `hisDelete` date validation on timezone offsets.

## [2.0.5] - 2023-07-07
### FIXED
- Fixed file upload not working when given as a `Buffer`.

## [2.0.4] - 2023-05-29
### ADDED
- Added support for WideSky `hisDelete` endpoint, `/api/hisDelete`. This function is for deleting
  historical timeseries data within a given range for the given points.
- On 401 unauthorised errors and having an existing token, the client will attempt to re-login to force refresh
  the tokens and retry the request.

## [2.0.3] - 2023-04-05
### ADDED
- Added support for the WideSky `createUser` endpoint, `/api/admin/user`. As its name implies, this function is use for
  creating a new user account in WideSky through one of the supported local/scram authentication method.
- Added support for the WideSky `watchSub` endpoint, `/api/watchSub`. This allows a user to subscribe to a watch.
- Added a function to extend the lease of a watch.
- Added support for the WideSky `watchUnsub` endpoint, `/api/watchUnsub`. This allows a user to unsubscribe to a watch.
- Added a function to retrieve an API socket using a watch.

## [2.0.2] - 2022-11-07
### FIXED
- Added conditional import for importing `axios` when run by either a browser or node process.

## [2.0.1] - 2022-11-07
### CHANGED
- Updated build packages

## [2.0.0] - 2022-11-03
### FIXED
- Replaced `x instanceof Array` with `Array.isArray(x)` to resolve.
  peculiar issues with passing arrays in NodeRED function nodes.
- Formatting using `moment` includes the milliseconds of the DateTime object.
- Invalid inputs for `WideSkyClient.find` and `WideSkyClient.deleteByFilter` are caught before
  making a request to the given `uri` for the client.
- An empty of array of entity id's given to functions `WideSkyClient.deleteById` and
  `WideSkyClient.read` will now throw an error.

### CHANGED
- Replaced deprecated packages `request` and `request-promise` for `axios`.
- Updated packages:
  - `moment-timezone` v0.5.31 -> v0.5.38.
  - `jsesc` v2.5.1 -> v3.0.2.
- Converted WideSkyClient to an ES6 class.

### REMOVED
- Package `bluebird`

## [1.2.2] - 2022-08-11
### CHANGED
- Updated the versions of dependencies used to fix security issues found in
  underlying libraries.

## [1.2.1] - 2022-07-19
### FIXED
- FileUpload API - supplying null to the `tag` argument no longer cause error.

## [1.2.0] - 2022-07-18
### ADDED
- Updated docs to include examples on how to include the library using es6 `import` statement.
- Added file storage APIs for storing a file and retrieval of it.

### CHANGED
- Updated the build system to use webpack instead of grunt-browserify.

## [1.1.2] - 2020-11-23
### FIXED
- Fixed a bug whereby the client will does not decompress the response payload for its user.

## [1.1.1] - 2020-11-23
### CHANGED
- The http header `Accept-Content` is now included as part of the http requests
  made by the client. Benefit of it is that the payload of a http response (generally
  received from the Widesky api server will be significantly smaller.

  This default behaviour may be switched off via the api `setAcceptGzip(false)`.

## [1.1.0] - 2020-11-23
### ADDED
- The main documentation has been refactored to explain how the client can be used.
- Added the minified version of the client library for web applications.
- Added graphql utilities.
- Added CHANGELOG.md to track release changes.

## [1.0.0] - 2020-09-09
### ADDED
- Initial production ready release

## [0.1.1] - 2020-09-08
### ADDED
- Alpha release

[Unreleased]: https://github.com/widesky/jswidesky-client/compare/master...3.4.1
[3.4.1]: https://github.com/widesky/jswidesky-client/compare/3.4.1...3.4.0
[3.4.0]: https://github.com/widesky/jswidesky-client/compare/3.4.0...3.3.1
[3.3.1]: https://github.com/widesky/jswidesky-client/compare/3.3.1...3.3.0
[3.3.0]: https://github.com/widesky/jswidesky-client/compare/3.3.0...3.2.1
[1.0.0]: https://github.com/widesky/jswidesky-client/compare/1.0.0...1.0.0
[1.1.0]: https://github.com/widesky/jswidesky-client/compare/1.1.0...1.0.0
[1.1.1]: https://github.com/widesky/jswidesky-client/compare/1.1.1...1.1.0
[1.1.2]: https://github.com/widesky/jswidesky-client/compare/1.1.2...1.1.1
[1.2.0]: https://github.com/widesky/jswidesky-client/compare/1.2.0...1.1.2
[1.2.1]: https://github.com/widesky/jswidesky-client/compare/1.2.1...1.2.0
[1.2.2]: https://github.com/widesky/jswidesky-client/compare/1.2.2...1.2.1
[2.0.0]: https://github.com/widesky/jswidesky-client/compare/2.0.0...1.2.2
[2.0.1]: https://github.com/widesky/jswidesky-client/compare/2.0.1...2.0.0
[2.0.2]: https://github.com/widesky/jswidesky-client/compare/2.0.2...2.0.1
[2.0.3]: https://github.com/widesky/jswidesky-client/compare/2.0.3...2.0.2
[2.0.4]: https://github.com/widesky/jswidesky-client/compare/2.0.4...2.0.3
[2.0.5]: https://github.com/widesky/jswidesky-client/compare/2.0.5...2.0.4
[2.0.6]: https://github.com/widesky/jswidesky-client/compare/2.0.6...2.0.5
[2.1.0]: https://github.com/widesky/jswidesky-client/compare/2.1.0...2.0.6
[2.1.1]: https://github.com/widesky/jswidesky-client/compare/2.1.1...2.1.0
[2.1.2]: https://github.com/widesky/jswidesky-client/compare/2.1.2...2.1.1
[2.1.3]: https://github.com/widesky/jswidesky-client/compare/2.1.3...2.1.2
[2.1.4]: https://github.com/widesky/jswidesky-client/compare/2.1.4...2.1.3
[2.1.5]: https://github.com/widesky/jswidesky-client/compare/2.1.5...2.1.4
[3.0.0]: https://github.com/widesky/jswidesky-client/compare/3.0.0...2.1.5
[3.0.1]: https://github.com/widesky/jswidesky-client/compare/3.0.1...3.0.0
[3.1.0]: https://github.com/widesky/jswidesky-client/compare/3.1.0...3.0.1
[3.1.1]: https://github.com/widesky/jswidesky-client/compare/3.1.1...3.1.0
[3.1.2]: https://github.com/widesky/jswidesky-client/compare/3.1.2...3.1.1
[3.1.3]: https://github.com/widesky/jswidesky-client/compare/3.1.3...3.1.2
[3.2.0]: https://github.com/widesky/jswidesky-client/compare/3.2.0...3.1.3
[3.2.1]: https://github.com/widesky/jswidesky-client/compare/3.2.1...3.2.0
