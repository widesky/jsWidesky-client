"use strict";

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

function errorStatus(err) {
    if (!err) return undefined;
    return err.status ?? err.response?.status ?? err.requestError?.response?.status;
}

function errorCode(err) {
    if (!err) return undefined;
    return err.code ?? err.error?.code ?? err.cause?.code ?? err.requestError?.code;
}

function isRetryable(err) {
    const status = errorStatus(err);
    if (status !== undefined && status !== null) {
        return RETRYABLE_STATUS.has(status);
    }
    return RETRYABLE_CODES.has(errorCode(err));
}

function isRecordLimitError(err) {
    if (!err) return false;
    const texts = [
        err.message,
        err.response?.data?.meta?.dis,
        err.requestError?.response?.data?.meta?.dis
    ];
    return texts.some((t) => typeof t === "string" && t.includes(RECORD_LIMIT_TEXT));
}

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
