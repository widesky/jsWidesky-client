const {
    deriveFromDefaults,
    PERFORM_OP_IN_BATCH_SCHEMA,
    BATCH_HIS_WRITE_SCHEMA,
    BATCH_HIS_READ_SCHEMA,
    BATCH_HIS_DELETE_SCHEMA,
    BATCH_CREATE_SCHEMA,
    BATCH_UPDATE_SCHEMA,
    BATCH_DELETE_BY_ID_SCHEMA,
    BATCH_DELETE_BY_FILTER_SCHEMA,
    BATCH_HIS_READ_BY_FILTER_SCHEMA,
    BATCH_UPDATE_BY_FILTER_SCHEMA,
    BATCH_HIS_DELETE_BY_FILTER_SCHEMA,
    BATCH_MIGRATE_HISTORY_SCHEMA,
    BATCH_ADD_CHILDREN_BY_FILTER_SCHEMA,
    BATCH_MULTI_FIND_SCHEMA,
    BATCH_UPDATE_OR_CREATE_SCHEMA
} = require("../../utils/evaluator");
const lodash = require("lodash");
const {
    parseRange, groupByZone, windowFor, buildCountQuery, parseCountResponse, planGroup, splitRequest
} = require("./hisDeletePlan");
const { withRetry, isRecordLimitError } = require("./batchRetry");
const HisWritePayload = require("../../utils/hisWritePayload");
const { sleep } = require("../../utils/tools");
const Hs = require("../../utils/haystack");
const EntityCriteria = require("../../utils/EntityCriteria");

const ID_TAGS = ["id", "fqname"];
const VIRTUAL_TAGS = ["lastHisTime", "lastHisVal", "curVal", "curStatus", "curErr"];

/**
 * Initialise a 2D empty array.
 * @param size Size of the 2D array.
 * @returns {*[]}
 */
function init2DArray(size) {
    const arr = [];
    for (let i = 0; i < size; i++) {
        arr.push([]);
    }

    return arr;
}

/**
 * Determine if the time series rows given is already sorted in ascending order.
 * @param rows Time series rows.
 * @returns {boolean} True if already sorted, false otherwise.
 */
function isRowsSorted(rows) {
    let before;
    for (const {ts} of rows) {
        const epoch = Date.parse(Hs.removePrefix(ts));
        if (before === undefined) {
            before = epoch;
        }

        if (epoch < before) {
            return false;
        }
    }

    return true;
}

/**
 * Create an iterator Object for the given payload.
 * @param op Operation to be performed. Only relevant for op "hisDelete".
 * @param payload Payload to be batched.
 * @param clientArgs Arguments to be grouped with the batched payload.
 * @param batchSize Maximum size of each batch. For Objects, it's the number of key-value pairs found in the Object
 *                  of each attribute specified in the Object. For Arrays, its number of elements.
 * @param transformer A transformer for the batched arguments.
 * @returns {{count: number, hasMore: (function(): boolean), getNext}} count is the number of
 *     requests the payload makes.
 */
function createBatchIterator(op, payload, clientArgs, batchSize, transformer, batchSizeEntity) {
    let hasMore, getNext, count;
    if (Array.isArray(payload)) {
        count = Math.ceil(payload.length / batchSize);
        getNext = () => {
            const next = payload.splice(0, batchSize);
            if (op === "hisDelete") {
                // special case due to the arguments required
                return {
                    next: transformer(next),
                    size: next.length
                };
            } else {
                return {
                    next: [transformer(next), ...clientArgs],
                    size: next.length
                };
            }
        };
        hasMore = () => payload.length > 0;
    } else if (typeof payload === "object") {
        // check if structure is as expected
        for (const [key, valueAsObject] of Object.entries(payload)) {
            if (typeof payload !== "object") {
                throw new Error("Object payload structure for batch operation is malformed");
            }
        }

        const entityCap = (batchSizeEntity == null) ? Infinity : batchSizeEntity;
        const payloadKeys = Object.keys(payload);
        const keyValueLength = payloadKeys.map((key) => Object.keys(payload[key]).length);
        const keyValueRemaining = [...keyValueLength];
        let currKeyIndex = 0;
        count = countObjectRequests(keyValueLength, batchSize, entityCap);
        getNext = () => {
            // get next set using batchSize as maximum number of rows, not inclusive of the key,
            // and batchSizeEntity as maximum number of distinct top-level keys in the batch.
            const next = {};
            let totalRows = 0;
            let entityCount = 0;
            while (
                totalRows < batchSize &&
                entityCount < entityCap &&
                currKeyIndex < payloadKeys.length
            ) {
                if (keyValueRemaining[currKeyIndex] === 0) {
                    // all data fetched from here
                    currKeyIndex++;
                    continue;
                }

                const currKey = payloadKeys[currKeyIndex];
                const currKeyEntries = Object.entries(payload[currKey]);
                const keyRemaining = keyValueRemaining[currKeyIndex];
                const keyMax = keyValueLength[currKeyIndex]
                const keyValueStartFrom = keyMax - keyRemaining;
                if (currKeyEntries.length > (batchSize - totalRows) || keyValueStartFrom !== Object.keys(payload[currKey]).length) {
                    // take part of the set that doesn't exceed the current batch size
                    const isNewEntity = next[currKey] === undefined;
                    if (isNewEntity) {
                        next[currKey] = {};
                        entityCount++;
                    }

                    let taken = 0;
                    const partTake = batchSize - totalRows;
                    for (let i = keyValueStartFrom; i - keyValueStartFrom < partTake && i < keyMax; i++) {
                        next[currKey][currKeyEntries[i][0]] = currKeyEntries[i][1];
                        taken++;
                    }
                    keyValueRemaining[currKeyIndex] -= taken;
                    totalRows += taken;
                } else {
                    next[currKey] = payload[currKey];
                    keyValueRemaining[currKeyIndex] = 0;
                    totalRows += currKeyEntries.length;
                    entityCount++;
                    currKeyIndex++;
                }
            }

            return {
                next: [transformer(next), ...clientArgs],
                size: totalRows
            };
        }
        hasMore = () => {
            // skip over empty data sets
            while (currKeyIndex < payloadKeys.length && keyValueRemaining[currKeyIndex] === 0) {
                currKeyIndex++;
            }
            return currKeyIndex !== payloadKeys.length && keyValueLength[currKeyIndex] !== 0
        };
    } else {
        throw new Error("First element of parameter should be of type Array or Object");
    }

    return { hasMore, getNext, count };
}

