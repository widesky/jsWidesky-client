# Table of Contents
<!-- toc -->

- [Batch Operations Configuration](#batch-operations-configuration)
  - [Path `client.batch.hisRead`](#path-clientbatchhisread)
  - [Path `client.batch.hisWrite`](#path-clientbatchhiswrite)
  - [Path `client.batch.hisDelete`](#path-clientbatchhisdelete)
  - [Path `client.batch.create`](#path-clientbatchcreate)
  - [Path `client.batch.update`](#path-clientbatchupdate)
  - [Path `client.batch.deleteById`](#path-clientbatchdeletebyid)
  - [Path `client.batch.deleteByFilter`](#path-clientbatchdeletebyfilter)
  - [Path `client.batch.hisReadByFilter`](#path-clientbatchhisreadbyfilter)
  - [Path `client.batch.addChildrenByFilter`](#path-clientbatchaddchildrenbyfilter)
  - [Path `client.batch.updateByFilter`](#path-clientbatchupdatebyfilter)
  - [Path `client.batch.migrateHistory`](#path-clientbatchmigratehistory)
  - [Path `client.batch.hisDeleteByFilter`](#path-clientbatchhisdeletebyfilter)
  - [Path `client.batch.updateOrCreate`](#path-clientbatchupdateorcreate)
  - [Path `client.batch.multiFind`](#path-clientbatchmultifind)

<!-- tocstop -->

## Batch Operations Configuration
The `batch` property of the `options` argument used in `WideSkyClient` is expected to have the following structure:

| Path from `client.batch` | Description                                                 |  Type  |                                  Default                                  |
|--------------------------|-------------------------------------------------------------|:------:|:-------------------------------------------------------------------------:|
| `hisRead`                | Define the default batch configurations for this functions. | Object |       As per the table of configurations for `client.batch.hisRead`       |
| `hisWrite`               | Define the default batch configurations for this functions. | Object |      As per the table of configurations for `client.batch.hisWrite`       |
| `hisDelete`              | Define the default batch configurations for this functions. | Object |      As per the table of configurations for `client.batch.hisDelete`      |
| `create`                 | Define the default batch configurations for this functions. | Object |       As per the table of configurations for `client.batch.create`        |
| `update`                 | Define the default batch configurations for this functions. | Object |       As per the table of configurations for `client.batch.update`        |
| `deleteById`             | Define the default batch configurations for this functions. | Object |     As per the table of configurations for `client.batch.deleteById`      |
| `deleteByFilter`         | Define the default batch configurations for this functions. | Object |   As per the table of configurations for `client.batch.deleteByFilter`    |
| `hisReadByFilter`        | Define the default batch configurations for this functions. | Object |   As per the table of configurations for `client.batch.hisReadByFilter`   |
| `addChildrenByFilter`    | Define the default batch configurations for this functions. | Object | As per the table of configurations for `client.batch.addChildrenByFilter` |
| `updateByFilter`         | Define the default batch configurations for this functions. | Object |   As per the table of configurations for `client.batch.updateByFilter`    |
| `migrateHistory`         | Define the default batch configurations for this functions. | Object |   As per the table of configurations for `client.batch.migrateHistory`    |
| `hisDeleteByFilter`      | Define the default batch configurations for this functions. | Object |  As per the table of configurations for `client.batch.hisDeleteByFilter`  |
| `updateOrCreate`         | Define the default batch configurations for this functions. | Object |   As per the table of configurations for `client.batch.updateOrCreate`    |

### Path `client.batch.hisRead`
The Object in `client.batch.hisRead` is expected to have the following structure:

| Path from `client.batch.hisRead` | Description                                                                  |  Type   | Default |
|----------------------------------|------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                      | Define the maximum size of each payload for `hisRead` operations.            | Number  |   100   |
| `batchDelay`                     | Define the time in between each batch `hisRead` request (ms).                | Number  |    0    |
| `parallel`                       | Define the number of batched requests to be run in parallel                  | Number  |    1    |
| `parallelDelay`                  | Define the delay between each set of batched requests run in parallel (ms)   | Number  |    0    |

### Path `client.batch.hisWrite`
The Object in `client.batch.hisWrite` is expected to have the following structure:

| Path from `client.batch.hisWrite` | Description                                                                   |  Type   | Default |
|-----------------------------------|-------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                       | Define the maximum number of rows of each payload for `hisWrite` operations.  | Number  |  10000  |
| `batchSizeEntity`                 | Define the maximum number of entities per `hisWrite` request. Maximum 1000.   | Number  |   100   |
| `batchDelay`                      | Define the time in between each batch `hisWrite` request (ms).                | Number  |    0    |
| `parallel`                        | Define the number of batched requests to be run in parallel                   | Number  |    1    |
| `parallelDelay`                   | Define the delay between each set of batched requests run in parallel (ms)    | Number  |    0    |
| `returnResult`                    | Enable the result from WideSky API server operation `hisWrite` to be returned | Boolean | `false` |

### Path `client.batch.hisDelete`
`client.batch.hisDelete` deletes history by asking the server how many rows each point holds, then splitting the range
into requests that stay under the server's per-point record limit. It never reads the history itself.

It can be called with either a Haystack range string or two Dates:

```js
client.batch.hisDelete(ids, range, options);           // e.g. "2026-09-01,2026-09-03" or "yesterday"
client.batch.hisDelete(ids, start, end, options);      // Date, Date (end not inclusive)
```

`range` accepts the same strings as `client.hisDelete`, with or without the `s:` prefix. Support can be detected with
`client.features.hisDeletePlanner === true`.

The Object in `client.batch.hisDelete` is expected to have the following structure:

| Path from `client.batch.hisDelete` | Description                                                                                                                                                             |  Type   |            Default             |
|------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:-------:|:------------------------------:|
| `batchSize`                        | Define the maximum number of rows to be deleted per entity in a single `hisDelete` request. Between 1 and 3000.                                                         | Number  |              500               |
| `batchSizeEntity`                  | Define the maximum number of entities in a single `hisDelete` request. Between 1 and 1000.                                                                              | Number  |               10               |
| `maxBisectDepth`                   | Define how many times a request rejected for exceeding the record limit may be halved and retried. `0` reports the request as an error instead. Between 0 and 10.       | Number  |               5                |
| `countBucketUnits`                 | Define the time units used to count rows, from coarsest to finest. Must be a non-empty list of GraphQL `duration` values, coarse to fine, without duplicates.           |  Array  | `["DAY", "HOUR", "MINUTE"]`    |
| `retries`                          | Define how many times a request is retried after a retryable failure (see below). `0` disables retrying. Between 0 and 10.                                              | Number  |               0                |
| `retryDelay`                       | Define the time to wait before each retry (ms). `0` means no delay.                                                                                                     | Number  |              2000              |
| `batchDelay`                       | Define the time in between each batch `hisDelete` request (ms).                                                                                                         | Number  |               0                |
| `parallel`                         | Define the number of batched requests to be run in parallel                                                                                                             | Number  |               1                |
| `parallelDelay`                    | Define the delay between each set of batched requests run in parallel (ms)                                                                                              | Number  |               0                |
| `returnResult`                     | Enable the result from WideSky API server operation `hisDelete` to be returned                                                                                          | Boolean |            `false`              |

Older versions used a `batchSize` of 1500 rows counted across all entities and a `batchSizeEntity` of 100. Both
defaults are now lower and `batchSize` is counted per entity, so a caller that relied on the old defaults will send more,
smaller requests.

At debug level the client logs every resolved option once per call, together with whether its value came from the call,
the client configuration or the default. A call option of `null` counts as not supplied.

#### How the range is planned
Ids are split into groups of `batchSizeEntity`, in the order given, and each group is planned on its own.

1. A range that is not a plain absolute range (for example `today`, `yesterday`, a single date or something that cannot
   be parsed) is not planned. It is sent as one request per group, exactly as given, and cannot be halved. Such ranges
   are at most a day long.
2. The server is asked for row counts over the range, in buckets of the first unit in `countBucketUnits`. A bucket
   counts as the highest row count of any entity in the group, since the server's limit applies per entity.
3. Any bucket above `batchSize` is counted again in the next finer unit. A bucket still above `batchSize` at the finest
   unit is split into equal slices.
4. Buckets are packed oldest first into requests that keep each entity at or below `batchSize` rows.
5. The requests are contiguous and together cover the whole range, so rows written while the delete is running still
   fall inside a request.
6. The first request starts with the start you gave and the last one ends with the end you gave, unchanged, so the range
   is interpreted by the server exactly as for a single `client.hisDelete`.
7. A group with no rows at all still gets one request for the whole range.

If either end of the range has no timezone offset, the server reads it in each point's own timezone. The client reads
the group's points once and plans each timezone separately. A point with no timezone, or one the client cannot map to a
known timezone, is planned with a 14 hour margin at each such end: the first and last requests for that point may then
hold more than `batchSize` rows, and a warning is logged.

#### Failures and retries
All planned requests are attempted. Failures do not stop the others; they are collected in `errors`, and requests that
succeeded are kept in `success` when `returnResult` is `true`. Each error has the form `{ error: String, args: Array }`,
and `args[0]` tells the two kinds apart:

| `args[0]`      | Meaning                                                                                                             | `args`                        |
|----------------|---------------------------------------------------------------------------------------------------------------------|-------------------------------|
| `"hisDelete"`  | A delete request failed. Nothing further is done for that request.                                                  | `["hisDelete", ids, range]`   |
| `"countQuery"` | Counting (or reading timezones) for a group failed. The group is skipped and nothing is deleted for its entities.   | `["countQuery", ids, range]`  |

A request rejected because it exceeds the per-entity record limit ("data points per entity cannot exceed") is halved
and both halves are sent, up to `maxBisectDepth` times. A request is retried up to `retries` times, waiting `retryDelay`
between attempts, only for these failures:
- HTTP status 500, 502, 503 or 504.
- Network error codes `ENETDOWN`, `ENETUNREACH`, `ECONNABORTED`, `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EHOSTDOWN`
  or `EHOSTUNREACH`.

Any other failure is not retried, including HTTP 429 and other 4xx statuses. A record-limit error is halved rather than
retried, whatever its status.

### Path `client.batch.create`
The Object in `client.batch.create` is expected to have the following structure:

| Path from `client.batch.create` | Description                                                                 |  Type   | Default |
|---------------------------------|-----------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                     | Define the maximum size of each payload for `create` operations.            | Number  |  2000   |
| `batchDelay`                    | Define the time in between each batch `create` request (ms).                | Number  |    0    |
| `parallel`                      | Define the number of batched requests to be run in parallel                 | Number  |    1    |
| `parallelDelay`                 | Define the delay between each set of batched requests run in parallel (ms)  | Number  |    0    |
| `returnResult`                  | Enable the result from WideSky API server operation `create` to be returned | Boolean | `false` |

### Path `client.batch.update`
The Object in `client.batch.update` is expected to have the following structure:

| Path from `client.batch.update` | Description                                                                 |  Type   | Default |
|---------------------------------|-----------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                     | Define the maximum size of each payload for `update` operations.            | Number  |  2000   |
| `batchDelay`                    | Define the time in between each batch `update` request (ms).                | Number  |    0    |
| `parallel`                      | Define the number of batched requests to be run in parallel                 | Number  |    1    |
| `parallelDelay`                 | Define the delay between each set of batched requests run in parallel (ms)  | Number  |    0    |
| `returnResult`                  | Enable the result from WideSky API server operation `update` to be returned | Boolean | `false` |

### Path `client.batch.deleteById`
The Object in `client.batch.deleteById` is expected to have the following structure:

| Path from `client.batch.deleteById` | Description                                                                     |  Type   | Default |
|-------------------------------------|---------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                         | Define the maximum size of each payload for `deleteById` operations.            | Number  |   30    |
| `batchDelay`                        | Define the time in between each batch `deleteById` request (ms).                | Number  |    0    |
| `parallel`                          | Define the number of batched requests to be run in parallel                     | Number  |    1    |
| `parallelDelay`                     | Define the delay between each set of batched requests run in parallel (ms)      | Number  |    0    |
| `returnResult`                      | Enable the result from WideSky API server operation `deleteById` to be returned | Boolean | `false` |

### Path `client.batch.deleteByFilter`
The Object in `client.batch.deleteByFilter` is expected to have the following structure:

| Path from `client.batch.deleteByFilter` | Description                                                                         |  Type   | Default |
|-----------------------------------------|-------------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                             | Define the maximum size of each payload for `deleteByFilter` operations.            | Number  |   30    |
| `batchDelay`                            | Define the time in between each batch `deleteByFilter` request (ms).                | Number  |    0    |
| `parallel`                              | Define the number of batched requests to be run in parallel                         | Number  |    1    |
| `parallelDelay`                         | Define the delay between each set of batched requests run in parallel (ms)          | Number  |    0    |
| `returnResult`                          | Enable the result from WideSky API server operation `deleteByFilter` to be returned | Boolean | `false` |

### Path `client.batch.hisReadByFilter`
The Object in `client.batch.hisReadByFilter` is expected to have the following structure:

| Path from `client.batch.hisReadByFilter` | Description                                                                          |  Type   | Default |
|------------------------------------------|--------------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                              | Define the maximum size of each payload for `hisReadByFilter` operations.            | Number  |   100   |
| `batchDelay`                             | Define the time in between each batch `hisReadByFilter` request (ms).                | Number  |    0    |
| `parallel`                               | Define the number of batched requests to be run in parallel                          | Number  |    1    |
| `parallelDelay`                          | Define the delay between each set of batched requests run in parallel (ms)           | Number  |    0    |
| `returnResult`                           | Enable the result from WideSky API server operation `hisReadByFilter` to be returned | Boolean | `false` |
| `filter`                                 | Define the maximum number of entities to be returned. 0 means no limit.              | Number  |    0    |

### Path `client.batch.addChildrenByFilter`
The Object in `client.batch.addChildrenByFilter` is expected to have the following structure:

| Path from `client.batch.addChildrenByFilter` | Description                                                                              |  Type   | Default |
|----------------------------------------------|------------------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                                  | Define the maximum size of each payload for `addChildrenByFilter` operations.            | Number  |  2000   |
| `batchDelay`                                 | Define the time in between each batch `addChildrenByFilter` request (ms).                | Number  |    0    |
| `parallel`                                   | Define the number of batched requests to be run in parallel                              | Number  |    1    |
| `parallelDelay`                              | Define the delay between each set of batched requests run in parallel (ms)               | Number  |    0    |
| `returnResult`                               | Enable the result from WideSky API server operation `addChildrenByFilter` to be returned | Boolean | `false` |
| `filter`                                     | Define the maximum number of entities to be returned. 0 means no limit.                  | Number  |    0    |

### Path `client.batch.updateByFilter`
The Object in `client.batch.updateByFilter` is expected to have the following structure:

| Path from `client.batch.updateByFilter` | Description                                                                         |  Type   | Default |
|-----------------------------------------|-------------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                             | Define the maximum size of each payload for `updateByFilter` operations.            | Number  |  2000   |
| `batchDelay`                            | Define the time in between each batch `updateByFilter` request (ms).                | Number  |    0    |
| `parallel`                              | Define the number of batched requests to be run in parallel                         | Number  |    1    |
| `parallelDelay`                         | Define the delay between each set of batched requests run in parallel (ms)          | Number  |    0    |
| `returnResult`                          | Enable the result from WideSky API server operation `updateByFilter` to be returned | Boolean | `false` |
| `filter`                                | Define the maximum number of entities to be returned. 0 means no limit.             | Number  |    0    |

### Path `client.batch.migrateHistory`
The Object in `client.batch.migrateHistory` is expected to have the following structure:

| Path from `client.batch.migrateHistory` | Description                                                                         |  Type   | Default |
|-----------------------------------------|-------------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                             | Define the maximum size of each payload for `migrateHistory` operations.            | Number  |  10000  |
| `batchDelay`                            | Define the time in between each batch `migrateHistory` request (ms).                | Number  |    0    |
| `parallel`                              | Define the number of batched requests to be run in parallel                         | Number  |    1    |
| `parallelDelay`                         | Define the delay between each set of batched requests run in parallel (ms)          | Number  |    0    |
| `returnResult`                          | Enable the result from WideSky API server operation `migrateHistory` to be returned | Boolean | `false` |

### Path `client.batch.hisDeleteByFilter`
The Object in `client.batch.hisDeleteByFilter` is expected to have the following structure:

| Path from `client.batch.hisDeleteByFilter` | Description                                                                            |  Type   | Default |
|--------------------------------------------|----------------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                                | Define the maximum size of each payload for `hisDeleteByFilter` operations.            | Number  |   100   |
| `batchDelay`                               | Define the time in between each batch `hisDeleteByFilter` request (ms).                | Number  |    0    |
| `parallel`                                 | Define the number of batched requests to be run in parallel                            | Number  |    1    |
| `parallelDelay`                            | Define the delay between each set of batched requests run in parallel (ms)             | Number  |    0    |
| `returnResult`                             | Enable the result from WideSky API server operation `hisDeleteByFilter` to be returned | Boolean | `false` |
| `filter`                                   | Define the maximum number of entities to be returned. 0 means no limit.                | Number  |    0    |

### Path `client.batch.updateOrCreate`
The Object in `client.batch.updateOrCreate` is expected to have the following structure:

| Path from `client.batch.updateOrCreate` | Description                                                                             |  Type   | Default |
|-----------------------------------------|-----------------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                             | Define the maximum size of each payload for `update` or `create` operations.            | Number  |  2000   |
| `batchDelay`                            | Define the time in between each batch `update` or `reate` request (ms).                 | Number  |    0    |
| `parallel`                              | Define the number of batched requests to be run in parallel                             | Number  |    1    |
| `parallelDelay`                         | Define the delay between each set of batched requests run in parallel (ms)              | Number  |    0    |
| `returnResult`                          | Enable the result from WideSky API server operation `update` or `create` to be returned | Boolean | `true`  |

### Path `client.batch.multiFind`
The Object in `client.batch.multiFind` is expected to have the following structure:

| Path from `client.batch.multiFind` | Description                                                                |  Type  | Default |
|------------------------------------|----------------------------------------------------------------------------|:------:|:-------:|
| `batchSize`                        | Define the maximum size of each payload for `multiFind` operations.        | Number |  2000   |
| `batchDelay`                       | Define the time in between each batch `multiFind` request (ms).            | Number |    0    |
| `parallel`                         | Define the number of batched requests to be run in parallel                | Number |    1    |
| `parallelDelay`                    | Define the delay between each set of batched requests run in parallel (ms) | Number |    0    |
| `filter`                           | Define the maximum number of entities to be returned. 0 means no limit.    | Number |    0    |
