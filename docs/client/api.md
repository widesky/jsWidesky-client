# WideSkyClient
<!-- toc -->

- [WideSkyClient.Constructor(baseUri, username, password, clientId, clientSecret, logger, accessToken, options)](#wideskyclientconstructorbaseuri-username-password-clientid-clientsecret-logger-accesstoken-options)
    - [Parameter `logger` Explained](#parameter-logger-explained)
- [WideSkyClient.makeFromConfig(config)](#wideskyclientmakefromconfigconfig)
    - [Parameter `config` Explained](#parameter-config-explained)
- [WideSky Functions](#widesky-functions)
    - [WideSkyClient.login()](#wideskyclientlogin)
    - [WideSkyClient.query(graphql)](#wideskyclientquerygraphql)
    - [WideSkyClient.createUser(email, name, description, roles, password, method)](#wideskyclientcreateuseremail-name-description-roles-password-method)
    - [WideSkyClient.updatePassword(newPassword)](#wideskyclientupdatepasswordnewpassword)
    - [WideSkyClient.fileUpload(ids, ts, filename, mediaType, inlineRetrieval, cacheMaxAge, force, tags)](#wideskyclientfileuploadids-ts-filename-mediatype-inlineretrieval-cachemaxage-force-tags)
    - [WideSkyClient.fileRetrieve(pointIds, from, to, presigned, presignExpiry)](#wideskyclientfileretrievepointids-from-to-presigned-presignexpiry)
    - [WideSkyClient.entityCount(filter)](#wideskycliententitycountfilter)
    - [WideSkyClient.findAsId(filter, limit)](#wideskyclientfindasidfilter-limit)
    - [WideSkyClient.impersonateAs(userId)](#wideskyclientimpersonateasuserid)
    - [WideSkyClient.impersonateAsEmail(email)](#wideskyclientimpersonateasemailemail)
    - [WideSkyClient.unsetImpersonate()](#wideskyclientunsetimpersonate)
    - [WideSkyClient.submitRequest(method, uri, body, config)](#wideskyclientsubmitrequestmethod-uri-body-config)
    - [WideSkyClient.setAcceptGzip(acceptGzip)](#wideskyclientsetacceptgzipacceptgzip)
- [Haystack Functions](#haystack-functions)
    - [WideSkyClient.read(ids)](#wideskyclientreadids)
    - [WideSkyClient.find(filter, limit)](#wideskyclientfindfilter-limit)
    - [WideSkyClient.create(entities)](#wideskyclientcreateentities)
    - [WideSkyClient.update(entities)](#wideskyclientupdateentities)
    - [WideSkyClient.deleteById(ids)](#wideskyclientdeletebyidids)
    - [WideSkyClient.deleteByFilter(filter, limit)](#wideskyclientdeletebyfilterfilter-limit)
    - [WideSkyClient.hisRead(ids, from, to, batchSize)](#wideskyclienthisreadids-from-to-batchsize)
    - [WideSkyClient.hisWrite(records)](#wideskyclienthiswriterecords)
    - [WideSkyClient.watchSub(pointsIds, lease, description, config)](#wideskyclientwatchsubpointsids-lease-description-config)
    - [WideSkyClient.watchExtend(watchId, pointIds, lease, config)](#wideskyclientwatchextendwatchid-pointids-lease-config)
    - [WideSkyClient.watchUnsub(watchId, deletePointIds, close, config)](#wideskyclientwatchunsubwatchid-deletepointids-close-config)
    - [WideSkyClient.getWatchSocket(watchId)](#wideskyclientgetwatchsocketwatchid)
    - [WideSkyClient.hisDelete(ids, range)](#wideskyclienthisdeleteids-range)
- [Realtime Publisher Functions](#realtime-publisher-functions)
    - [WideSkyClient.createPublisher()](#wideskyclientcreatepublisher)
    - [PublisherSession.watchPub(body, config)](#publishersessionwatchpubbody-config)
    - [PublisherSession.watchUnpub(watchId, config)](#publishersessionwatchunpubwatchid-config)
    - [PublisherSession.connect(watchId, opts)](#publishersessionconnectwatchid-opts)
    - [PublisherSession.pointUpdate(entries, opts)](#publishersessionpointupdateentries-opts)
    - [PublisherSession.close(opts)](#publishersessioncloseopts)
    - [PublisherSession events](#publishersession-events)
- [Realtime Control Listener Functions](#realtime-control-listener-functions)
    - [WideSkyClient.createControlListener(options)](#wideskyclientcreatecontrollisteneroptions)
    - [ControlSession.controlSub(body, config)](#controlsessioncontrolsubbody-config)
    - [ControlSession.controlUnsub(registrationId, config)](#controlsessioncontrolunsubregistrationid-config)
    - [ControlSession.connect(registrationId, opts)](#controlsessionconnectregistrationid-opts)
    - [ControlSession.reportWrite(requestId, data, opts)](#controlsessionreportwriterequestid-data-opts)
    - [ControlSession.attachTo(publisher)](#controlsessionattachtopublisher)
    - [ControlSession.close(opts)](#controlsessioncloseopts)
    - [ControlSession events](#controlsession-events)
- [Consumer Watch Lease Renewal](#consumer-watch-lease-renewal)
    - [WideSkyClient.createWatchRenewer(opts)](#wideskyclientcreatewatchreneweropts)
- [Version 2 Functions](#version-2-functions)
    - [WideSkyClient.v2.find(filter, limit)](#wideskyclientv2findfilter-limit)
- [Batch Functions](#batch-functions)
    - [WideSkyClient.performOpInBatch(op, args, options)](#wideskyclientperformopinbatchop-args-options)
    - [WideSkyClient.batch.hisWrite(hisWriteData, options)](#wideskyclientbatchhiswritehiswritedata-options)
    - [WideSkyClient.batch.hisRead(ids, from, to, options)](#wideskyclientbatchhisreadids-from-to-options)
    - [WideSkyClient.batch.hisDelete(ids, start, end, options)](#wideskyclientbatchhisdeleteids-start-end-options)
    - [WideSkyClient.batch.create(entities, options)](#wideskyclientbatchcreateentities-options)
    - [WideSkyClient.batch.update(entities, options)](#wideskyclientbatchupdateentities-options)
    - [WideSkyClient.batch.deleteById(ids, options)](#wideskyclientbatchdeletebyidids-options)
    - [WideSkyClient.batch.deleteByFilter(filter, limit, options)](#wideskyclientbatchdeletebyfilterfilter-limit-options)
    - [WideSkyClient.batch.hisReadByFilter(filter, from, to, options)](#wideskyclientbatchhisreadbyfilterfilter-from-to-options)
    - [WideSkyClient.batch.updateByFilter(filter, criteriaList, options)](#wideskyclientbatchupdatebyfilterfilter-criterialist-options)
    - [WideSkyClient.batch.hisDeleteByFilter(filter, start, end, options)](#wideskyclientbatchhisdeletebyfilterfilter-start-end-options)
    - [WideSkyClient.batch.migrateHistory(fromEntity, toEntity, options)](#wideskyclientbatchmigratehistoryfromentity-toentity-options)
    - [WideSkyClient.batch.addChildrenByFilter(filter, children, tagMap, options)](#wideskyclientbatchaddchildrenbyfilterfilter-children-tagmap-options)
    - [WideSkyClient.batch.multiFind(filterAndLimits, options)](#wideskyclientbatchmultifindfilterandlimits-options)
    - [WideSkyClient.batch.updateOrCreate(entities, options)](#wideskyclientbatchupdateorcreateentities-options)

<!-- tocstop -->

# Constructor
A developer can create a `WideSkyClient` instance by either using the class constructor or 
`WideSkyClient.makeFromConfig(config)`. Both of these will be described below.

## WideSkyClient.Constructor(baseUri, username, password, clientId, clientSecret, logger, accessToken, options)
**Description:** Creates a `WideSkyClient` instance.  
**Parameters:**

| Param          | Description                                                                                                                                                                                                                                                                              |         Type          | Default |
|----------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:---------------------:|:-------:|
| `baseUri`      | URI to access the WideSky API (excluding /api)                                                                                                                                                                                                                                           |        String         |         |
| `username`     | Username of the WideSky user to authenticate with.                                                                                                                                                                                                                                       |        String         |         |
| `password`     | Password of the WideSky user to authenticate with.                                                                                                                                                                                                                                       |        String         |         |
| `clientId`     | Client ID for OAuth 2.0 authentication.                                                                                                                                                                                                                                                  |        String         |         |
| `clientSecret` | Client secret for OAuth 2.0 authentication.                                                                                                                                                                                                                                              |        String         |         |
| `logger`       | A Bunyan logging instance, Bunyan logging configurations or nothing. For more information, see [Parameter logger Explained](#parameter-logger-explained).                                                                                                                                | Object or `undefined` |         |
| `accessToken`  | A valid WideSky access token.                                                                                                                                                                                                                                                            |        String         |         |
| `options`      | An Object containing attributes "axios" and "client" for configuring the axios and WideSky client respectively. Axios configurations are described at https://axios-http.com/docs/config_defaults. See [client options](options.md#client-options) for information of options available. |        Object         |  `{}`   |

### Parameter `logger` Explained
An Object that can be:
- `Undefined`, meaning a default Bunyan logger is used
- `Object` for which a Bunyan instance will be created with:
  - `name`: Name of logging instance
  - `level`: Bunyan logging level to show logs higher.
  - `raw`: If true, output in JSON format. If false, output in prettified Bunyan logging format.
- A Bunyan logging instance.

## WideSkyClient.makeFromConfig(config)
**Description:** Creates a `WideSkyClient` instance.  
**Parameters**

| Param    | Description                                                | Type   |
|----------|------------------------------------------------------------|--------|
| `config` | A configuration file to create a `WideSkyClient` instance. | Object |

### Parameter `config` Explained
`config` is an Object that can have the following structure:

| Property       | Description                                                                                                                                                                                                                                                                              |         Type          | Required |
|----------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:---------------------:|:--------:|
| `serverURL`    | URI to access the WideSky API (excluding /api).                                                                                                                                                                                                                                          |        String         |    ✓     |
| `username`     | Username of the WideSky user to authenticate with.                                                                                                                                                                                                                                       |        String         |    ✓     |
| `password`     | Password of the WideSky user to authenticate with.                                                                                                                                                                                                                                       |        String         |    ✓     |
| `clientId`     | Client ID for OAuth 2.0 authentication.                                                                                                                                                                                                                                                  |        String         |    ✓     |
| `clientSecret` | Client secret for OAuth 2.0 authentication.                                                                                                                                                                                                                                              |        String         |    ✓     |
| `accessToken`  | A valid WideSky access token.                                                                                                                                                                                                                                                            |        String         |    ✕     |
| `options`      | An Object containing attributes "axios" and "client" for configuring the axios and WideSky client respectively. Axios configurations are described at https://axios-http.com/docs/config_defaults. See [client options](options.md#client-options) for information of options available. |        Object         |    ✕     |
| `logger`       | A Bunyan logging instance, Bunyan logging configurations or nothing. For more information, see [Parameter logger Explained](#parameter-logger-explained).                                                                                                                                | Object or `undefined` |    ✕     |

# Performing an operation
Once an instance of the `WideskyClient` has been instantiated, the client will automatically perform authentication
and maintain the WideSky access token for you. This allows the client to be used as the instance has been
instantiated. The available operations are divided into 3 sets:
- WideSky functions
- Haystack functions
- Class specific functions
- Version 2 functions, an iteration of the Haystack functions
- Batch function that implement the above function by batching the given payload

The operations are described below:

## WideSky Functions
A list of functions available on the `WideSkyClient` class that perform WideSky specific operations.

### WideSkyClient.login()
**Description:** Perform a login using the configured WideSky credentials for the client instance if not already logged
in.  
**Parameters:** None  
**Returns:** `Promise<{access_token: String, refreshToken: String, expires_in: Number, token_type: String}>` - A token
object.


### WideSkyClient.query(graphql)
**Description:** Perform a GraphQL request to the WideSky API server.  
**Parameters:**

| Param     | Description        | Type   |
|-----------|--------------------|--------|
| `graphql` | The GraphQL query. | String |

**Returns:** `Promise<RawGrid>`- GraphQL response.

### WideSkyClient.createUser(email, name, description, roles, password, method)
**Description:** Create a new WideSky user.  
**Parameters:**

| Param         | Description                                                                                                                                                                 |   Type   | Default |
|---------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:--------:|:-------:|
| `email`       | Email or username of the new user.                                                                                                                                          |  String  |         |
| `name`        | Name or description of the new user account. This will be assigned to the `dis` field of the User entity.                                                                   |  String  |         |
| `description` | Purpose of the user account. E.g. "User", "SuperUser", etc.                                                                                                                 |  String  |         |
| `roles`       | The IDs (UUIDs or names) of the Role entities to link to this new user.                                                                                                     | String[] |         |
| `password`    | The new password for the user. If set to `null` or the empty String, the user will be sent an email to activate their user account.                                         | String?  | `null`  |
| `method`      | The authentication method for the new user. At the time of writing, the choices are: "local" (the default, using OAuth2 authentication) and "scram" (SCRAM authentication). | String?  | "local" |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.updatePassword(newPassword)
**Description:** Change the current session user's password.  
**Parameters:**

| Param         | Description                     | Type   |
|---------------|---------------------------------|--------|
| `newPassword` | The new password to be applied. | String |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.fileUpload(ids, ts, filename, mediaType, inlineRetrieval, cacheMaxAge, force, tags)
**Description:** Upload a file to the WideSky server.  
**Parameters:**

| Param             | Description                                                                                                                                                                                          |       Type       | Default |
|-------------------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:----------------:|:-------:|
| `id`              | Identifier of the object point.                                                                                                                                                                      |      String      |         |
| `ts`              | Timestamp which the upload will perform against the object point.                                                                                                                                    |      String      |         |
| `file`            | The upload target, this can either be an absolute file path or a buffer.                                                                                                                             | String or Buffer |         |
| `filename`        | Name of the upload.                                                                                                                                                                                  |      String      |         |
| `mediaType`       | Media type of the upload. (e.g. pdf = application/pdf)                                                                                                                                               |      String      |         |
| `inlineRetrieval` | When `true`, client that supports the HTTP header contentDisposition will render the uploaded file on the screen instead of presenting the 'Save as' dialog. If nothing is set then true is assumed. |     Boolean      | `true`  |
| `cacheMaxAge`     | The number of seconds a client, that supports the HTTP header CacheMaxAge, should store the retrieved file (stored in this op) in cache before re-downloading it again.                              |      Number      | `1800`  |
| `force`           | When `true`, the server will forcefully overwrite a previously stored file that shares the same given ts. Default is false.                                                                          |     Boolean      | `false` |
| `tags`            | An object consisting of additional file tags that will go with the upload. Key of the object is the tagName while value is its tagValue. E.g. `{ 'UploadedBy': 'AuthorABC'}`                         |       Tags       |  `{}`   |

**Returns:** `Promise<{success: Boolean}>` - A response indicating if the upload was successful or not.

### WideSkyClient.fileRetrieve(pointIds, from, to, presigned, presignExpiry)
**Description:** Retrieve a previously stored file the configured WideSky server. This API will return an object keyed
by the requested point ids, where the value is an array of file URLs which can be used to retrieve the file data via
the HTTP GET method.

Date inputs for this function is the standard ISO8601 dates. For example:
- 2022-03-30T11:30:00Z
- 2022-07-26T11:00:00+02:00

**Parameters:**

| Param           | Description                                                 |      Type       | Default |
|-----------------|-------------------------------------------------------------|:---------------:|:-------:|
| `pointIds`      | A single or multiple point identifiers, who have kind=File. | String or Array |         |
| `from`          | Starting ISO8601 timestamp of the retrieve.                 |      Date       |         |
| `to`            | Ending ISO8601 timestamp of the retrieve.                   |      Date       |         |
| `presigned`     | Flag for indicating if the returned URL should be resigned. |     Boolean     | `true`  |
| `presignExpiry` | Duration in seconds where the presigned link will expire.   |     Number      | `1800`  |

**Returns:** `Promise<Array<{pointId: String, urls: Array<{time: Number, value: String}>>>`

### WideSkyClient.entityCount(filter)
**Description:** Get the number of entities to be returned from a filter.  
**Parameters:**

| Param    | Description                |  Type  |
|----------|----------------------------|:------:|
| `filter` | Filter to select entities. | String |

**Returns:** `Promise<Number>` - Number of entities found.

### WideSkyClient.findAsId(filter, limit)
**Description:** Perform a read by filter but only return the IDs of the entities found.  
**Parameters:**

| Param    | Description                                                             |  Type  | Default |
|----------|-------------------------------------------------------------------------|:------:|:-------:|
| `filter` | Filter to select entities.                                              | String |         |
| `limit`  | Limit to be imposed on the number of entities found using the `filter`. | Number |    0    |

**Returns:** `Promise<Array<String>>` - Array of Ids of the entities found.

### WideSkyClient.impersonateAs(userId)
**Description:** Impersonate as a WideSky user when performing requests, or
clear any existing impersonation. Pass `null` (or `undefined`) as `userId` to
clear both an active impersonation and any pending email-based impersonation
queued via the `client.impersonateAs` option — equivalent to calling
[`unsetImpersonate()`](#wideskyclientunsetimpersonate).

To impersonate via an email instead of a UUID, use
[`impersonateAsEmail()`](#wideskyclientimpersonateasemailemail). Passing an
email string here throws — emails are not auto-detected on this method to
avoid an unresolved email being sent to the server in the `X-IMPERSONATE`
header.

**Parameters:**

| Param    | Description                                                                                             |        Type        |
|----------|---------------------------------------------------------------------------------------------------------|:------------------:|
| `userId` | The UUID of the User entity to be impersonated, or `null` / `undefined` to clear any impersonation.     | String / null      |

**Throws:** `TypeError` if `userId` is an empty string, a non-string value, contains `@`, or is not a valid UUID (per RFC 4122 / `uuid.validate`). The same validation is applied to `options.client.impersonateAs` when an `@`-free string is passed in (which is otherwise treated as a literal user UUID).

**Returns:** None

### WideSkyClient.impersonateAsEmail(email)
**Description:** Resolve a WideSky user by account email and impersonate as
that user for subsequent requests. Performs a Haystack `find` for the matching
`account` entity (`account and email=="<email>"`), reads its `userRef` tag to
obtain the user UUID, and then delegates to
[`impersonateAs`](#wideskyclientimpersonateasuserid).

The lookup itself always runs as the configured (authenticated) user — any
impersonation already in effect when this method is called is suspended for
the duration of the find and reinstated only if the lookup fails. Concurrent
calls (whether from parallel lazy resolutions or explicit back-to-back
invocations) are serialised through a single in-flight promise, so order of
resolution matches order of invocation and no request is ever sent without
the resolved `X-IMPERSONATE` header.

The email is logged at `debug` level only; the resolved user UUID is logged
at `info`. Treat the email as PII when configuring log aggregation.

**Parameters:**

| Param   | Description                                                    |  Type  |
|---------|----------------------------------------------------------------|:------:|
| `email` | Email of the account whose user entity should be impersonated. | String |

**Returns:** `Promise<String>` — the resolved user UUID now being impersonated.

Error messages from **lookup-result** failures (no rows, multiple rows,
no `userRef`, malformed `userRef`) carry a **redacted** form of the email
(e.g. `a***@example.com`) in `err.message` so that generic
`logger.error(err)` / `JSON.stringify(err)` / `util.inspect(err)` patterns do
NOT exfiltrate the local-part as PII. The raw email is attached on
`err.email` as a **non-enumerable** property — callers that need the full
value can access it deliberately (`err.email`), while default serialisers
skip it.

**Transport** errors (network failure, axios 4xx/5xx, Haystack parse error)
from the underlying `submitRequest` call are re-thrown **unmodified**.
Axios errors carry `err.config.data` which embeds the request body, and the
body contains the Haystack filter literal `account and email=="<email>"`.
Bunyan's default `stdSerializers.err` extracts only `name`/`message`/`stack`
and is safe; generic `JSON.stringify(err)` via axios's own `toJSON()` is not.
Configure your error serialiser accordingly if the lookup endpoint may
fail transient-ly in environments where the email is treated as PII.

**Throws:**
- `TypeError` when `email` is not a non-empty string.
- `Error('No account found for email <redacted>')` when the lookup returns no rows.
- `Error('Multiple accounts (<n>) found for email <redacted>')` when more than one account matches (the find is issued with `limit: 2` specifically to detect this).
- `Error('Account for <redacted> has no userRef tag')` when the matched account entity has no `userRef` tag.
- `Error('Account for <redacted> has a malformed userRef (not a UUID): <value>')` when the extracted user id is not a valid UUID.
- Any error raised by the underlying `submitRequest` call (network failure, authentication error, Haystack parse error, axios 4xx/5xx, etc.).

### WideSkyClient.unsetImpersonate()
**Description:** Clear any active impersonation and any pending email-based
impersonation queued via the `client.impersonateAs` option. Equivalent to
calling `impersonateAs(null)`. The prior user UUID (if any) is logged at
`info` level for audit purposes.

**Parameters:** None.

**Returns:** None.

### WideSkyClient.submitRequest(method, uri, body, config)
**Description:** Submit a request manually to the WideSky server.  
**Parameters:**

| Param    | Description                                                                                    |  Type  | Default |
|----------|------------------------------------------------------------------------------------------------|:------:|:-------:|
| `method` | Request method to be performed.                                                                | String |         |
| `uri`    | Sub URI from the configured `baseUri` of the `WideSkyClient` instance to issue the request to. | String |         |
| `body`   | Body of the request.                                                                           | Object |  `{}`   |
| `config` | Configurations for the request, as specified for `axios`.                                      | Object |  `{}`   |

**Returns:** Response from the request.

### WideSkyClient.setAcceptGzip(acceptGzip)
**Description:** Configure the responses from requests to specify GZip encoding.  
**Parameters:**

| Param        | Description                      |  Type   |
|--------------|----------------------------------|:-------:|
| `acceptGzip` | Enable or disable GZip encoding. | Boolean |

**Returns:** None

## Haystack Functions
A list of Haystack functions that follow the Haystack Project specification.

### WideSkyClient.read(ids)
**Description:** Perform a `read` request of the WideSky API server.  
**Parameters:**

| Param | Description               |      Type       |
|-------|---------------------------|:---------------:|
| `ids` | Entity IDs to search for. | String or Array |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.find(filter, limit)
**Description:** Perform a `read` request of the WideSky API server using a filter to refine the selection.  
**Parameters:**

| Param    | Description                                     |  Type  | Default |
|----------|-------------------------------------------------|:------:|:-------:|
| `filter` | Filter expression                               | String |         |
| `limit`  | Limit on the number of entities to be returned. | Number |    0    |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.create(entities)
**Description:** Create one or more entities.  
**Parameters:**

| Param      | Description                            |  Type  |
|------------|----------------------------------------|:------:|
| `entities` | Array of entity Objects to be created. | Object |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.update(entities)
**Description:** Update one or more entities.  
**Parameters:**

| Param      | Description                            |  Type  |
|------------|----------------------------------------|:------:|
| `entities` | Array of entity Objects to be updated. | Object |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.deleteById(ids)
**Description:** Delete one or more entities given as IDs.  
**Parameters:**

| Param | Description               |      Type       |
|-------|---------------------------|:---------------:|
| `ids` | Entity IDs to be deleted. | String or Array |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.deleteByFilter(filter, limit)
**Description:** Delete entities that match a given filter expression.  
**Parameters:**

| Param    | Description                                       |  Type  | Default |
|----------|---------------------------------------------------|:------:|:-------:|
| `filter` | Filter expression to select entities for removal. | String |         |
| `limit`  | Limit on the number of entities to be deleted.    | Number |    0    |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.hisRead(ids, from, to, batchSize)
**Description:** Perform a historical read of the entity `ids` given.  
**Parameters:**

| Param       | Description                                                                                                 |      Type       | Default |
|-------------|-------------------------------------------------------------------------------------------------------------|:---------------:|:-------:|
| `ids`       | Entity or entities to be read.                                                                              | String or Array |         |
| `from`      | A textual Haystack read range or a Date Object representing the starting time stamp of the read.            | String or Date  |         |
| `to`        | A textual Haystack read range or a Date Object representing the ending time stamp of the read.              | String Or Date  |         |
| `batchSize` | Set the number of `ids` to be read to be batched per request sent. These requests will be sent in parallel. |     Number      |   50    |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.hisWrite(records)
**Description:** Perform a historical write request.  
**Parameters:**

| Param     | Description                                                                                                         |  Type  |
|-----------|---------------------------------------------------------------------------------------------------------------------|:------:|
| `records` | Records to be written keyed by time stamp. Each record should map the point's ID to its value for that time record. | Object |

A `record` Object is expected to be structured as:
```json
{
  "t:<haystackTimeString>": {
    "r:<pointID>": "<haystackValueToBeWritten>",
    ...
  },
  ...
}
```

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.watchSub(pointsIds, lease, description, config)
**Description:** Initiate a Haystack WatchSub operation based on the given list of `pointIds`.  
**Parameters:**

| Param         | Description                                      |      Type       | Default |
|---------------|--------------------------------------------------|:---------------:|:-------:|
| `pointIds`    | The point Ids to perform watchSub on.            | String or Array |         |
| `lease`       | Duration (ms) the watch will exist,              |     String      |         |
| `description` | A short description for the watch session.       |     String      |         |
| `config`      | Configuration options used in `submitRequest()`, |     Object      |  `{}`   |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.watchExtend(watchId, pointIds, lease, config)
**Description:** Initiate a haystack watchSub op to extend a watch given the watchId and lease.  
**Parameters:**

| Param      | Description                                      |      Type       | Default |
|------------|--------------------------------------------------|:---------------:|:-------:|
| `watchId`  | The ID of the opened watch.                      | String or Array |         |
| `pointIds` | The point Ids to perform watchExtension on.      |     String      |         |
| `lease`    | Duration (ms) the watch will exist.              |     String      |         |
| `config`   | Configuration options used in `submitRequest()`, |     Object      |  `{}`   |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.watchUnsub(watchId, deletePointIds, close, config)
**Description:** Initiate a watchUnsub op using the given watchId. If deletePointIds is set, then the listed points
will be removed from the watch.
**Parameters:**

| Param            | Description                                     |      Type       | Default |
|------------------|-------------------------------------------------|:---------------:|:-------:|
| `watchId`        | ID of the opened watch.                         |     String      |         |
| `deletePointIds` | The point entities to be deleted.               | String or Array |         |
| `close`          | If `true`, the watch session will be closed.    |     Boolean     | `true`  |
| `config`         | Configuration options used in `submitRequest()` |     Object      |  `{}`   |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

### WideSkyClient.getWatchSocket(watchId)
**Description:** Initiate a watch socket object given a valid watch ID string.  
**Parameters:**

| Param     | Description   |  Type  |
|-----------|---------------|:------:|
| `watchId` | The Watch ID. | String |

**Returns:** `Promise<Socket>` - A socket.io Socket object.

### WideSkyClient.hisDelete(ids, range)
**Description:** Perform a history delete request.  
**Parameters:**

| Param   | Description                                                             |      Type       |
|---------|-------------------------------------------------------------------------|:---------------:|
| `ids`   | A single or Array of Point IDs to be delete historical data from.       | String or Array |
| `range` | A valid hisRead range string. Note that the end range is not inclusive. |     String      |

**Returns:** `Promise<RawGrid>` - A response that resolved to the raw grid.

## Realtime Publisher Functions
Functions for pushing current ("cur") values into WideSky in realtime over a
socket.io namespace (the publisher role). A `PublisherSession` registers a point
set over REST, opens a socket, emits `pointUpdate` frames, and surfaces
server-pushed `pointCadence` / `pointUpdateError` events. Cadence is watch-driven
server-side (a live consumer watch selects the fast cadence, no watch selects the
slow cadence); the publisher only sees the resulting `pointCadence` hints.

### WideSkyClient.createPublisher()
**Description:** Create a new, unregistered realtime `PublisherSession` bound to
this client.  
**Parameters:** None.

**Returns:** `PublisherSession` - A new publisher session.

### PublisherSession.watchPub(body, config)
**Description:** Register (or update) a publisher watch over REST
(`POST /api/watchPub`). Three modes: **fresh** (omit `watchId`), **referenced
update** (supply `watchId`; the claim set is replaced in place and the same
`watchId` returned; points absent from `data` are unpublished), and
**supersede** (omit `watchId` but include points already claimed by the same
user's prior watch; the old watch is released and the points re-claimed). The
returned `watchId` is stashed on the session and the body retained for
dead-namespace recovery.  
**Parameters:**

| Param    | Description                                                                                                                                              |  Type  | Default |
|----------|--------------------------------------------------------------------------------------------------------------------------------------------------------|:------:|:-------:|
| `body`   | watchPub body: `{ watchId?, onDisconnect?, shortRefs?, data:[{ id, intervalFast, intervalSlow?, curVal?, curStatus?, curErr? }] }`. `data` is required and non-empty. `intervalFast` is the in-demand cadence; `intervalSlow` the out-of-demand cadence (0 = sleep out of demand). The retired `intervalHot`/`intervalWarm` names are rejected. | Object |         |
| `config` | Configuration options used in `submitRequest()`.                                                                                                       | Object |  `{}`   |

**Returns:** `Promise<Object>` - The parsed `{ watchId, data:[...] }` response.

### PublisherSession.watchUnpub(watchId, config)
**Description:** Release all claims belonging to a publisher watch
(`POST /api/watchUnpub`). A `404` for a legitimate owner is idempotent success
(the watch was already released).  
**Parameters:**

| Param     | Description                                       |  Type  |    Default     |
|-----------|---------------------------------------------------|:------:|:--------------:|
| `watchId` | Watch to release.                                 | String | `this.watchId` |
| `config`  | Configuration options used in `submitRequest()`.  | Object |      `{}`      |

**Returns:** `Promise<Object>` - The (empty) response body.

### PublisherSession.connect(watchId, opts)
**Description:** Open a socket.io connection to the watch namespace and resolve
once connected. The handshake carries the access token in the connection query
exactly as `getWatchSocket` does; the token is awaited from the client first,
so a refresh in flight is consumed rather than raced, and if no credential can
be acquired the returned promise rejects with the acquisition error before any
handshake is attempted. `watchPub()` must have completed first.  
**Parameters:**

| Param   | Description                                                                                                                       |  Type  |    Default     |
|---------|---------------------------------------------------------------------------------------------------------------------------------|:------:|:--------------:|
| `watchId` | Namespace to connect to.                                                                                                       | String | `this.watchId` |
| `opts`  | `{ timeoutMs=10000, autoReregister=true }`. `autoReregister` enables a fresh `watchPub` of the same point set when the namespace is found dead. | Object |      `{}`      |

**Returns:** `Promise<Socket>` - The connected socket.io socket.

### PublisherSession.pointUpdate(entries, opts)
**Description:** Emit a `pointUpdate` frame (a socket.io `message` event with
`command: "pointUpdate"`). Each entry's `id` may be a full Haystack ref or a
short key registered in the watchPub `shortRefs` map. An `id`-only entry is a
no-op accepted by the server; an entry with no `id` is malformed and dropped
server-side.  
**Parameters:**

| Param     | Description                                                       |  Type  | Default |
|-----------|------------------------------------------------------------------|:------:|:-------:|
| `entries` | Array of `{ id, curVal?, curStatus?, curErr?, ts? }` (or a single such object). | Array  |         |
| `opts`    | `{ ts?, his?, ack?, ackTimeoutMs? }`. `ts` is a message-level timestamp applied to entries that omit their own `ts`. `his: true` asks the server to ALSO persist each entry's value to history at its effective ts (a frame-level, per-call opt-in, independent of the point's own `his` marker tag); omitted/false is a cur-only update (the default: `pointUpdate` never historises unless you opt in). `ack: true` asks for delivery confirmation and changes the return type (below). `ackTimeoutMs` bounds that wait; it defaults to 30000. | Object |  `{}`   |

**Returns:** `undefined` when `opts.ack` is not set, otherwise a
`Promise<Object>` that settles when the server has finished persisting the
frame. The promise NEVER rejects and never waits indefinitely:

| `status` | Meaning |
|---|---|
| `ack` | the frame is RESOLVED and may be dropped. `applied` counts the entries the server committed, and `0` is legitimate — it declined them all, on purpose. |
| `nack` | something went WRONG. `failed[]` names each bad entry as `{id, reason}`. |
| `unacked` | no answer inside `ackTimeoutMs`. UNCONFIRMED, which is never the same as "fine". |

Not asking for the ack is the right default for a CUR frame: the next tick
supersedes it, so confirming one buys nothing and re-sending a stale one is
wrong. That is a statement about cur, not a compatibility switch — **a caller
publishing HISTORY asks for the ack, always.**

### PublisherSession.close(opts)
**Description:** Cleanly close the session: stop the socket (no reconnect), drop
all listeners, and clear retained state so no timers/sockets linger. Optionally
release the watch over REST first.  
**Parameters:**

| Param  | Description                              |  Type  | Default |
|--------|------------------------------------------|:------:|:-------:|
| `opts` | `{ unpub=false }` also issue watchUnpub. | Object |  `{}`   |

**Returns:** `Promise<void>`

### PublisherSession events
A `PublisherSession` is an `EventEmitter`. Events emitted:

| Event              | Payload                | Description                                                                          |
|--------------------|------------------------|--------------------------------------------------------------------------------------|
| `connect`          | (none)                 | Socket.io transport connected (owner socket live).                                   |
| `disconnect`       | `reason`               | Socket.io disconnected.                                                              |
| `pointCadence`     | `{ data:[{id,mode}] }` | Server publish-cadence hint (`mode` is `fast`/`slow`); also fired as a connect burst. |
| `pointUpdateError` | `{ err, errorCode }`   | Typed rejection. Codes: 404 (namespace/ownership), 413 (frame too large), 409 (superseded). |
| `superseded`       | `{ err, errorCode }`   | Convenience event fired alongside a 409 `pointUpdateError`.                          |
| `reregister`       | watchPub response      | Automatic fresh watchPub completed after the namespace was found dead (also fired alongside `reregistered` on socket-loss recovery so existing handlers resync). |
| `reregisterError`  | `Error`                | Automatic re-register failed.                                                        |
| `connectionError`  | `reason`               | Socket.io connection_error / connect_error (e.g. a non-owner socket rejected).       |
| `recovering`       | `reason`               | Socket-loss recovery has begun (a clean restart presents as a plain disconnect / connect_error, not a 404). |
| `reregistered`     | watchPub response      | Socket-loss recovery completed: a fresh watchPub + reconnect succeeded; the app should resend its last-known values. |
| `socketSwap`       | the new socket         | The session replaced its socket with a fresh one (after a recovery / re-register); a shared `ControlSession` listens for this to rebind its command handler. |

## Realtime Control Listener Functions
Functions for receiving realtime control commands (the listener role). A
`ControlSession` registers as a control-command listener for a set of points over
REST, connects a socket (or reuses an owning publisher's socket for a shared
registration), surfaces inbound `pointWrite` commands as `command` events, and
settles them with `reportWrite`. A listener raises no publisher demand and
receives no point value data; it needs `POINT_WRITE` to receive a command and
`CONTROL_EXECUTE` to reply.

### WideSkyClient.createControlListener(options)
**Description:** Create a new, unregistered realtime `ControlSession` bound to
this client.  
**Parameters:**

| Param     | Description                                                                                             |  Type  | Default |
|-----------|-------------------------------------------------------------------------------------------------------|:------:|:-------:|
| `options` | `{ publisher?, autoRecover=true }`. `publisher` reuses a `PublisherSession`'s socket for a shared registration. | Object | `{}`    |

**Returns:** `ControlSession` - A new control listener session.

### ControlSession.controlSub(body, config)
**Description:** Register a control listener for a set of points over REST
(`POST /api/controlSub`). Per-point `POINT_WRITE` is checked server-side and a
per-point `forbidden`/`unknown-point` status is reported (like watchPub). The
response `shared` flag selects the transport: `shared:true` reuses an owning
publisher's namespace, otherwise the registration id is a standalone listener
namespace.  
**Parameters:**

| Param    | Description                                                                                          |  Type  | Default |
|----------|-----------------------------------------------------------------------------------------------------|:------:|:-------:|
| `body`   | controlSub body `{ data:[{ id }] }`, or a bare id / array of ids / array of `{ id }` (wrapped).      | Object |         |
| `config` | Configuration options used in `submitRequest()`.                                                    | Object |  `{}`   |

**Returns:** `Promise<Object>` - The parsed `{ registrationId?, shared, data:[...] }` response.

### ControlSession.controlUnsub(registrationId, config)
**Description:** Release the control registration over REST
(`POST /api/controlUnsub`). Owner-only; an unknown or non-owner registration
404s.  
**Parameters:**

| Param            | Description                                       |  Type  |        Default        |
|------------------|---------------------------------------------------|:------:|:---------------------:|
| `registrationId` | Registration to release.                          | String | `this.registrationId` |
| `config`         | Configuration options used in `submitRequest()`.  | Object |          `{}`         |

**Returns:** `Promise<Object>` - The (empty) response body.

### ControlSession.connect(registrationId, opts)
**Description:** Start receiving control commands. For a shared registration
(owning publisher set) no socket of our own is opened — the command handler binds
to the publisher's socket. For a standalone registration a socket.io connection
is opened to the registration namespace (resolves on the `WideSkyConnected` open
handshake). The access token is awaited from the client before the socket is
built; if no credential can be acquired the returned promise rejects with the
acquisition error and no handshake is attempted.  
**Parameters:**

| Param            | Description                                                                          |  Type  |        Default        |
|------------------|--------------------------------------------------------------------------------------|:------:|:---------------------:|
| `registrationId` | Namespace to connect to.                                                             | String | `this.registrationId` |
| `opts`           | `{ timeoutMs=10000, autoReregister=true, autoRecover }`.                              | Object |          `{}`         |

**Returns:** `Promise<Socket|null>` - The connected socket (standalone), or `null` (shared transport).

### ControlSession.reportWrite(requestId, data, opts)
**Description:** Reply to a `pointWrite` command, settling the request. Sent on
whichever socket carries the registration (the publisher's for a shared
transport, else the standalone listener socket).  
**Parameters:**

| Param       | Description                                                              |  Type  | Default |
|-------------|-------------------------------------------------------------------------|:------:|:-------:|
| `requestId` | The `requestId` of the `pointWrite` being settled.                      | String |         |
| `data`      | Per-point results `[{ id, writeVal?, writeStatus, writeErr? }]` (or one such object). | Array  |         |
| `opts`      | `{ done=true }` whether this reply fulfils the request.                 | Object |  `{}`   |

**Returns:** `void`

### ControlSession.attachTo(publisher)
**Description:** Bind an owning `PublisherSession` so a shared registration
reuses its socket. Call before `controlSub()` (or pass `{ publisher }` to
`createControlListener`).  
**Parameters:**

| Param       | Description                  |        Type       | Default |
|-------------|------------------------------|:-----------------:|:-------:|
| `publisher` | The owning publisher session.| PublisherSession  |         |

**Returns:** `ControlSession` - this (for chaining).

### ControlSession.close(opts)
**Description:** Cleanly close the session: stop the socket (no reconnect), drop
the shared handler off any owning publisher socket, drop all listeners and clear
retained state. Optionally release the registration over REST first.  
**Parameters:**

| Param  | Description                                |  Type  | Default |
|--------|--------------------------------------------|:------:|:-------:|
| `opts` | `{ unsub=false }` also issue controlUnsub. | Object |  `{}`   |

**Returns:** `Promise<void>`

### ControlSession events
A `ControlSession` is an `EventEmitter`. Events emitted:

| Event             | Payload                                  | Description                                                              |
|-------------------|------------------------------------------|-------------------------------------------------------------------------|
| `connect`         | (none)                                   | Listener connected (own socket open, or bound to the publisher socket). |
| `disconnect`      | `reason`                                 | Standalone listener socket disconnected.                                |
| `command`         | `{ command, requestId, data:[{id,value}] }` | Inbound `pointWrite` command to settle with `reportWrite`.           |
| `connectionError` | `reason`                                 | Socket.io connection_error / connect_error.                            |
| `recovering`      | `reason`                                 | Standalone socket-loss recovery has begun.                             |
| `reregister` / `reregistered` | controlSub response          | Standalone socket-loss recovery completed (fresh controlSub + connect). |
| `reregisterError` | `Error`                                  | Automatic re-register failed.                                          |

## Consumer Watch Lease Renewal

### WideSkyClient.createWatchRenewer(opts)
**Description:** Create a lease auto-renewer for a consumer watch.
`/api/watchPoll` renews a watch's lease server-side, so a polling consumer never
needs explicit renewal. A socket-style consumer (`watchSub` + `getWatchSocket`,
no `watchPoll`) gets no special lease treatment, so the renewer re-issues
`watchSub` with the watchId (the `watchExtend` form) at half the lease until
stopped (`start()` / `stop()`).  
**Parameters:**

| Param  | Description                                                                                                       |  Type  | Default |
|--------|-----------------------------------------------------------------------------------------------------------------|:------:|:-------:|
| `opts` | `{ watchId, pointIds, lease, leaseMs?, renewFraction=0.5, onError? }`. `leaseMs` is parsed from `lease` if omitted. | Object |         |

**Returns:** `ConsumerWatchRenewer` - A new, unstarted renewer; call `start()` to begin.

## Version 2 Functions
A list of functions that modify the response of the Haystack functions to be more suitable for machine consumption.

### WideSkyClient.v2.find(filter, limit)
**Description:** Perform a `WideSkyClient.find` operation but only return the rows from the Haystack grid.  
**Parameters:**

| Param    | Description                                     |  Type  | Default |
|----------|-------------------------------------------------|:------:|:-------:|
| `filter` | Filter expression                               | String |         |
| `limit`  | Limit on the number of entities to be returned. | Number |    0    |

**Returns:** `Array<Entity>` - A Array of found entities from the filter expression.

## Batch Functions
A list of functions that use the base functions of `WideSkyClient` but with batch functionality incorporated. The
functions can be used to complete a requested operation whilst working within the limitation imposed by the WideSky
server.

### WideSkyClient.performOpInBatch(op, args, options)
**Description:** Perform a `WideSkyClient` operation using batch functionality to issue batched payloads in parallel
requests.  
**Parameters:**

| Param     | Description                                                                                                                                        |  Type  | Default |
|-----------|----------------------------------------------------------------------------------------------------------------------------------------------------|:------:|:-------:|
| `op`      | `WideSkyClient` function to be called.                                                                                                             | String |         |
| `args`    | Arguments or parameters to be passed to the given `op`.                                                                                            | Array  |         |
| `options` | Options to configure the behaviour of the batched functionality. See [batch options](options.md#path-clientperformopinbatch) for more information. | Object |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{error: String, args: []}>}>`
- `success`: Contain the responses of successful operations when `options.returnResult` is `true`.
- `errors`: Contain an errors encountered when performing operations.

### WideSkyClient.batch.hisWrite(hisWriteData, options)
**Description:** Perform a hisWrite operation using batch functionality.  
**Parameters:**

| Param          | Description                                                                                                                                                                                                                           |           Type            | Default |
|----------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:-------------------------:|:-------:|
| `hisWriteData` | HisWrite data to be sent. Can be the raw hisWrite payload or an instance of HisWritePayload.                                                                                                                                          | Object or HisWritePayload |         |
| `options`      | An Object defining batch configurations to be used. See README.md for more information. Option batchSize is determined by the maximum number of time series rows to be sent. The rows are defined as the time series for each entity. |          Object           |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: Contain the responses of successful operations of hisWrite when `options.returnResult` is `true`.
- `errors`: Contain an errors encountered when performing operations.

### WideSkyClient.batch.hisRead(ids, from, to, options)
**Description:** Perform a history read request using batch functionality.  
**Parameters:**

| Param     | Description                                                                                                                                                           |      Type      | Default |
|-----------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------|:--------------:|:-------:|
| `ids`     | Entities to read.                                                                                                                                                     |     Array      |         |
| `from`    | Haystack read range or a Date Object representing where to grab historical data from.                                                                                 | String or Date |         |
| `to`      | Date Object representing where to grab historical data to (not inclusive).                                                                                            | String or Date |         |
| `options` | An Object defining batch configurations to be used. See README.md for more information. Option batchSize is determined by the number of ids to perform a hisRead for. |     Object     |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: A 2D array of time series data in the order of ids queried.
- `errors`: Contain an errors encountered when performing operations.

### WideSkyClient.batch.hisDelete(ids, start, end, options)
**Description:** Perform a history delete request using batch functionality. Row counts are requested from the server
and used to split the range into requests of at most `options.batchSize` rows per entity, without reading any history.
The range may also be given as a single Haystack range string: `WideSkyClient.batch.hisDelete(ids, range, options)`.
See [batch.md](batch.md#path-clientbatchhisdelete) for how the range is planned, retried and reported.  
**Parameters:**

| Param     | Description                                                                                                                                                       |      Type      | Default |
|-----------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------|:--------------:|:-------:|
| `ids`     | An array of point entity UUIDs for the delete operations or a single string. These will be batched by options.batchSizeEntity.                                    |     Array      |         |
| `start`   | Starting timestamp to be deleted as a Date Object. Pass a Haystack range string here instead to use the range form, in which `options` follows directly after it.                                | Date or String |         |
| `end`     | Ending timestamp to be deleted as a Date Object (not inclusive).                                                                                                  |      Date      |         |
| `options` | An Object defining batch configurations to be used. See batch.md for more information. Option batchSize is the maximum number of rows deleted per entity per request. |     Object     |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{error: String, args: Array}>}>`
- `success`: Return the responses of hisDelete operations if `options.returnResult` is `true`.
- `errors`: Return the errors encountered from hisDelete operations. `args[0]` is `"hisDelete"` or `"countQuery"`.

### WideSkyClient.batch.create(entities, options)
**Description:** Perform a create request using batch functionality. The request are batched based on the number of
entities given.  
**Parameters:**

| Param      | Description                                                                             |  Type  | Default |
|------------|-----------------------------------------------------------------------------------------|:------:|:-------:|
| `entities` | Entities to be created.                                                                 | Array  |         |
| `options`  | An Object defining batch configurations to be used. See README.md for more information. | Object |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: Return the result of each successful create operation if `options.returnResult` is `true`.
- `errors`: Return the errors encountered for each failed create operation.

### WideSkyClient.batch.update(entities, options)
**Description:** Perform an update requesting using batch functionality. The request are batched based on the number
of entities given.  
**Parameters:**

| Param      | Description                                                                             |  Type  | Default |
|------------|-----------------------------------------------------------------------------------------|:------:|:-------:|
| `entities` | Entities and respective tags to be updated.                                             | Array  |         |
| `options`  | An Object defining batch configurations to be used. See README.md for more information. | Object |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: Return the result of each successful update operation if `options.returnResult` is `true`.
- `errors`: Return the errors encountered for each failed update operation.

### WideSkyClient.batch.deleteById(ids, options)
**Description:** Perform a deleteById operation using batch functionality. The request are batched based on the number
of entities given.  
**Parameters:**

| Param     | Description                                                                             |  Type  | Default |
|-----------|-----------------------------------------------------------------------------------------|:------:|:-------:|
| `ids`     | The id of each entity to be deleted.                                                    | Array  |         |
| `options` | An Object defining batch configurations to be used. See README.md for more information. | Object |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: Return the result of each successful update operation if `options.returnResult` is `true`.
- `errors`: Return the errors encountered for each failed update operation.

### WideSkyClient.batch.deleteByFilter(filter, limit, options)
**Description:** Perform a deleteByFilter operation using batch functionality. The request are batched based on the
number of entities retrieved from the given filter and limit. The batched payloads are passed to 
`WideSkyClient.deleteById`.
**Parameters:**

| Param     | Description                                                                             |  Type  | Default |
|-----------|-----------------------------------------------------------------------------------------|:------:|:-------:|
| `filter`  | Filter to search for entities.                                                          | String |         |
| `limit`   | Limit to be imposed on the result of the given filter.                                  | Number |         |
| `options` | An Object defining batch configurations to be used. See README.md for more information. | Object |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: Return the result of each successful deleteByID operation if `options.returnResult` is `true`.
- `errors`: Return the errors encountered for each failed `deleteById` operation.

### WideSkyClient.batch.hisReadByFilter(filter, from, to, options)
**Description:** Perform a hisRead using a filter to select the entities with batch functionality.  
**Parameters:**

| Param     | Description                                                                             |  Type  | Default |
|-----------|-----------------------------------------------------------------------------------------|:------:|:-------:|
| `filter`  | Filter to search for entities.                                                          | String |         |
| `from`    | Haystack read range or a Date Object representing where to grab historical data from.   |  Date  |         |
| `to`      | Date Object representing where to grab historical data to (not inclusive).              |  Date  |         |
| `options` | An Object defining batch configurations to be used. See README.md for more information. | Object |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: Return the result of each successful hisRead operation if `options.returnResult` is `true`.
- `errors`: Return the errors encountered for each failed hisRead operation.

### WideSkyClient.batch.updateByFilter(filter, criteriaList, options)
**Description:** Update the entities found in the filter by the given list of criteria using batch functionality.  
**Parameters:**

| Param          | Description                                                                             |  Type  | Default |
|----------------|-----------------------------------------------------------------------------------------|:------:|:-------:|
| `filter`       | Filter to search for entities.                                                          | String |         |
| `criteriaList` | A list of EntityCriteria objects defining the criteria to match against.                | Array  |         |
| `options`      | An Object defining batch configurations to be used. See README.md for more information. | Object |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: Return the result of each successful update operation if `options.returnResult` is `true`.
- `errors`: Return the errors encountered for each failed update operation.

### WideSkyClient.batch.hisDeleteByFilter(filter, start, end, options)
**Description:** Perform a hisDelete using a filter to select the entities.  
**Parameters:**

| Param     | Description                                                                                                                                                                                          |  Type  | Default |
|-----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:------:|:-------:|
| `filter`  | Filter to select the entities to be hisDelete'd.                                                                                                                                                     | String |         |
| `start`   | Starting timestamp to be deleted as a Date Object.                                                                                                                                                   |  Date  |         |
| `end`     | Ending timestamp to be deleted as a Data Object (not inclusive).                                                                                                                                     |  Date  |         |
| `options` | An Object defining batch configurations to be used. See README.md for more information. Option batchSize is determined by the maximum number of time series rows to be deleted across all ids given. | Object |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: Return the result of each successful hisDelete operation when `options.returnResult` is `true`.
- `errors`: Return any errors encountered when performing hisDelete operations.

### WideSkyClient.batch.migrateHistory(fromEntity, toEntity, options)
**Description:** Perform a historical data migration between fromEntity and toEntity using batch functionality.  
**Parameters:**

| Param        | Description                                                                                                                                                                                                                           |  Type  | Default |
|--------------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:------:|:-------:|
| `fromEntity` | The entity to migrate data from as a UUID or fqname.                                                                                                                                                                                  | String |         |
| `toEntity`   | The entity to migrate data to as a UUID or fqname.                                                                                                                                                                                    | String |         |
| `options`    | An Object defining batch configurations to be used. See README.md for more information. Option batchSize is determined by the maximum number of time series rows to be sent. The rows are defined as the time series for each entity. | Object |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: Return the success hisWrite data that has been migrated to toEntity if `options.returnResult` is `true`.
- `errors`: Return all errors encountered.

### WideSkyClient.batch.addChildrenByFilter(filter, children, tagMap, options)
**Description:** Add the given children the parents found in the given filter.  
**Parameters:**

| Param      | Description                                                                                                                                                                                               |     Type     | Default |
|------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:------------:|:-------:|
| `filter`   | Filter to define the parents.                                                                                                                                                                             |    String    |         |
| `children` | Children to be added to the found parents.                                                                                                                                                                |    Array     |         |
| `tagMap`   | A 2D Array of tags to be copied from the parent (if present) to the child entities. Each element of the Array is an Array with elements as [tagOfParent, toTagOnChild]. For example [["id", "equipRef"]]. | Array<Array> |         |
| `options`  | An Object defining batch configurations to be used. See README.md for more information.                                                                                                                   |    Object    |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: Return the result of the create operations performed when `options.returnResult` is `true`.
- `errors`: Return an errors encountered from the create operations performed.

### WideSkyClient.batch.multiFind(filterAndLimits, options)
**Description:** Perform multi read-by-filter requests in a single request. The number of filters sent in a request
is determined.  
**Parameters:**

| Param            | Description                                                                             |     Type     | Default |
|------------------|-----------------------------------------------------------------------------------------|:------------:|:-------:|
| `filterAndLimit` | A 2D Array defining the filter and limit of each read-by-filter to be queried.          | Array<Array> |         |
| `options`        | An Object defining batch configurations to be used. See README.md for more information. |    Object    |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: A 2D Array of the result from each read-by-filter given.
- `errors`: All errors encountered from performing read-by-filter operations.

### WideSkyClient.batch.updateOrCreate(entities, options)
**Description:** Perform an update or create request for the list of entities given. If the entity exists, the
entity will be checked for changes if an update is required, and send a request as necessary. If the entity does
not exist, it will be created.  
**Parameters:**

| Param      | Description                                                                             |  Type  | Default |
|------------|-----------------------------------------------------------------------------------------|:------:|:-------:|
| `entities` | Array of entities to be updated or created.                                             | Array  |         |
| `options`  | An Object defining batch configurations to be used. See README.md for more information. | Object |  `{}`   |

**Returns:** `Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>`
- `success`: Array of entities in their current state in the WideSky database.
- `errors`: Any errors encountered during create or update operations.