/**
 * The number of requests an Object payload makes, worked out from its row counts alone so that
 * nothing is copied: the same packing as createBatchIterator's getNext.
 * @param {number[]} lengths Rows under each top-level key, in key order.
 * @param {number} batchSize Most rows in one request.
 * @param {number} entityCap Most top-level keys in one request.
 * @returns {number} The number of requests.
 */
function countObjectRequests(lengths, batchSize, entityCap) {
    const remaining = [...lengths];
    let index = 0;
    let requests = 0;
    const skipEmpty = () => {
        while (index < remaining.length && remaining[index] === 0) index++;
    };
    skipEmpty();
    while (index < remaining.length) {
        let rows = 0;
        let entities = 0;
        while (rows < batchSize && entities < entityCap && index < remaining.length) {
            if (remaining[index] === 0) {
                index++;
                continue;
            }
            const taken = Math.min(remaining[index], batchSize - rows);
            remaining[index] -= taken;
            rows += taken;
            entities++;
            if (remaining[index] === 0) index++;
        }
        requests++;
        skipEmpty();
    }
    return requests;
}

/**
 * Track the requests of one batch operation: log each as it completes, advance the progress
 * counter, and log a summary when the operation ends.
 * @param {string} label Operation name used in the log lines, e.g. "hisWrite".
 * @param {number} total Requests the operation makes.
 * @param {Object} [progress] Per-call progress reporter (cli-progress MultiBar interface, e.g.
 *     RequestProgress); the client-wide `progress` configuration is used when absent.
 * @param {Object} [payload] Details given to the counter when it is created.
 * @param {string} unit What a request's size counts, for the log lines.
 * @returns {{complete: function(Object): void, finish: function(): void}}
 */
function createRequestTracker(label, total, progress, payload, unit) {
    const logger = this.logger;
    let reporter = null;
    if (progress && typeof progress.create === "function") {
        reporter = { instance: progress, create: "create", increment: "increment" };
    } else if (this.isProgressEnabled) {
        const { instance, create, increment } = this.clientOptions.progress;
        reporter = { instance, create, increment };
    }
    const bar = reporter ? reporter.instance[reporter.create](total, 0, { ...payload }) : null;
    const started = Date.now();
    let done = 0;
    let failed = 0;
    let size = 0;

    return {
        /**
         * Record a completed request.
         * @param {{ok: boolean, error?: string, size: number, retries: number, durationMs: number}} outcome
         */
        complete(outcome) {
            done++;
            size += outcome.size || 0;
            if (!outcome.ok) failed++;
            if (logger) {
                const retries = outcome.retries === 1 ? "1 retry" : `${outcome.retries} retries`;
                if (outcome.ok) {
                    logger.debug("batch.%s: request %d/%d ok in %d ms, %s, %d %s",
                        label, done, total, outcome.durationMs, retries, outcome.size, unit);
                } else {
                    logger.debug("batch.%s: request %d/%d failed in %d ms, %s: %s",
                        label, done, total, outcome.durationMs, retries, outcome.error);
                }
            }
            if (bar) {
                bar[reporter.increment](1, {
                    ok: outcome.ok,
                    error: outcome.error,
                    size: outcome.size,
                    sizeDone: size,
                    retries: outcome.retries,
                    durationMs: outcome.durationMs,
                    failed
                });
            }
        },
        /**
         * Log the summary and release the progress counter.
         */
        finish() {
            if (logger) {
                logger.info("batch.%s: %d/%d requests done (%d failed), %d %s in %d ms",
                    label, done, total, failed, size, unit, Date.now() - started);
            }
            if (bar) {
                if (typeof bar.stop === "function") bar.stop();
                if (typeof reporter.instance.remove === "function") reporter.instance.remove(bar);
            }
        }
    };
}

/**
 * Send one batched request, retrying it after a transient failure.
 * @param {string} op Client function to be performed.
 * @param {Array} args Arguments to be called for the client operation.
 * @param {{retries: number, retryDelay: number}} retry Extra attempts after a transient failure (see
 *     batchRetry.withRetry) and the milliseconds before each. Only the final failure is reported.
 * @param {number} size Items in the request.
 * @param {Object} tracker The operation's request tracker (see createRequestTracker).
 * @param {function(*): Object} [describe] Maps a response to outcome fields that override the
 *     defaults, for an op that records its own failures (batch.hisDelete).
 * @returns {Promise<{res: *}|{error: {error: string, args: Array}}>} The response, or the error entry to report.
 *     Never rejects, so the caller can record outcomes in request order once a parallel group settles.
 */
async function createBatchRequest(op, args, retry, size, tracker, describe) {
    const started = Date.now();
    let retries = 0;
    const onRetry = () => {
        retries++;
    };
    try {
        const res = await withRetry(() => this[op](...args), { ...retry, onRetry });
        tracker.complete({
            ok: true, size, retries, durationMs: Date.now() - started, ...(describe ? describe(res) : {})
        });
        return { res };
    } catch (error) {
        tracker.complete({ ok: false, error: error.message, size, retries, durationMs: Date.now() - started });
        return { error: { error: error.message, args: [op, ...args] } };
    }
}

