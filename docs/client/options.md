# Table of Contents
<!-- toc -->

- [Table of Contents](#table-of-contents)
  - [Client Options](#client-options)
    - [Path `client`](#path-client)
    - [Path `client.progress`](#path-clientprogress)
    - [Path `client.performOpInBatch`](#path-clientperformopinbatch)
    - [Path `http`](#path-http)
    - [Path `http2`](#path-http2)

<!-- tocstop -->

## Client Options
The argument `options` is expected to have the following structure:

| Path     | Description                                                                                                                                                                                          |  Type  |              Default              |
|----------|------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|:------:|:---------------------------------:|
| `axios`  | Axios client configurations as per [Axios documentation](https://axios-http.com/docs/config_defaults).                                                                                               | Object | As defined by the `axios` library |
| `http`   | Node HTTP agent configurations as per [Node.js 16.x documentation](https://nodejs.org/docs/latest-v16.x/api/http.html#new-agentoptions). This is used for HTTP(S) agents passed to the Axios client. | Object |               `{}`                |
| `http2`  | HTTP 2 configurations as documented below.                                                                                                                                                           | Object |                                   |
| `client` | Object for defining `WideSkyClient` configurations.                                                                                                                                                  | Object |                                   |

### Path `client`
The Object defined in `client` is expected to have the following structure:

| Path from `client` | Description                                                                                        |  Type  | Default |
| ------------------ | -------------------------------------------------------------------------------------------------- | :----: | :-----: |
| `impersonateAs`    | A WideSky user **UUID**, or an account email, to impersonate requests as. Strings without `@` are validated as RFC 4122 UUIDs at construction (`TypeError` on miss). Empty / whitespace-only strings are rejected at construction. If an email is supplied, the lookup is deferred and runs as part of the first authenticated request (failure surfaces at that request, the email is retained so the next request retries, no result is cached across client instances). `unsetImpersonate()` and `impersonateAs(null)` both cancel a pending lookup. | String | `null`  |
| `progress`         | An Object defining live progress report configurations. Not used if `progress.enabled` is `false`. | Object | `false` |
| `performOpInBatch` | An Object defining default configurations for the function `performOpInBatch`                      | Object |         |
| `batch`            | An Object defining default configurations for various batch functions.                             | Object |         |

### Path `client.progress`
The Object defined in `client.progress` is expected to have the following structure:

| Path from `client.progress` | Description                                                                |  Type   | Default                                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------- | :-----: | :--------------------------------------------------------------------------------------------------------------------------------- |
| `enable`                    | Enable progress reporting to the command interface.                        | Boolean | `false`                                                                                                                            |
| `instance`                  | Define the class instance to do progress reports.                          | Object  | `cliProgress.MultiBar({clearOnComplete: false, hideCursor: true}, cliProgress.Presets.shades_classic)` from package `cli-progress` |
| `increment`                 | A string that defines an increment function on `client.progress.instance`. | String  | "increment"                                                                                                                        |
| `create`                    | A string that defines a create function on `client.progress.instance`.     | String  | "create"                                                                                                                           |
| `update`                    | A string that defines a update function on `client.progress.instance`.     | String  | "update"                                                                                                                           |

Batch operations count requests: each creates one counter whose total is its number of requests, increments it as each
request completes, then stops it and calls `remove` on `client.progress.instance` when it has one. `update` is not used
by the batch operations. A `progress` reporter given in the options of a batch call is used instead of this one; see
[Progress and logging](batch.md#progress-and-logging).

### Path `client.performOpInBatch`
The Object defined in `client.performOpInBatch` is expected to have the following structure:

| Path from `client.performOpInBatch` | Description                                                                |  Type   | Default |
| ----------------------------------- | -------------------------------------------------------------------------- | :-----: | :-----: |
| `batchSize`                         | Define the maximum size of each payload for an operation.                  | Number  |   100   |
| `batchDelay`                        | Define the time in between each batch request (ms).                        | Number  |    0    |
| `parallel`                          | Define the number of batched requests to be run in parallel                | Number  |    1    |
| `parallelDelay`                     | Define the delay between each set of batched requests run in parallel (ms) | Number  |    0    |
| `returnResult`                      | Enable the result from WideSky API server operation to be returned         | Boolean | `false` |
| `retries`                           | Define how many times a request is retried after a transient failure (HTTP 500, 502, 503, 504 or a network error). `0` disables retrying. Between 0 and 10. A retried `create` can create its entities twice if the first attempt succeeded but its response was lost. See [Retries](batch.md#retries). | Number  |    0    |
| `retryDelay`                        | Define the time to wait before each retry (ms). `0` means no delay.        | Number  |  2000   |


### Path `http`

Uses the standard Node.js [http.Agent](https://nodejs.org/docs/latest-v16.x/api/http.html#new-agentoptions) 
options to configure HTTP request behavior.

### Path `http2`
The Object defined in `http2` is expected to have the following structure:

| Path from `http2`  | Description                                                                                                                                                                                                                                          |  Type   | Default |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-----: | :-----: |
| `enabled`          | Enables `http2` as a transport protocol. The server must support HTTP/2; otherwise, it will fall back to HTTP/1.1.                                                                                                                                   | Boolean | `false` |
| `requestTimeout`   | Maximum time in milliseconds to wait for an HTTP/2 request to complete. Guards against unexpected hangs during connection establishment or unresponsive servers. Set to `0` to disable. Only applies when `enabled` is `true`. | Number  | `60000` |

