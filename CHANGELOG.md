# Change Log
All notable changes to this project will be documented in this file.
This project adheres to [Semantic Versioning](http://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/widesky/jswidesky-client/compare/master...3.1.0
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