/**
 * Perform a WideSky client operation in batches or in parallel.
 * @param {string} op Function to be called on the client instance.
 * @param {Array} args An Array of arguments to be passed to the client. The first index must be the batch'able payload.
 * @param {Object} [options] An Object of options available to configure the operation. These include:
 *                - batchSize: Size of each batch sent to API server. For a payload of type Object, this is the \
 *                             number of keys.
 *                - batchDelay: Delay in milliseconds between the completion of a request and the next request to be
 *                              made.
 *                - parallel: Number of batched requests to run in parallel.
 *                - parallelDelay: Delay in milliseconds between each set of parallel requests.
 *                - returnResult: Enable or disable returning the result of the queries sent.
 *                - retries: Extra attempts for a request after a transient failure (5xx in 500/502/503/504 or a
 *                           network error). 0 (default) disables retry.
 *                - retryDelay: Delay in milliseconds before each extra attempt.
 *                - transformer: A function to transform the payload to be passed to the client operation.
 *                - progress: A progress reporter for this call (cli-progress MultiBar interface, e.g.
 *                            RequestProgress). Its counter counts requests, advances as each completes and
 *                            is removed when the operation ends. Defaults to the client-wide `progress`.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: Contain the responses of successful operations when options.returnResult is true.
 *          - errors: Contain an errors encountered when performing operations.
 */
async function performOpInBatch(op, args, options={}) {
    // evaluate options
    await PERFORM_OP_IN_BATCH_SCHEMA.validate(options);
    const {
        batchSize,
        batchSizeEntity,
        batchDelay,
        returnResult,
        parallel,
        parallelDelay,
        retries,
        retryDelay
    } = deriveFromDefaults(this.clientOptions.performOpInBatch, options);

    let { transformer } = options;
    // label, unit, describe and progressPayload are internal: set by batch functions that wrap
    // their own request runner (batch.hisDelete).
    const { progress, describe, progressPayload } = options;
    const label = options.label || op;
    const unit = options.unit || "items";
    if (transformer == null) {
        // no transformation
        transformer = (val) => val;
    }

    // Evaluate given args to be batched
    if (!Array.isArray(args) || args.length === 0) {
        throw new Error("args parameter must be an array consisting of at least the payload to be batched");
    }
    const payload = args[0];
    const clientArgs = args.slice(1);
    const result = {
        errors: [],
        success: []
    };
    const { getNext, hasMore, count } = createBatchIterator.call(
        this, op, payload, clientArgs, batchSize, transformer, batchSizeEntity
    );
    if (!hasMore()) {
        return result;
    }

    const tracker = createRequestTracker.call(this, label, count, progress, progressPayload, unit);
    try {
        while (hasMore()) {
            const requests = [];

            // queue parallel requests
            for (let i = 0; i < parallel && hasMore(); i++) {
                const { next, size } = getNext();
                requests.push(createBatchRequest.call(
                    this, op, next, { retries, retryDelay }, size, tracker, describe
                ));
                if (batchDelay > 0) {
                    await sleep(batchDelay);
                }
            }
            // Record in request order, not completion order: a retried request finishes after its peers,
            // and hisRead / multiFind read success by position.
            for (const outcome of await Promise.all(requests)) {
                if (outcome.error) {
                    result.errors.push(outcome.error);
                } else if (returnResult) {
                    result.success.push(outcome.res);
                }
            }

            if (parallelDelay > 0)  {
                await sleep(parallelDelay);
            }
        }
    } finally {
        tracker.finish();
    }

    return result;
}

/**
 * Perform a hisWrite operation using batch functionality.
 * @param hisWriteData HisWrite data to be sent. Can be the raw hisWrite payload or an instance of HisWritePayload.
 * @param options An Object defining batch configurations to be used. See README.md for more information.
 *                Option batchSize is determined by the maximum number of time series rows to be sent. The rows are
 *                defined as the time series for each entity.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: Contain the responses of successful operations of hisWrite when options.returnResult is true.
 *          - errors: Contain an errors encountered when performing operations.
 */
async function hisWrite(hisWriteData, options={}) {
    if (!["Object", "HisWritePayload"].includes(hisWriteData.constructor.name)) {
        throw new Error("parameter hisWriteData must be of type Object");
    }

    let data, size;
    if (hisWriteData instanceof HisWritePayload) {
        data = hisWriteData.payload;
        size = hisWriteData.size;
    } else {
        data = hisWriteData;
        size = HisWritePayload.calculateSize(hisWriteData);
    }
    if (size === 0) {
        throw new Error("Nothing to hisWrite");
    }

    await BATCH_HIS_WRITE_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.hisWrite, options);

    return this.performOpInBatch(
        "hisWrite",
        [data],
        options
    );
}

/**
 * The position, within its request, of the point a hisRead response column holds.
 * @param {string} name Column name from the response row (not "ts").
 * @param {number} requested Number of points in the request.
 * @returns {number|null} The point's position in the request, or null when the column matches none of them.
 *     The API server names the value column "val" when one point is read and "v0".."vN" for several.
 */
function hisReadColumn(name, requested) {
    if (name === "val") {
        return requested === 1 ? 0 : null;
    }
    const match = /^v(\d+)$/.exec(name);
    if (match === null) {
        return null;
    }
    const position = Number(match[1]);
    return position < requested ? position : null;
}

/**
 * Perform a history read request using batch functionality.
 * @param   ids Entities to read.
 * @param   from Haystack read range or a Date Object representing where to grab historical data from.
 * @param   to  Date Object representing where to grab historical data to (not inclusive).
 * @param   options An Object defining batch configurations to be used. See README.md for more information.
 *                  Option batchSize is determined by the number of ids to perform a hisRead for.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: A 2D array of time series data in the order of ids queried.
 *          - errors: Contain an errors encountered when performing operations.
 */
