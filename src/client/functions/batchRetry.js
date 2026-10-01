"use strict";

// Retry of one batched request after a transient failure. Used by performOpInBatch for every
// batch operation, and by batch.hisDelete for its planning queries and deletes.

const { sleep } = require("../../utils/tools");

// Copied from the widesky-edge-history delete node's shouldRetry (1.7.5) so moving retry into
// the client does not change which failures are retried. 429 is deliberately absent: the API
// server does not rate-limit today. Add it here if that changes.
const RETRYABLE_STATUS = new Set([500, 502, 503, 504]);
const RETRYABLE_CODES = new Set([
    "ENETDOWN", "ENETUNREACH", "ECONNABORTED", "ECONNRESET",
    "ETIMEDOUT", "ECONNREFUSED", "EHOSTDOWN", "EHOSTUNREACH"
]);

// API server wording for a request whose per-entity row count is over its limit. Mirrors
// server text, not a site preference, so it is not configurable.
const RECORD_LIMIT_TEXT = "data points per entity cannot exceed";

/**
 * The HTTP status of a failed request, wherever the transport put it.
 * @param {*} err The thrown error (axios error, Haystack error, or anything else).
 * @returns {number|undefined} The status, or undefined when the error carries none.
 */
function errorStatus(err) {
    if (!err) return undefined;
    return err.status ?? err.response?.status ?? err.requestError?.response?.status;
}

/**
 * The network error code of a failed request, wherever the transport put it.
 * @param {*} err The thrown error.
 * @returns {string|undefined} The code (e.g. "ECONNRESET"), or undefined when it carries none.
 */
function errorCode(err) {
    if (!err) return undefined;
    return err.code ?? err.error?.code ?? err.cause?.code ?? err.requestError?.code;
}

/**
 * Whether a failure is transient: a 5xx status in RETRYABLE_STATUS, or, with no status, a network
 * code in RETRYABLE_CODES.
 * @param {*} err The thrown error.
 * @returns {boolean} true when the request is worth sending again.
 */
function isRetryable(err) {
    const status = errorStatus(err);
    if (status !== undefined && status !== null) {
        return RETRYABLE_STATUS.has(status);
    }
    return RETRYABLE_CODES.has(errorCode(err));
}

/**
 * Whether the API server rejected a request for exceeding its rows-per-entity limit. Such a
 * request is never retried: the same request would fail again (batch.hisDelete bisects it).
 * @param {*} err The thrown error.
 * @returns {boolean} true when the message or the error grid's dis carries RECORD_LIMIT_TEXT.
 */
function isRecordLimitError(err) {
    if (!err) return false;
    const texts = [
        err.message,
        err.response?.data?.meta?.dis,
        err.requestError?.response?.data?.meta?.dis
    ];
    return texts.some((t) => typeof t === "string" && t.includes(RECORD_LIMIT_TEXT));
}

/**
 * Call `fn`, calling it again after each retryable failure (see isRetryable) up to `retries`
 * times. A record-limit error is rethrown at once.
 * @template T
 * @param {function(): Promise<T>} fn The request to make.
 * @param {Object} options Retry options.
 * @param {number} options.retries Extra attempts after the first (0 disables retry).
 * @param {number} options.retryDelay Milliseconds to wait before each extra attempt.
 * @returns {Promise<T>} What `fn` resolves to.
 * @throws {*} The last error when attempts run out or the error is not retryable.
 */
async function withRetry(fn, { retries, retryDelay }) {
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (attempt >= retries || !isRetryable(err) || isRecordLimitError(err)) {
                throw err;
            }
            if (retryDelay > 0) {
                await sleep(retryDelay);
            }
        }
    }
}

module.exports = { isRetryable, isRecordLimitError, withRetry };
