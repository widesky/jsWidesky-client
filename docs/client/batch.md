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
  - [Retries](#retries)

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

Every batch operation accepts `retries` and `retryDelay`, in its client configuration or in the options of the call.
See [Retries](#retries).

### Path `client.batch.hisRead`
The Object in `client.batch.hisRead` is expected to have the following structure:

| Path from `client.batch.hisRead` | Description                                                                  |  Type   | Default |
|----------------------------------|------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                      | Define the maximum size of each payload for `hisRead` operations.            | Number  |   100   |
| `batchDelay`                     | Define the time in between each batch `hisRead` request (ms).                | Number  |    0    |
| `parallel`                       | Define the number of batched requests to be run in parallel                  | Number  |    1    |
| `parallelDelay`                  | Define the delay between each set of batched requests run in parallel (ms)   | Number  |    0    |
| `retries`                        | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                     | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |

### Path `client.batch.hisWrite`
The Object in `client.batch.hisWrite` is expected to have the following structure:

| Path from `client.batch.hisWrite` | Description                                                                   |  Type   | Default |
|-----------------------------------|-------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                       | Define the maximum number of rows of each payload for `hisWrite` operations.  | Number  |  10000  |
| `batchSizeEntity`                 | Define the maximum number of entities per `hisWrite` request. Maximum 1000.   | Number  |   100   |
| `batchDelay`                      | Define the time in between each batch `hisWrite` request (ms).                | Number  |    0    |
| `parallel`                        | Define the number of batched requests to be run in parallel                   | Number  |    1    |
| `parallelDelay`                   | Define the delay between each set of batched requests run in parallel (ms)    | Number  |    0    |
| `retries`                         | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                      | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |
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
| `batchSize`                        | Define the maximum number of rows to be deleted in a single `hisDelete` request, across all its entities. Between 1 and 3000.                                                         | Number  |              500               |
| `batchSizeEntity`                  | Define the maximum number of entities in a single `hisDelete` request. Between 1 and 1000.                                                                              | Number  |               10               |
| `maxBisectDepth`                   | Define how many times a request rejected for exceeding the record limit may be halved and retried. `0` reports the request as an error instead. Between 0 and 10.       | Number  |               5                |
| `countBucketUnits`                 | Define the time units used to count rows, from coarsest to finest. Must be a non-empty list of GraphQL `duration` values, coarse to fine, without duplicates.           |  Array  | `["DAY", "HOUR", "MINUTE"]`    |
| `retries`                          | Define how many times a request is retried after a retryable failure (see below). `0` disables retrying. Between 0 and 10.                                              | Number  |               0                |
| `retryDelay`                       | Define the time to wait before each retry (ms). `0` means no delay.                                                                                                     | Number  |              2000              |
| `batchDelay`                       | Define the time in between each batch `hisDelete` request (ms).                                                                                                         | Number  |               0                |
| `parallel`                         | Define the number of batched requests to be run in parallel                                                                                                             | Number  |               1                |
| `parallelDelay`                    | Define the delay between each set of batched requests run in parallel (ms)                                                                                              | Number  |               0                |
| `returnResult`                     | Enable the result from WideSky API server operation `hisDelete` to be returned                                                                                          | Boolean |            `false`              |

Older versions defaulted `batchSize` to 1500 and `batchSizeEntity` to 100. The defaults are now 500 and 10, so a caller
that relied on the old defaults will send more, smaller requests.

At debug level the client logs every resolved option once per call, together with whether its value came from the call,
the client configuration or the default. A call option of `null` counts as not supplied.

#### How the range is planned
Every request holds at most `batchSize` rows in total, across at most `batchSizeEntity` entities. Ids are split into
groups of `batchSizeEntity` (or of `batchSize`, if that is smaller, because entities often log at the same instants
and rows that share an instant cannot be split by time), in the order given, and each group is planned on its own.
Every group is planned (its row counts requested) before any delete is sent. A range, or a group, that cannot be cut
into requests within `batchSize` is not sent at all: it is reported in `errors` as `"plan"` and its rows are kept.

1. Only these range forms are planned, because every request of a split plan must use one form the server accepts:
   - two datetimes ending in `Z` (or `Z UTC`), e.g. `2026-06-01T00:00:00Z,2026-06-04T00:00:00Z`;
   - two datetimes with an offset and the same timezone name, e.g.
     `2026-06-01T00:00:00+10:00 Brisbane,2026-06-04T00:00:00+10:00 Brisbane`;
   - two dates, e.g. `2026-06-01,2026-06-03`, or one date, e.g. `2026-06-01`;
   - `today` or `yesterday`, which become that date in each point's timezone, taken when the call starts.

   Datetimes must include seconds (`T00:00:00`, not `T00:00`), as the server requires.

   Any other range is not sent: a single datetime, a date paired with a datetime, a datetime without an offset or
   without seconds, an offset without a timezone name, two different timezone names, or a range that cannot be parsed.
   Also not sent: `Z` followed by a timezone name other than `UTC`, and `+00:00` followed by a timezone name where
   that timezone is not at UTC+0 at that time. The server reads both as local time in the named timezone, not as UTC.
2. The server is asked for row counts over the range, in buckets of the first unit in `countBucketUnits`. A bucket
   counts as the rows of all the entities in the group added together, since `batchSize` limits a whole request.
3. Any bucket above `batchSize` is counted again in the next finer unit. A bucket still above `batchSize` at the finest
   unit is halved, and the first half counted exactly (the second holds the rest), until every piece fits.
4. Buckets are packed oldest first into requests of at most `batchSize` rows in total across their entities.
5. The requests are contiguous and together cover the whole range, so rows written while the delete is running still
   fall inside a request.
6. When the plan needs only one request, that request sends the range exactly as you gave it (`today` and
   `yesterday` are sent as the planned datetimes, so the server cannot resolve them to another day). When it is
   split, every request uses the same form, and together they delete the same rows as a single `client.hisDelete` of
   your range. Some ranges cannot be split, because the server would misread the cuts; those are not sent (see
   "Ranges that are not sent" below):
   - `Z` datetimes: the first request keeps your start, the last keeps your end, and the cuts between them are `Z`
     datetimes;
   - datetimes with a timezone name: the first and last requests keep your start and end, and the cuts are datetimes in
     that timezone with the same name, e.g. `2026-06-02T12:00:00.000+10:00 Brisbane`;
   - dates: see below.
7. A group with no rows at all still gets one request for the whole range.
8. A request halved after a record-limit rejection is cut in the same form as the rest of its plan.

A date range is read by the server in each point's own timezone, so the client reads the group's points once and plans
each timezone separately. The server treats the dates as local midnight in the point's timezone: the start is midnight
at the start of the first date and the end is midnight at the start of the day after the last date. The client plans
over those same instants. When a split is needed, both ends and every cut are written as datetimes followed by the
point's timezone name, in one of two forms:
- For a timezone whose UTC offset is a whole number of hours, the datetime carries the real offset, e.g.
  `2026-06-01,2026-06-03` for a Brisbane point becomes `2026-06-01T00:00:00.000+10:00 Brisbane` to
  `2026-06-04T00:00:00.000+10:00 Brisbane`.
- For a timezone whose offset has minutes at any time in the range (for example Adelaide, Darwin, Kolkata or
  Kathmandu), the datetime is local time followed by `+00:00` and the name, e.g. `2026-06-01T00:00:00.000+00:00 Adelaide`
  to `2026-06-04T00:00:00.000+00:00 Adelaide`. The server misreads the minutes of an offset such as `+09:30`, but reads
  a `+00:00` offset with a timezone name as local time in that timezone, so this form deletes the intended rows. If the
  server's handling of either changes, this form must change with it.

Ranges that are not sent, beyond the forms in step 1:
- A range of datetimes with a timezone name, in a timezone with a part-hour offset at any time in the range (for example
  `2026-06-01T00:00:00+10:00 Adelaide,2026-06-04T00:00:00+10:00 Adelaide`, even though you wrote a whole-hour offset).
  The cuts would need the real `+09:30`, which the server misreads by about 29.5 hours.
- A date range or a timezone-name range whose window contains a UTC-offset change that is not a whole number of
  hours, such as Lord_Howe's 30-minute daylight saving change.
- A date range where an end of the window falls in the hour that repeats when daylight saving ends, in a zone that would
  be written with a `+00:00` offset.

- A date range (or `today` / `yesterday`) for a point with no timezone, or one the client cannot map to a known
  timezone.
- A group whose rows in the hour that repeats when daylight saving ends are more than `batchSize`, where cuts would
  be written with a `+00:00` offset. No cut is placed in that hour, because that local time names two instants.

#### Failures and retries
All planned requests are attempted. Failures do not stop the others; they are collected in `errors`, and requests that
succeeded are kept in `success` when `returnResult` is `true`. Each error has the form `{ error: String, args: Array }`,
and `args[0]` tells the kinds apart:

| `args[0]`      | Meaning                                                                                                             | `args`                        |
|----------------|---------------------------------------------------------------------------------------------------------------------|-------------------------------|
| `"hisDelete"`  | A delete request failed. Nothing further is done for that request.                                                  | `["hisDelete", ids, range]`   |
| `"countQuery"` | Counting (or reading timezones) for a group failed. The group is skipped and nothing is deleted for its entities.   | `["countQuery", ids, range]`  |
| `"plan"`       | The range, or the group, cannot be cut into requests within `batchSize`. Nothing is sent for those entities.        | `["plan", ids, range]`        |

Row counts and timezone reads are retried like delete requests, with the same `retries` and `retryDelay`. Only these
options apply: `client.performOpInBatch.retries` never adds attempts on top of them.

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
| `retries`                       | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                    | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |
| `returnResult`                  | Enable the result from WideSky API server operation `create` to be returned | Boolean | `false` |

### Path `client.batch.update`
The Object in `client.batch.update` is expected to have the following structure:

| Path from `client.batch.update` | Description                                                                 |  Type   | Default |
|---------------------------------|-----------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                     | Define the maximum size of each payload for `update` operations.            | Number  |  2000   |
| `batchDelay`                    | Define the time in between each batch `update` request (ms).                | Number  |    0    |
| `parallel`                      | Define the number of batched requests to be run in parallel                 | Number  |    1    |
| `parallelDelay`                 | Define the delay between each set of batched requests run in parallel (ms)  | Number  |    0    |
| `retries`                       | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                    | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |
| `returnResult`                  | Enable the result from WideSky API server operation `update` to be returned | Boolean | `false` |

### Path `client.batch.deleteById`
The Object in `client.batch.deleteById` is expected to have the following structure:

| Path from `client.batch.deleteById` | Description                                                                     |  Type   | Default |
|-------------------------------------|---------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                         | Define the maximum size of each payload for `deleteById` operations.            | Number  |   30    |
| `batchDelay`                        | Define the time in between each batch `deleteById` request (ms).                | Number  |    0    |
| `parallel`                          | Define the number of batched requests to be run in parallel                     | Number  |    1    |
| `parallelDelay`                     | Define the delay between each set of batched requests run in parallel (ms)      | Number  |    0    |
| `retries`                           | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                        | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |
| `returnResult`                      | Enable the result from WideSky API server operation `deleteById` to be returned | Boolean | `false` |

### Path `client.batch.deleteByFilter`
The Object in `client.batch.deleteByFilter` is expected to have the following structure:

| Path from `client.batch.deleteByFilter` | Description                                                                         |  Type   | Default |
|-----------------------------------------|-------------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                             | Define the maximum size of each payload for `deleteByFilter` operations.            | Number  |   30    |
| `batchDelay`                            | Define the time in between each batch `deleteByFilter` request (ms).                | Number  |    0    |
| `parallel`                              | Define the number of batched requests to be run in parallel                         | Number  |    1    |
| `parallelDelay`                         | Define the delay between each set of batched requests run in parallel (ms)          | Number  |    0    |
| `retries`                               | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                            | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |
| `returnResult`                          | Enable the result from WideSky API server operation `deleteByFilter` to be returned | Boolean | `false` |

### Path `client.batch.hisReadByFilter`
The Object in `client.batch.hisReadByFilter` is expected to have the following structure:

| Path from `client.batch.hisReadByFilter` | Description                                                                          |  Type   | Default |
|------------------------------------------|--------------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                              | Define the maximum size of each payload for `hisReadByFilter` operations.            | Number  |   100   |
| `batchDelay`                             | Define the time in between each batch `hisReadByFilter` request (ms).                | Number  |    0    |
| `parallel`                               | Define the number of batched requests to be run in parallel                          | Number  |    1    |
| `parallelDelay`                          | Define the delay between each set of batched requests run in parallel (ms)           | Number  |    0    |
| `retries`                                | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                             | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |
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
| `retries`                                    | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                                 | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |
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
| `retries`                               | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                            | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |
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
| `retries`                               | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                            | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |
| `returnResult`                          | Enable the result from WideSky API server operation `migrateHistory` to be returned | Boolean | `false` |

### Path `client.batch.hisDeleteByFilter`
`client.batch.hisDeleteByFilter(filter, start, end, options)` finds the entities matching `filter` and deletes their
history between two Dates with `client.batch.hisDelete`, planned as described above. `start` and `end` must be Dates.

Options not given in the call come from this path's client configuration, then from the defaults below.
`client.batch.hisDelete` client configuration does not apply on this path.

The Object in `client.batch.hisDeleteByFilter` is expected to have the following structure:

| Path from `client.batch.hisDeleteByFilter` | Description                                                                                                                  |  Type   |           Default           |
|--------------------------------------------|------------------------------------------------------------------------------------------------------------------------------|:-------:|:---------------------------:|
| `batchSize`                                | Define the maximum number of rows to be deleted in a single `hisDelete` request, across all its entities. Between 1 and 3000.              | Number  |             500             |
| `batchSizeEntity`                          | Define the maximum number of entities in a single `hisDelete` request. Between 1 and 1000.                                   | Number  |             10              |
| `maxBisectDepth`                           | As for `client.batch.hisDelete`.                                                                                             | Number  |              5              |
| `countBucketUnits`                         | As for `client.batch.hisDelete`.                                                                                             |  Array  | `["DAY", "HOUR", "MINUTE"]` |
| `retries`                                  | As for `client.batch.hisDelete`.                                                                                             | Number  |              0              |
| `retryDelay`                               | As for `client.batch.hisDelete`.                                                                                             | Number  |            2000             |
| `batchDelay`                               | Define the time in between each batch `hisDelete` request (ms).                                                              | Number  |              0              |
| `parallel`                                 | Define the number of batched requests to be run in parallel                                                                  | Number  |              1              |
| `parallelDelay`                            | Define the delay between each set of batched requests run in parallel (ms)                                                   | Number  |              0              |
| `returnResult`                             | Enable the result from WideSky API server operation `hisDelete` to be returned                                               | Boolean |           `false`           |
| `limit`                                    | Define the maximum number of entities to be returned by the filter. 0 means no limit.                                        | Number  |              0              |

### Path `client.batch.updateOrCreate`
The Object in `client.batch.updateOrCreate` is expected to have the following structure:

| Path from `client.batch.updateOrCreate` | Description                                                                             |  Type   | Default |
|-----------------------------------------|-----------------------------------------------------------------------------------------|:-------:|:-------:|
| `batchSize`                             | Define the maximum size of each payload for `update` or `create` operations.            | Number  |  2000   |
| `batchDelay`                            | Define the time in between each batch `update` or `reate` request (ms).                 | Number  |    0    |
| `parallel`                              | Define the number of batched requests to be run in parallel                             | Number  |    1    |
| `parallelDelay`                         | Define the delay between each set of batched requests run in parallel (ms)              | Number  |    0    |
| `retries`                               | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                            | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |
| `returnResult`                          | Enable the result from WideSky API server operation `update` or `create` to be returned | Boolean | `true`  |

### Path `client.batch.multiFind`
The Object in `client.batch.multiFind` is expected to have the following structure:

| Path from `client.batch.multiFind` | Description                                                                |  Type  | Default |
|------------------------------------|----------------------------------------------------------------------------|:------:|:-------:|
| `batchSize`                        | Define the maximum size of each payload for `multiFind` operations.        | Number |  2000   |
| `batchDelay`                       | Define the time in between each batch `multiFind` request (ms).            | Number |    0    |
| `parallel`                         | Define the number of batched requests to be run in parallel                | Number |    1    |
| `parallelDelay`                    | Define the delay between each set of batched requests run in parallel (ms) | Number |    0    |
| `retries`                          | Define how many times a request is retried after a transient failure (see [Retries](#retries)). `0` disables retrying. Between 0 and 10. | Number | 0 |
| `retryDelay`                       | Define the time to wait before each retry (ms). `0` means no delay. | Number | 2000 |
| `filter`                           | Define the maximum number of entities to be returned. 0 means no limit.    | Number |    0    |

### Retries
Each batch operation splits its payload into requests. With `retries` above `0`, a request that fails is sent again,
up to `retries` times, waiting `retryDelay` ms before each extra attempt, only for these failures:
- HTTP status 500, 502, 503 or 504.
- Network error codes `ENETDOWN`, `ENETUNREACH`, `ECONNABORTED`, `ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EHOSTDOWN`
  or `EHOSTUNREACH`.

Any other failure, including HTTP 429, other 4xx statuses and a per-entity record-limit error, is not retried. Only the
failed request is sent again; the other requests of the batch are not repeated. A request that still fails after its
retries is reported in `errors` exactly as it is without retries. The default `0` sends each request once.

A retried write can be applied twice: if the server applied a request but its response was lost (for example a reset
connection or a 504 from a proxy), the retry sends it again. That is harmless for reads and for `hisWrite`, `update`
and `deleteById`, but `create`, `addChildrenByFilter` and the create half of `updateOrCreate` can create the entities
again. Leave `retries` at `0` for them, or check for duplicates afterwards, if that matters.

The options are resolved per call like the others: the call options, then `client.batch.<operation>`, then the
defaults. `performOpInBatch` called directly also takes them, defaulting to `client.performOpInBatch`.
`batch.hisDelete` and `batch.hisDeleteByFilter` retry their own count queries, timezone reads and deletes (see
[Failures and retries](#failures-and-retries)).