async function hisRead(ids, from, to, options={}) {
    await BATCH_HIS_READ_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.hisRead, options);

    const {
        success: data,
        errors
    } = await this.performOpInBatch(
        "hisRead",
        [[...ids], from, to, options.batchSize],
        {
            ...options,
            returnResult: true
        }
    );

    // process hisRead data. Requests cover consecutive slices of ids, and success / errors are both
    // in request order, so walking the slices places each response on its own ids: a failed slice
    // keeps its ids empty, and a value column ("val" for one point, "vN" for several) is relative to
    // the slice it came from.
    const resultByEntity = init2DArray(ids.length);
    // Request errors plus any response that cannot be mapped, in request order.
    const orderedErrors = [];
    let nextSuccess = 0;
    let nextError = 0;
    for (let start = 0; start < ids.length; start += options.batchSize) {
        const slice = ids.slice(start, start + options.batchSize);
        const failed = errors[nextError];
        if (failed && lodash.isEqual(failed.args[1], slice)) {
            orderedErrors.push(failed);
            nextError++;
            continue;
        }
        const res = data[nextSuccess++];
        if (res === undefined) {
            break;
        }
        if (ids.length === 1 || options.batchSize === 1) {
            resultByEntity[start] = res.rows;
        } else {
            if (!isRowsSorted(res.rows)) {
                // issues found with rows not being sorted by their respective time stamp
                // when doing multi hisRead. Not a common use scenario but this an expectation for all
                // function that use WideSkyClient.batch.hisRead
                res.rows.sort((rowA, rowB) => {
                    const timeA = Date.parse(Hs.removePrefix(rowA.ts));
                    const timeB = Date.parse(Hs.removePrefix(rowB.ts));

                    if (timeA > timeB) {
                        return 1;
                    } else if (timeA < timeB) {
                        return -1;
                    } else {
                        return 0;
                    }
                });
            }

            const unmapped = new Set();
            for (const row of res.rows) {
                for (const name of Object.keys(row)) {
                    if (name !== "ts" && hisReadColumn(name, slice.length) === null) {
                        unmapped.add(name);
                    }
                }
            }
            if (unmapped.size > 0) {
                // Never drop rows silently: the slice is reported and its points keep no rows.
                orderedErrors.push({
                    error: `hisRead response has column(s) ${[...unmapped].join(", ")} matching none of the ` +
                        `${slice.length} requested point(s)`,
                    args: ["hisRead", slice, from, to, options.batchSize]
                });
                continue;
            }

            for (const row of res.rows) {
                const { ts } = row;
                for (const [name, val] of Object.entries(row)) {
                    if (name !== "ts") {
                        resultByEntity[start + hisReadColumn(name, slice.length)].push({ts, val});
                    }
                }
            }
        }
    }

    return {
        success: resultByEntity,
        errors: orderedErrors
    };
}

const HIS_DELETE_OPTION_KEYS = [
    "batchSize", "batchSizeEntity", "maxBisectDepth", "countBucketUnits",
    "retries", "retryDelay", "parallel", "batchDelay", "parallelDelay"
];

/**
 * Split ids into consecutive groups of at most `size`, keeping their order.
 * @param {string[]} ids Point ids.
 * @param {number} size Largest group (batchSizeEntity).
 * @returns {string[][]}
 */
function chunkIds(ids, size) {
    const groups = [];
    for (let i = 0; i < ids.length; i += size) {
        groups.push(ids.slice(i, i + size));
    }
    return groups;
}

/**
 * Delete history in bounded requests planned from GraphQL COUNT histograms.
 *
 * Planning never reads the rows being deleted: each group of `batchSizeEntity` ids is counted
 * per `countBucketUnits[0]`, over-budget buckets are re-counted at finer units, and buckets are
 * packed into contiguous requests of at most `batchSize` rows in total, over at most
 * min(batchSizeEntity, batchSize) points. A bucket still over budget at the finest unit is halved
 * and re-counted exactly until it fits. A plan that needs one request sends the caller's range
 * verbatim ("today" / "yesterday" as the planned datetimes). A split plan keeps every request in
 * one range form the API server accepts (see hisDeletePlan.parseRange):
 *   - both ends "...Z": boundaries are ISO "Z" instants, first/last keep the caller's tokens;
 *   - both ends "<offset> <TzName>" with the same name: boundaries in that zone with that name;
 *   - both ends dates: each group is read once and split by point timezone; both ends become
 *     local-midnight datetimes with the point's tz name (end = the day after the end date),
 *     written with the real offset in a whole-hour zone, or as local wall time + "+00:00 <Name>"
 *     in a zone with a part-hour offset in the window (the server misreads "+09:30"; see
 *     hisDeletePlan.wallTimeForm).
 *   - "today" / "yesterday" and a single date plan like two dates, the keyword's date taken per
 *     point timezone when the call starts.
 * Any other range (one datetime, mixed forms, a missing offset, seconds or tz name, two tz names,
 * "Z <Name>" for a zone other than UTC, "+00:00 <Name>" while that zone is not at UTC+0), a date
 * range on a point with no usable tz, a named range in a zone with a part-hour offset, a date or
 * named range containing a sub-hour DST change, and a group whose rows in a repeated DST hour
 * exceed batchSize, is not sent: each such group gets a "plan" error and keeps its rows.
 *
 * @param {string|string[]} ids Point ids (array or single id).
 * @param {string|Date} range Haystack range string (with or without "s:"), or a Date for the start.
 * @param {Date|Object} [endOrOptions] Date end (not inclusive) when `range` is a Date; otherwise the
 *     options, with the keys listed under maybeOptions.
 * @param {Object} [maybeOptions] Options when called with two Dates. See docs/client/batch.md.
 * @param {number} [maybeOptions.batchSize=500] Most rows in one request, summed over its points.
 * @param {number} [maybeOptions.batchSizeEntity=10] Most point ids in one request.
 * @param {number} [maybeOptions.maxBisectDepth=5] Times a request the server rejects for its row
 *     limit may be halved.
 * @param {string[]} [maybeOptions.countBucketUnits=["DAY","HOUR","MINUTE"]] Histogram units, coarsest first.
 * @param {number} [maybeOptions.retries=0] Extra attempts after a transient failure.
 * @param {number} [maybeOptions.retryDelay=2000] Milliseconds before each extra attempt.
 * @param {number} [maybeOptions.parallel] Requests in flight at once.
 * @param {number} [maybeOptions.batchDelay] Milliseconds between requests.
 * @param {number} [maybeOptions.parallelDelay] Milliseconds between parallel starts.
 * @param {boolean} [maybeOptions.returnResult=false] Collect each delete response in `success`.
 * @returns {Promise<{success: Array, errors: Array<{error: String, args: Array}>}>}
 *          errors[].args[0] is "hisDelete" for a failed delete, "countQuery" for a failed
 *          count (the group is not deleted), and "plan" for a range or group that cannot be cut
 *          within batchSize (nothing is sent for it).
 */
async function hisDelete(ids, range, endOrOptions, maybeOptions) {
    let options;
    if (typeof range === "string") {
        options = endOrOptions || {};
    } else if (range instanceof Date && endOrOptions instanceof Date) {
        range = `s:${range.toISOString()},${endOrOptions.toISOString()}`;
        options = maybeOptions || {};
    } else {
        throw new Error("range must be a Haystack range string, or timeStart and timeEnd must both be Date objects");
    }
    ids = Array.isArray(ids) ? ids : [ids];
    if (ids.length === 0) {
        return { success: [], errors: [] };
    }

    // null means "not supplied": drop it so the configured/default value applies instead of
    // silently disabling bisection or retry.
    options = lodash.omitBy(options, lodash.isNull);
    await BATCH_HIS_DELETE_SCHEMA.validate(options);
    const configured = lodash.get(this.options, "client.batch.hisDelete") || {};
    const resolved = deriveFromDefaults(this.clientOptions.batch.hisDelete, { ...options });
    this.logger.debug("batch.hisDelete options: %s", HIS_DELETE_OPTION_KEYS.map((k) => {
        const source = options[k] !== undefined ? "call" : configured[k] !== undefined ? "client config" : "default";
        return `${k}=${JSON.stringify(resolved[k])} (${source})`;
    }).join(", "));

    const { batchSizeEntity, maxBisectDepth, retries, retryDelay, returnResult } = resolved;
    const parsed = parseRange(range);
    const success = [];
    const errors = [];
    const requests = [];
    // Relative ranges resolve against one "now" for the whole call.
    const nowMs = Date.now();
    // A range that cannot be cut into requests of at most batchSize rows is not sent at all.
    const notSent = (groupIds, reason) => {
        this.logger.warn("batch.hisDelete: not deleting %s over %s: %s", groupIds.join(","), range, reason);
        errors.push({ error: `not sent: ${reason}`, args: ["plan", groupIds, range] });
    };

    // At most batchSize points per request as well: points often log on the same instants, and
    // rows sharing one millisecond cannot be split by time.
    for (const group of chunkIds(ids, Math.min(batchSizeEntity, resolved.batchSize))) {
        if (!parsed.plannable) {
            notSent(group, `"${parsed.raw}" is not a range batch.hisDelete can split: use two dates, one date, ` +
                "today, yesterday, or two datetimes with seconds and the same timezone name");
            continue;
        }
        // Datetime ends carry their own timezone, so the whole group shares one window. Date-only
        // ends resolve in each point's timezone, so the group is read once and split by tz.
        let subGroups = [{ ids: group }];
        if (parsed.form === "date") {
            try {
                subGroups = await groupByZone((groupIds) => withRetry(() => this.read(groupIds), { retries, retryDelay }), group);
            } catch (error) {
                errors.push({ error: error.message, args: ["countQuery", group, range] });
                continue;
            }
        }
        for (const sub of subGroups) {
            const window = windowFor(parsed, sub, nowMs);
            if (window.unsplittable) {
                notSent(sub.ids, window.unsplittable);
                continue;
            }
            // Planning queries retry like deletes: a caller who sets retries expects planning to
            // ride out the same transient failures.
            const countFn = async (fromMs, toMs, unit) => parseCountResponse(
                await withRetry(() => this.query(buildCountQuery(sub.ids, fromMs, toMs, unit)), { retries, retryDelay }), unit);
            let plan;
            try {
                plan = await planGroup(countFn, sub.ids, parsed, window, resolved);
            } catch (error) {
                errors.push({ error: error.message, args: ["countQuery", sub.ids, range] });
                continue;
            }
            if (plan.overBudget) {
                notSent(sub.ids, plan.overBudget);
            } else {
                requests.push(...plan.requests);
            }
        }
    }

    // Resolves to the request's outcome for progress reporting: ok, the retries used (including
    // any bisected halves') and, on failure, the last error.
    const runRequest = async (req) => {
        let retriesUsed = 0;
        const onRetry = () => {
            retriesUsed++;
        };
        try {
            const res = await withRetry(() => this.hisDelete(req.ids, req.range), { retries, retryDelay, onRetry });
            if (returnResult) {
                success.push(res);
            }
            return { ok: true, retries: retriesUsed };
        } catch (error) {
            const halves = isRecordLimitError(error) && req.depth < maxBisectDepth ? splitRequest(req) : null;
            if (halves) {
                this.logger.warn("batch.hisDelete: record limit hit for %s; bisecting (depth %d/%d)",
                    req.range, req.depth + 1, maxBisectDepth);
                const outcome = { ok: true, retries: retriesUsed };
                for (const half of halves) {
                    const halfOutcome = await runRequest(half);
                    outcome.retries += halfOutcome.retries;
                    if (!halfOutcome.ok) {
                        outcome.ok = false;
                        outcome.error = halfOutcome.error;
                    }
                }
                return outcome;
            }
            errors.push({ error: error.message, args: ["hisDelete", req.ids, req.range] });
            return { ok: false, retries: retriesUsed, error: error.message };
        }
    };

    // The engine only paces and parallelises here; runRequest records its own results so that
    // bisected halves and original errors are kept, and retries on its own (retries: 0 keeps a
    // client-wide performOpInBatch.retries from retrying on top). The receiver is a stand-in so
    // the dispatch name never lands on the shared client instance.
    const runner = Object.create(this);
    runner.runHisDeleteRequest = async (req) => ({ ...(await runRequest(req)), size: req.rows || 0 });
    await this.performOpInBatch.call(runner, "runHisDeleteRequest", [[...requests]], {
        batchSize: 1,
        transformer: (batch) => batch[0],
        parallel: resolved.parallel,
        batchDelay: resolved.batchDelay,
        parallelDelay: resolved.parallelDelay,
        returnResult: false,
        retries: 0,
        progress: options.progress,
        label: "hisDelete",
        unit: "rows",
        progressPayload: { rowsTotal: requests.reduce((n, req) => n + (req.rows || 0), 0) },
        // runRequest records its own failures and retries; report them per request.
        describe: ({ ok, error, retries: retriesUsed, size }) => ({ ok, error, retries: retriesUsed, size })
    });

    return { success, errors };
}

/**
 * Perform a create request using batch functionality. The request are batched based on the number of entities given.
 * @param entities Entities to be created.
 * @param options An Object defining batch configurations to be used. See README.md for more information.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: Return the result of each successful create operation if options.returnResult is true.
 *          - errors: Return the errors encountered for each failed create operation.
 */
async function create(entities, options={}) {
    await BATCH_CREATE_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.create, options);
    return this.performOpInBatch("create", [[...entities]], options);
}

/**
 * Perform an update requesting using batch functionality. The request are batched based on the number of entities given.
 * @param entities Entities and their respective tags to be updated.
 * @param options An Object defining batch configuration to be used. See README.md for more information.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: Return the result of each successful update operation if options.returnResult is true.
 *          - errors: Return the errors encountered for each failed update operation.
 */
async function update(entities, options={}) {
    await BATCH_UPDATE_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.update, options);
    return this.performOpInBatch("update", [[...entities]], options);
}

/**
 * Perform a deleteById operation using batch functionality. The request are batched based on the number of entities
 * given.
 * @param ids The id of each entity to be deleted.
 * @param options An Object defining batch configurations to be used. See README.md for more information.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: Return the result of each successful update operation if options.returnResult is true.
 *          - errors: Return the errors encountered for each failed update operation.
 */
async function deleteById(ids, options={}) {
    await BATCH_DELETE_BY_ID_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.deleteById, options);

    return this.performOpInBatch("deleteById", [[...ids]], options);
}

/**
 * Perform a deleteByFilter operation using batch functionality. The request are batched based on the number of entities
 * retrieved from the given filter and limit. The batched payloads are passed to WideSkyClient.deleteById.
 * @param filter Filter to search for entities.
 * @param limit Limit to be imposed on the result of the given filter.
 * @param options An Object defining batch configurations to be used. See README.md for more information.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: Return the result of each successful deleteByID operation if options.returnResult is true.
 *          - errors: Return the errors encountered for each failed deleteById operation.
 */
async function deleteByFilter(filter, limit=0, options={}) {
    await BATCH_DELETE_BY_FILTER_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.deleteByFilter, options);

    try {
        return this.performOpInBatch(
            "deleteById",
            [
                await this.findAsId(filter, limit)
            ],
            options
        );
    } catch (error) {
        return {
            success: [],
            errors: [{
                error: error.message,
                args: ["findAsId", filter, limit]
            }]
        };
    }
}

/**
 * Perform a hisRead using a filter to select the entities with batch functionality.
 * @param filter Filter to search for entities.
 * @param from Haystack read range or a Date Object representing where to grab historical data from.
 * @param to  Date Object representing where to grab historical data to (not inclusive).
 * @param options An Object defining batch configurations to be used. See README.md for more information.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: Return the result of each successful hisRead operation if options.returnResult is true.
 *          - errors: Return the errors encountered for each failed hisRead operation.
 */
async function hisReadByFilter(filter, from, to, options={}) {
    await BATCH_HIS_READ_BY_FILTER_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.hisReadByFilter, options);
    const { limit } = options;

    try {
        return this.batch.hisRead(
            await this.findAsId(filter, limit),
            from,
            to,
            options
        );
    } catch (error) {
        return {
            success: [],
            errors: [{
                error: error.message,
                args: ["findAsId", filter, limit]
            }]
        };
    }
}

/**
 * Update the entities found in the filter by the given list of criteria using batch functionality.
 * @param filter Filter to search for entities.
 * @param criteriaList A list of EntityCriteria objects defining the criteria to match against.
 * @param options An Object defining batch configurations to be used. See README.md for more information.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: Return the result of each successful update operation if options.returnResult is true.
 *          - errors: Return the errors encountered for each failed update operation.
 */
async function updateByFilter(filter, criteriaList, options={}) {
    for (const criteria of criteriaList) {
        if (!(criteria instanceof EntityCriteria)) {
            throw new Error("Element of parameter 'criteriaList' is not of class EntityCriteria");
        }
    }

    await BATCH_UPDATE_BY_FILTER_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.updateByFilter, options);
    const { limit } = options;

    let entities;
    try {
        entities = await this.v2.find(filter, limit);
    } catch (error) {
        return {
            success: [],
            errors: [{
                error: error.message,
                args: ["v2.find", filter, limit]
            }]
        };
    }

    const updatePayload = [];
    for (const entity of entities) {
        const newEntity = {
            id: entity.id
        };
        for (const criteria of criteriaList) {
            if (criteria.isValid(entity)) {
                criteria.applyChanges(newEntity, entity);
            }
        }

        if (Object.keys(newEntity).length > 1) {
            updatePayload.push(newEntity);
        }
    }

    return this.performOpInBatch("update", [updatePayload], options);
}

/**
 * Perform a hisDelete using a filter to select the entities.
 * @param {string} filter Filter to select the entities to be hisDelete'd.
 * @param {Date} start Starting timestamp to be deleted.
 * @param {Date} end Ending timestamp to be deleted (not inclusive).
 * @param {Object} [options] Options for batch.hisDelete plus `limit` (see docs/client/batch.md). Options not given
 *                come from client config batch.hisDeleteByFilter, then its defaults; batch.hisDelete client
 *                config does not apply on this path. batchSize bounds the total rows per request.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: Return the result of each successful hisDelete operation when options.returnResult is true.
 *          - errors: Return any errors encountered when performing hisDelete operations.
 */
async function hisDeleteByFilter(filter, start, end, options={}) {
    // Only Dates, as before the planner: a range string belongs to batch.hisDelete.
    if (!(start instanceof Date) || !(end instanceof Date)) {
        throw new Error("parameter timeStart or timeEnd is not of type Date");
    }
    await BATCH_HIS_DELETE_BY_FILTER_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.hisDeleteByFilter, options);
    const { limit } = options;

    try {
        return this.batch.hisDelete(
            await this.findAsId(filter, limit),
            start,
            end,
            options
        );
    } catch (error) {
        return {
            success: [],
            errors: [{
                error: error.message,
                args: ["findAsId", filter, limit]
            }]
        };
    }
}

/**
 * Perform a historical data migration between fromEntity and toEntity using batch functionality.
 * @param fromEntity The entity to migrate data from as a UUID or fqname.
 * @param toEntity The entity to migrate data to as a UUID or fqname.
 * @param options An Object defining batch configurations to be used. See README.md for more information.
 *                Option batchSize is determined by the maximum number of time series rows to be sent. The rows are
 *                defined as the time series for each entity.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: Return the success hisWrite data that has been migrated to toEntity if options.returnResult
 *            is true.
 *          - errors: Return all errors encountered.
 */
async function migrateHistory(fromEntity, toEntity, options={}) {
    await BATCH_MIGRATE_HISTORY_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.migrateHistory, options);

    const from = new Date(0);
    const to = new Date(Date.now());
    const res = await this.batch.hisRead([fromEntity], from, to);
    if (res.errors.length) {
        return res;
    }

    const { success: [history], errors } = res;
    const data = new HisWritePayload();
    data.add(`r:${toEntity}`, history);

    return this.batch.hisWrite(data, options);
}

/**
 * Add the given children the parents found in the given filter.
 * @param filter Filter to define the parents.
 * @param children Children to be added to the found parents.
 * @param tagMap A 2D Array of tags to be copied from the parent (if present) to the child entities.
 *                Each element of the Array is an Array with elements as [tagOfParent, toTagOnChild].
 *                For example [["id", "equipRef"]].
 * @param options An Object defining batch configurations to be used. See README.md for more information.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: Return the result of the create operations performed when options.returnResult is true.
 *          - errors: Return an errors encountered from the create operations performed.
 */
async function addChildrenByFilter(filter, children, tagMap=[], options={}) {
    if (!Array.isArray(children) || children.filter((arr) => typeof arr !== "object").length) {
        throw new Error("parameter children is not an Array of Objects");
    } else if (children.length === 0) {
        throw new Error("parameter children is an empty Array");
    } else if (!Array.isArray(tagMap) || tagMap.filter((tags) => !Array.isArray(tags) || tags.length !== 2).length) {
        throw new Error("parameter refTags is not a 2D Array as specified");
    }

    await BATCH_ADD_CHILDREN_BY_FILTER_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.addChildrenByFilter, options);
    const { limit } = options;

    const parents = await this.v2.find(filter, limit);
    const createPayload = [];
    for (const parent of parents) {
        for (const child of JSON.parse(JSON.stringify(children))) {
            let added = false;
            for (const [tagOfParent, toTagOnChild] of tagMap) {
                if (parent[tagOfParent] !== undefined) {
                    added = true;
                    child[toTagOnChild] = parent[tagOfParent];
                }
            }

            if (added) {
                createPayload.push(child);
            }
        }
    }

    if (createPayload.length > 0) {
        return this.performOpInBatch(
            "create",
            [createPayload],
            options
        );
    }
}

/**
 * Create a read by filter using GraphQL
 * @param alias Filter alias name.
 * @param filter Read byu filter to be used.
 * @param limit Limit of entities to be searched.
 * @returns {string} GraphQL query.
 */
function getReadByFilterQuery(alias, filter, limit) {
    filter = filter.replaceAll('"', '\\"');
    return `
    ${alias}:search(filter: "${filter}", limit: ${limit}) {
      entity {
        tags {
          name
          value
          kindValue { __typename }
        }
      }
    }
    `
}

/**
 * Perform multi read-by-filter requests in a single request. The number of filters sent in a request is determined
 * by options.batchSize.
 * @param filterAndLimits A 2D Array defining the filter and limit of each read-by-filter to be queried.
 * @param options An Object defining batch configurations to be used. See README.md for more information.
 * @returns {Promise<{success: Array, errors: Array<{errors: String, args: Array}>}>}
 *          - success: A 2D Array of the result from each read-by-filter given.
 *          - errors: All errors encountered from performing read-by-filter operations.
 */
async function multiFind(filterAndLimits, options={}) {
    if (!Array.isArray(filterAndLimits) ||
            filterAndLimits.filter((fAndL) => !Array.isArray(fAndL) || fAndL.length === 0).length) {
        throw new Error("parameter filterAndLimits is not a 2D Array as specified");
    }

    await BATCH_MULTI_FIND_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.multiFind, options);
    const { limit } = options;

    // Build the GraphQL queries
    const queries = [];
    for (let i = 0; i < filterAndLimits.length; i++) {
        let [filter, limitFound] = filterAndLimits[i];
        if (limitFound === undefined) {
            limitFound = limit;
        }

        queries.push(getReadByFilterQuery(`filter${i}`, filter, limitFound));
    }

    /**
     * Transform the read by filter sub queries to be a single GraphQL query.
     * @param payload Payload of sub filter queries.
     * @returns String single GraphQL query.
     */
    const transformer = (payload) => {
        return `
{
  haystack {
    ${payload.join("\n")}
  }
}
            `;
    }
    const { success, errors } = await this.performOpInBatch(
        "query",
        [queries],
        {
            ...options,
            returnResult: true,
            transformer
        }
    )

    // parse the batched results
    const parsedResult = [];
    for (const res of success) {
        for (const filter of Object.values(res.data.haystack)) {
            const filterResult = [];
            for (const entity of filter.entity) {
                const newEntity = {};
                for (const {name, value, kindValue} of entity.tags) {
                    let kindType = "Zero";
                    if (kindValue !== null && kindValue !== undefined) {
                        kindType = kindValue["__typename"];
                    }
                    newEntity[name] = Hs.toHaystack(value, kindType)
                }
                filterResult.push(newEntity);
            }

            parsedResult.push(filterResult);
        }
    }


    return {
        success: parsedResult,
        errors
    };
}

/**
 * Create a update payload when comparing the changes between oldEntity and newEntity.
 * @param oldEntity Old entity to compare changes against.
 * @param newEntity New entity whose changed we'd like to make current.
 * @param logger Bunyan logging instance.
 * @returns {{id}} A updateRec payload.
 */
const createUpdatePayload = (oldEntity, newEntity, logger) => {
    const updatePayload = {
        id: newEntity.id
    };
    // what's new and what's changed?
    for (const [tag, value] of Object.entries(newEntity)) {
        if (ID_TAGS.includes(tag) || VIRTUAL_TAGS.includes(tag)) {
            logger.debug("Ignoring tag %s and value %s for entity %s.", tag, value, newEntity.id);
            continue;
        }

        if (oldEntity[tag] === undefined) {
            updatePayload[tag] = value;
        } else if (Array.isArray(value) && Array.isArray(oldEntity[tag])) {
            if (value.length !== oldEntity[tag].length) {
                // Not the same, no need to verify
                updatePayload[tag] = value;
            }

            // verify list changes
            let isDifferent = false;
            for (const item of value) {
                if (!(oldEntity[tag].includes(item))) {
                    isDifferent = true;
                    break;
                }
            }

            if (isDifferent) {
                updatePayload[tag] = value;
            }
        } else if (oldEntity[tag] !== value) {
            if (tag.includes("Ref") || ["metaOf"].includes(tag)) {
                // Ref can be different by the ID is what matters here
                if (Hs.getId(oldEntity, tag) !== Hs.getId(newEntity, tag)) {
                    updatePayload[tag] = value;
                }
            } else {
                updatePayload[tag] = value;
            }
        }
    }

    // what's removed?
    for (const tag in oldEntity) {
        if (ID_TAGS.includes(tag) || VIRTUAL_TAGS.includes(tag)) {
            continue;
        }

        if (newEntity[tag] === undefined) {
            updatePayload[tag] = "x:";
        }
    }

    return updatePayload;
}

/**
 * Perform an update or create request for the list of entities given. If the entity exists, the entity will be
 * checked for changes if an update is required, and send a request as necessary. If the entity does not exist, it
 * will be created.
 * @param entities Array of entities to be updated or created.
 * @param options An Object defining batch configurations to be used. See README.md for more information.
 * @returns {Promise<{success: *[], errors: [{args: (string|*)[], error}]}|*>}
 *          - success: Array of entities in their current state in the WideSky database.
 *          - errors: Any errors encountered during create or update operations.
 */
async function updateOrCreate(entities, options={}) {
    if (!Array.isArray(entities)) {
        throw new Error("parameter entities is not an Array");
    } else if (entities.length === 0) {
        this.logger.debug("No entities given.");
        return {
            success: [],
            errors: []
        };
    }

    await BATCH_UPDATE_OR_CREATE_SCHEMA.validate(options);
    options = deriveFromDefaults(this.clientOptions.batch.updateOrCreate, options);
    const { returnResult } = options;

    const createPayload = [];
    const updatePayload = [];
    let returnedEntities = [];    // List of entities in their current state as updated/created
    const skipIndex = new Array(entities.length);

    const idsFilter = [];
    for (let i = 0; i < entities.length; i++) {
        const entity = entities[i];
        if (entity.id === undefined) {
            this.logger.debug(`No id found for entity at index %d. Assuming creation.`, i);
            createPayload.push(entity);
            skipIndex[i] = true;
        } else {
            // filter and limit
            idsFilter.push([`id==@${Hs.getId(entity)}`, 1]);
        }
    }
    const {
        success: currentEntities,
        errors: findErrors
    } = await this.batch.multiFind(idsFilter);
    if (findErrors.length) {
        return {
            success: [],
            errors: findErrors
        };
    }

    for (let i = 0; i < entities.length; i++) {
        if (skipIndex[i]) {
            continue;
        }

        const entity = entities[i];
        const existingEntity = currentEntities[i][0];

        if (existingEntity === undefined) {
            createPayload.push(entity);
        } else {
            const entityUpdate = createUpdatePayload(existingEntity, entity, this.logger);
            if (Object.keys(entityUpdate).length > 1) {
                updatePayload.push(entityUpdate);
            } else {
                // nothing has changed
                if (returnResult) {
                    returnedEntities.push(entity);
                }
            }
        }
    }

    if (createPayload.length === 0 && updatePayload.length === 0) {
        this.logger.debug("Nothing to update or create.");
        return {
            success: entities,
            errors: []
        };
    }

    const requests = [];
    if (createPayload.length > 0) {
        this.logger.debug("Creating %d entities.", createPayload.length);
        requests.push(this.batch.create(createPayload, options));
    }
    else {
        this.logger.debug("Nothing to create.");
    }
    if (updatePayload.length > 0) {
        this.logger.debug("Updating %d entities.", updatePayload.length);
        requests.push(this.batch.update(updatePayload, options));
    } else {
        this.logger.debug("Nothing to update");
    }

    const allErrors = [];
    for (const { success, errors } of await Promise.all(requests)) {
        if (success.length && returnResult) {
            for (const { rows } of success) {
                for (const row of rows) {
                    returnedEntities.push(row);
                }
            }
        }

        for (const error of errors) {
            allErrors.push(error);
        }
    }

    return {
        success: returnedEntities,
        errors: allErrors
    };
}

module.exports = {
    performOpInBatch,
    hisWrite,
    hisRead,
    hisDelete,
    create,
    update,
    deleteById,
    deleteByFilter,
    hisReadByFilter,
    updateByFilter,
    hisDeleteByFilter,
    migrateHistory,
    addChildrenByFilter,
    multiFind,
    updateOrCreate
};
