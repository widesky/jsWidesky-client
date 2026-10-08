/*
 * vim: set tw=100 et ts=4 sw=4 si fileencoding=utf-8:
 * © 2022 WideSky.Cloud Pty Ltd
 * SPDX-License-Identifier: MIT
 */
'use strict';

/**
 * @typedef QueryMetaData
 * @property {string | undefined} engineName
 * @property {string | undefined} edgeVersion
 * @property {string | undefined} edgeManagerVersion
 * @property {string | undefined} hostName
 * @property {string | undefined} serverName
 * @property {string | undefined} serverVersion
 * @property {string | undefined} nodeId
 */

const data = require('./../data');
const replace = require('./../graphql/replace');
const moment = require('moment-timezone');
const Url = require('url-parse');
const FormData = require('form-data');
const socket = require('socket.io-client');
const { RequestError } = require("./../errors");
const { CLIENT_SCHEMA } = require("./../utils/evaluator");
const { RequestQueue } = require('./queue');
const PublisherSession = require('./publisher');
const ControlSession = require('./control');
const ConsumerWatchRenewer = require('./watchRenew');
const { parseMetadata } = require("./../utils/metadata");
const clientV2Functions = require("./functions/v2");
const { performOpInBatch, ...allBatchFunctions } = require("./functions/batch");
const {GraphQLError} = require("../errors");
const bunyan = require("bunyan");
const bFormat = require("bunyan-format");
const HaystackTools = require('../utils/haystack');
const { validate: uuidValidate } = require('uuid');

/**
 * Redact the local-part of an email for use in error messages / logs.
 * Keeps the domain (useful for diagnosis) and the first character of the
 * local-part. Falls back to a placeholder if the input is not parseable as
 * a typical "local@domain" string.
 */
function redactEmail(email) {
    if (typeof email !== 'string') return '<email>';
    const at = email.indexOf('@');
    if (at <= 0) return '<email>';
    return `${email[0]}***${email.slice(at)}`;
}

/**
 * Construct an Error for an email-lookup failure. Attaches the raw email as
 * a NON-ENUMERABLE `err.email` so callers that need to log the full value
 * can opt-in (e.g. `err.email`), while `err.message` carries only the
 * redacted form. Non-enumerable means standard `JSON.stringify(err)` and
 * `util.inspect(err)` (which most logger backends pipe errors through) do
 * NOT exfiltrate the raw email. N12.
 */
function makeEmailLookupError(message, email) {
    const err = new Error(message);
    Object.defineProperty(err, 'email', {
        value: email,
        enumerable: false,
        writable: false,
        configurable: false,
    });
    return err;
}

/**
 * Module-private Symbol used by `_performImpersonateEmailLookup` to ask
 * `_attachReqConfig` to skip the `_impersonateLookup` join when the lookup
 * issues its own `/api/read` request. Hidden behind a Symbol (rather than a
 * plain string key) so external callers cannot pass `_skipImpersonateJoin:
 * true` through a normal `submitRequest` config and silently bypass
 * impersonation. N13.
 */
const SKIP_IMPERSONATE_JOIN = Symbol('skipImpersonateJoin');

/**
 * Credential-bearing keys masked in anything handed to the logger. A
 * constant, not an option: redaction that a site could switch off is a
 * credential leak waiting to happen.
 */
const REDACTED = '[REDACTED]';
const REDACTED_KEYS = Object.freeze(['authorization', 'password', 'newpassword',
    'client_secret', 'refresh_token', 'access_token']);

/**
 * Deep copy of a request body or config with every credential-bearing key
 * masked, for logging only. The original object is never modified.
 * @param {*} value
 * @returns {*}
 */
function redactForLog(value) {
    if (Array.isArray(value)) {
        return value.map(redactForLog);
    }
    // Buffers and multipart forms pass through untouched (Buffer is absent
    // in the browser build, hence the typeof guard).
    if (value === null || typeof value !== 'object'
            || (typeof Buffer !== 'undefined' && Buffer.isBuffer(value))
            || typeof value.getBoundary === 'function') {
        return value;
    }
    const out = {};
    for (const [key, val] of Object.entries(value)) {
        out[key] = REDACTED_KEYS.includes(key.toLowerCase()) ? REDACTED : redactForLog(val);
    }
    return out;
}

// Check for the runtime
let runtimeEnv;
if (typeof (process) !== 'undefined' && process.versions) {
    if (process.versions.node) {
        runtimeEnv = 'node';
    }
}
if (!runtimeEnv && typeof (window) !== 'undefined' && window.window === window) {
    runtimeEnv = 'browser';
}
if (!runtimeEnv) {
    throw new Error('unknown runtime environment');
}

let axios;
let fs;

let http = null;
let https = null;
let http2 = null;

let createHTTP2Adapter = null;

if (runtimeEnv == 'node') {
    // node process
    axios = require('axios');
    fs = require('fs');

    http = require('http');
    https = require('https');
    http2 = require('http2-wrapper');
    // This probably doesn't need to be checked for process type. But we lose nothing by delaying
    // the import.
    createHTTP2Adapter = require('axios-http2-adapter').createHTTP2Adapter;
}
else {
    // browser process
    // special case for commonJS as found from this issue
    // https://github.com/axios/axios/issues/5038#:~:text=Since%20the%20latest,stated%20in%20README
    axios = require('axios').default;
    fs = {};
}
const { isAxiosError } = axios;

/** Special columns, these will be placed in the given order */
const SPECIAL_COLS = ['id', 'name', 'dis'];
const MOMENT_FORMAT_MS_PRECISION = 'YYYY-MM-DDTHH:mm:ss.SSS\\Z';

/**
 * Authentication methods supported for creating new users.
 */
const AUTH_METHOD = Object.freeze({
    /**
     * Authentication with locally-stored credentials using OAuth2 password grants.
     */
    LOCAL: 'local',
    /**
     * Authentication with locally-stored credentials using Salted Challenge-Response Authentication
     * Mechanism.
     */
    SCRAM: 'scram'
});

/**
 * Initialise a logging instance.
 * @param {bunyan | bunyan.LoggerOptions | undefined} logObj In the browser the Console is always used. Otherwise, an Object that can be:
 *                  - Empty, meaning a default Bunyan logger is used
 *                  - Object for which a Bunyan instance will be created with:
 *                      - name: Name of logging instance
 *                      - level: Bunyan logging level to show logs higher.
 *                      - raw: If true, output in JSON format. If false, output in prettified Bunyan logging format.
 *                  - Bunyan logging instance.
 * @returns {bunyan} A bunyan logging instance
 */
function initLogger(logObj = {}) {
    if (logObj.constructor.name !== "Object") {
        // use Bunyan logging instance given.
        return logObj;
    }

    const loggerDefaults = {
        name: "WideSky-Client",
        level: "info",
        stream: bFormat(
            {
                outputMode: "short",
                color: true,
                levelInString: true,
            },
            process.stdout
        ),
        ...logObj,
    };

    if (logObj.raw || runtimeEnv == 'browser') {
        loggerDefaults.stream = process.stdout;
    }

    return bunyan.createLogger(loggerDefaults);
}

class WideSkyClient {
    baseUri
    #username
    #password
    #clientId
    #clientSecret
    #accessToken
    logger
    /**
     * If this is true (default) then all http requests made by the client
     * will have the 'Accept-Encoding' header with value of 'gzip, deflate'
     * append to it.
     */
    _acceptGzipEncoding
    _impersonate        // The user id which the original user is impersonating as.
    _impersonatePendingEmail        // Email queued for lazy impersonation resolution.
    _impersonateLookup              // Single-flight Promise for an in-flight email lookup, or null.
    _impersonateGen                 // Monotonic counter bumped on every impersonation-state mutation (N2).
    _requestQueue                   // RequestQueue for outbound HTTP pacing, or null when opt-out.

    /**
     * Constructor for WideSky Client
     * @param baseUri URI to access the WideSky API (excluding /api).
     * @param username Username of the WideSky user to authenticate with.
     * @param password Password of the WideSky user to authenticate with.
     * @param clientId Client ID for OAuth 2.0 authentication.
     * @param clientSecret Client secret for OAuth 2.0 authentication.
     * @param logger In the browser the Console is always used. Otherwise, an Object that can be:
     *                  - Undefined, meaning a default Bunyan logger is used
     *                  - Object for which a Bunyan instance will be created with:
     *                      - name: Name of logging instance
     *                      - level: Bunyan logging level to show logs higher.
     *                      - raw: If true, output in JSON format. If false, output in prettified
     *                        Bunyan logging format.
     *                  - Bunyan logging instance.
     * @param accessToken A valid WideSky access token.
     * @param options An Object containing attributes "axios", "https" and "client" for configuring
     *                the axios, httpsAgent and WideSky client respectively.
     *
     *                Axios configurations are
     *                described at https://axios-http.com/docs/config_defaults.
     *
     *                HttpsAgent configurations are described at
     *                https://nodejs.org/docs/latest-v16.x/api/http.html#new-agentoptions
     */
    constructor(baseUri,
                username,
                password,
                clientId,
                clientSecret,
                logger,
                accessToken,
                options={}) {
        this.baseUri = baseUri;
        this.#username = username;
        this.#password = password;
        this.#clientId = clientId;
        this.#clientSecret = clientSecret;
        this.#accessToken = accessToken;
        this.logger = initLogger(logger);
        this.options = options;
        this.clientOptions = null;
        this._impersonate = null;
        this._impersonatePendingEmail = null;
        this._impersonateLookup = null;
        this._impersonateGen = 0;
        this._acceptGzipEncoding  = true;
        this._requestQueue = null;

        this.initAccessToken();
        this.initAxios();
        this.initClientOptions();
        this.assignSubFunctions();
    }

    /**
     * Create a WideSky client from a given set of configurations
     * @param config An Object defining the configurations for the WideSkyClient. Requires attributes serverURL,
     *               username, password, clientId, clientSecret. Optional attributes are logger, accessToken and
     *               options. Option logger can be:
     *                  - Empty, meaning a default Bunyan logger is used
     *                  - Object for which a Bunyan instance will be created with:
     *                      - name: Name of logging instance
     *                      - level: Bunyan logging level to show logs higher.
     *                      - raw: If true, output in JSON format. If false, output in prettified Bunyan logging format.
     *                  - Bunyan logging instance.
     * @returns {WideSkyClient} A WideSky client instance.
     */
    static makeFromConfig(config={}) {
        const requiredProps = [
            "serverURL",
            "username",
            "password",
            "clientId",
            "clientSecret"
        ];
        for (const prop of requiredProps) {
            if (config[prop] === undefined) {
                throw new Error(`Configuration parameter requires properties ${requiredProps.join(", ")}`);
            }
        }

        return new WideSkyClient(
            config.serverURL,
            config.username,
            config.password,
            config.clientId,
            config.clientSecret,
            config.logger,
            config.accessToken,
            config.options
        );
    }

    assignSubFunctions() {
        // Add function for v2 function
        this.v2 = {};
        for (const [name, func] of Object.entries(clientV2Functions)) {
            this.v2[name] = func.bind(this);
        }
        // Assign batch functions
        this.performOpInBatch = performOpInBatch;
        this.batch = {};
        for (const [name, func] of Object.entries(allBatchFunctions)) {
            this.batch[name] = func.bind(this);
        }
    }

    /**
     * Initialise the Client access token
     */
    initAccessToken() {
        /*
         * The authentication response, used for storing the access token and
         * refresh token.
         */
        this._ws_token = null;
        /*
         * Refresh token retrieval. The list of waiters for a refresh token
         * add themselves here. If `null`, then no refresh is in progress.
         */
        this._ws_token_wait = null;
        /*
         * CORE-9226 (#178): the instant, ON THE LOCAL CLOCK, at or after which
         * the held token must be refreshed. See _computeTokenDeadline for why
         * this is not simply `_ws_token.expires_in`.
         */
        this._ws_token_deadline = null;
        /*
         * The server's own clock, in epoch ms, taken from the `Date` header
         * of the /oauth2/token response most recently seen by the interceptor
         * installed in initAxios(). ONE-SHOT (review N2): the sample is
         * written (or reset to null) on EVERY token response and is
         * consumed-and-cleared by _getTokenSuccess, so it describes exactly
         * one response and can never survive to be paired with a token from
         * a later one. `null` whenever no usable sample is held.
         */
        this._ws_server_time_ms = null;

        if (this.#accessToken) {
            for (const tokenProp of ['refresh_token', 'expires_in', 'token_type', 'access_token']) {
                if (this.#accessToken[tokenProp] === undefined) {
                    throw new Error(`Parameter 'accessToken' is not a valid WideSky token.`);
                }
            }
            this._ws_token = this.#accessToken;
            /* An injected token carries no server context, so its deadline is
             * the raw expiry: the pre-CORE-9226 behaviour, unchanged. */
            this._ws_token_deadline = this.#accessToken.expires_in;
        }
    }

    /**
     * Record the server's clock from a response `Date` header.
     *
     * CORE-9226 (#178). Kept separate from the interceptor so the parse rule
     * has one home and can be driven directly by a test.
     *
     * The write is TOTAL (review N2): a header that is absent or unparseable
     * RESETS the sample to null rather than leaving the previous response's
     * value in place. Keeping the old sample paired the NEW token's expiry
     * with an OLD response's clock: the derived lifetime then inflated by
     * the age of that sample (about one whole token life for a refresh),
     * the deadline overshot by the same amount, and the device presented a
     * dead token for the entire overshoot -- the parking failure this
     * feature exists to remove, reintroduced through its own fallback.
     * Resetting to null makes _computeTokenDeadline degrade to its
     * documented fallback, the raw `expires_in`: exactly the pre-#178
     * behaviour, never an undocumented third mode. NaN itself is still
     * never stored -- a NaN deadline compares false against everything,
     * which would silently pin the token as never-expiring.
     *
     * @param {string} headerValue the raw `Date` header, or undefined.
     * @returns {void}
     */
    _noteServerTime(headerValue) {
        const parsed = (typeof headerValue === 'string')
            ? Date.parse(headerValue) : NaN;
        this._ws_server_time_ms = Number.isFinite(parsed) ? parsed : null;
    }

    /**
     * Work out when, ON THIS DEVICE'S CLOCK, the token must be refreshed.
     *
     * CORE-9226 (#178). This apiserver answers `expires_in` as an ABSOLUTE
     * epoch-millisecond instant rather than the RFC 6749 seconds-until-expiry
     * (measured 2026-08-02: 1786290734743, seven days out). Comparing that
     * against `Date.now()` mixes the server's clock with ours, so on a device
     * whose clock is wrong the refresh decision is wrong by exactly the skew.
     *
     * A TRB145 has no battery-backed RTC and ordinarily boots BEHIND (the
     * firmware build date on a first boot, or a stale watermark after a spell
     * in a warehouse), with ntpclient correcting it only after our services
     * have started. Behind means the absolute expiry is never reached, so the
     * client never refreshes proactively and keeps presenting a token the
     * server has already retired. REST survives that -- dispatchWithRetry
     * catches the 401 and retries once -- but a socket handshake does not: the
     * publisher's AUTH_REJECTION_RE reads the rejection as an auth denial, so
     * a clock fault is reported, and parked on, as a credential fault.
     *
     * The token's LIFETIME is the one quantity both endpoints of which are the
     * server's own: its absolute expiry minus the `Date` of the response that
     * delivered it. Anchoring that lifetime to the local clock at receipt gives
     * a deadline immune to any constant local offset.
     *
     * Falls back to the raw `expires_in` whenever that subtraction is not
     * available or not sensible (no/unparseable `Date` header, or an expiry at
     * or before the server's own clock -- which is what a server answering the
     * RFC's seconds-until-expiry looks like here). The fallback is exactly the
     * behaviour that shipped before this change. Review N2: the sample is
     * per-response (reset or replaced on every token response, consumed
     * once), so this fallback governs EVERY Date-less token, not merely the
     * first.
     *
     * @param {Object} token the token response.
     * @param {number|null} serverTimeMs the server's clock at token receipt.
     * @returns {number} the local-clock instant at which to refresh.
     */
    _computeTokenDeadline(token, serverTimeMs) {
        const expiry = token && token.expires_in;

        if (!Number.isFinite(expiry) || !Number.isFinite(serverTimeMs)) {
            return expiry;
        }

        const lifetime = expiry - serverTimeMs;
        if (lifetime <= 0) {
            return expiry;
        }

        return Date.now() + lifetime;
    }

    /**
     * Apply the config to be used for all axios requests.
     */
    initAxios() {
        const baseURL = this.baseUri;

        const defaultAxiosOptions = {
            baseURL,
        };

        // In the browser, low-level HTTP options like 'keepAlive' cannot be configured
        // manually, as the browser handles connection reuse internally. Axios options such as
        // 'httpAgent' or 'httpsAgent' are ignored in this environment. Connection behavior is
        // controlled by the browser's own HTTP stack.
        if (runtimeEnv == 'node') {
            // Enable keep-alive by default in Node.js
            const agentOptions = {
                keepAlive: true,
                ...(this.options.http ?? {}),
            };

            defaultAxiosOptions.httpAgent = new http.Agent(agentOptions);
            defaultAxiosOptions.httpsAgent = new https.Agent(agentOptions);

            if (this.options.http2?.enabled) {
                this._http2Agent = new http2.Agent(agentOptions);
                defaultAxiosOptions.adapter = createHTTP2Adapter({
                    agent: this._http2Agent,
                });
            }
        }

        // HTTP/2 request timeout (guards against session establishment hangs).
        // Default 60s. Set to 0 to disable.
        const DEFAULT_HTTP2_REQUEST_TIMEOUT_MS = 60000;
        this._requestTimeoutMs = this.options.http2?.requestTimeout
            ?? DEFAULT_HTTP2_REQUEST_TIMEOUT_MS;

        // Merge user-provided axios options last to allow override
        const axiosOptions = {
            ...defaultAxiosOptions,
            ...(this.options.axios ?? {}),
        };

        this.axios = axios.create(axiosOptions);

        /* CORE-9226 (#178): capture the server's clock off the token response
         * so _computeTokenDeadline can derive the token's true lifetime
         * without trusting the local clock. Scoped to /oauth2/token because
         * that is the only response whose `Date` we consume, and the handler
         * must never be able to fail a request it is only observing. */
        this.axios.interceptors.response.use((res) => {
            try {
                const url = (res && res.config && res.config.url) || '';
                if (url.includes('/oauth2/token')) {
                    /* Review N3: axios does NOT normalise header case on the
                     * plain-property surface. `headers.date` resolves only
                     * because node's HTTP client happens to hand axios
                     * lowercase names; an adapter that delivers the wire-case
                     * `Date` (as HTTP/1.1 actually carries it) leaves
                     * `.date` undefined and this capture silently inert --
                     * the whole #178 fix then no-ops with nothing failing.
                     * AxiosHeaders.get() is the case-insensitive accessor
                     * axios provides for exactly this; the plain read remains
                     * only as the fallback for header objects that are not
                     * AxiosHeaders. */
                    const headers = res.headers;
                    const date = headers && ((typeof headers.get === 'function')
                        ? headers.get('date') : headers.date);
                    this._noteServerTime(date);
                }
            } catch (e) { /* observation only, never break the response */ }
            return res;
        });
    }

    /**
     * Initialise the WideSkyClient with the user configurations.
     * @throws {ValidationError} if `options.client` fails schema validation.
     * @returns {void}
     */
    initClientOptions() {
        // stripUnknown: false — with noUnknown() schemas, yup's default
        // validation casts with stripUnknown enabled, which silently drops
        // unknown keys before the noUnknown test can report them. Keeping
        // unknown keys through the cast makes typo'd options throw here,
        // while non-strict validation preserves yup's usual type coercion
        // (e.g. numeric strings on queue sub-options).
        CLIENT_SCHEMA.validateSync(this.options.client, { stripUnknown: false });
        this.clientOptions = CLIENT_SCHEMA.cast(this.options.client);

        // This method MUST stay fully synchronous — do NOT mark it `async`
        // or insert an `await`. The constructor calls it directly and relies
        // on (a) validation errors throwing from `new WideSkyClient(...)`
        // where callers can catch them (CORE-9107), and (b) _requestQueue
        // being populated before any subsequent method call. An `async`
        // body turns the ValidationError into an unhandled promise
        // rejection and leaves the client half-initialised, with no test
        // failure surfacing it (existing tests do
        // `await ws.initClientOptions()` and would still pass).
        const qOpts = this.clientOptions.queue;
        this._requestQueue = qOpts !== undefined
            ? new RequestQueue(qOpts, this.logger)
            : null;

        this.setAcceptGzip(this.clientOptions.acceptGzip);

        if (this.clientOptions.impersonateAs !== null) {
            const value = this.clientOptions.impersonateAs;
            if (typeof value !== 'string' || value.trim() === '') {
                throw new TypeError(
                    'options.client.impersonateAs must be a non-empty UUID or email string, or null'
                );
            }
            if (value.includes('@')) {
                this._impersonatePendingEmail = value.trim();
            } else {
                this.impersonateAs(value);
            }
        }

        if (this.isProgressEnabled) {
            if (this.clientOptions.progress.instance === undefined) {
                const cliProgress = require("cli-progress");
                this.clientOptions.progress.instance = new cliProgress.MultiBar({
                    clearOnComplete: false,
                    hideCursor: true
                }, cliProgress.Presets.shades_classic);
            }
        }
    }

    /**
     * Perform a log-in, if not already done.  This does a `getToken` whilst
     * performing no further operations.
     */
    login() {
        return this.getToken();
    };

    /**
     * Impersonate as a WideSky user when performing requests, or clear any
     * existing impersonation.
     *
     * Pass `null` (or `undefined`) to clear any active impersonation AND any
     * pending email-based impersonation queued via the `client.impersonateAs`
     * option (equivalent to calling `unsetImpersonate()`).
     *
     * To impersonate via email, use {@link WideSkyClient#impersonateAsEmail}
     * instead - passing an email string here throws.
     *
     * @param userId The UUID of the User entity to be impersonated, or
     *               `null` / `undefined` to clear impersonation.
     * @throws {TypeError} if `userId` is an empty string, a non-string value,
     *                     contains `@` (use `impersonateAsEmail` for emails),
     *                     or is not a valid RFC 4122 UUID.
     */
    impersonateAs(userId) {
        if (userId == null) {
            this.unsetImpersonate();
            return;
        }
        if (typeof userId !== 'string' || userId.trim() === '') {
            throw new TypeError(
                'impersonateAs requires a non-empty user UUID string, ' +
                'or null/undefined to clear impersonation'
            );
        }
        if (userId.includes('@')) {
            throw new TypeError(
                'impersonateAs requires a user UUID; use impersonateAsEmail() ' +
                'for email-based impersonation'
            );
        }
        if (!uuidValidate(userId)) {
            throw new TypeError(
                `impersonateAs requires a valid UUID; got ${userId}`
            );
        }
        this._impersonate = userId;
        this._impersonateGen++;
        this.logger.info("Now impersonating as user ID %s", userId);
    };

    /**
     * Resolve a WideSky user by account email and impersonate as that user
     * for all subsequent requests. Authentication uses the client's
     * configured credentials; the lookup itself runs as that authenticated
     * user (without impersonation), regardless of any active impersonation
     * already set when this method is called. After it resolves, impersonation
     * applies to every subsequent request.
     *
     * Concurrent calls (whether from parallel lazy resolutions or from explicit
     * back-to-back invocations) are serialised through a single in-flight
     * promise, so order of resolution matches order of invocation and no
     * request is ever sent without the resolved `X-IMPERSONATE` header.
     *
     * @param email Email of the account whose user entity should be impersonated.
     * @returns {Promise<string>} The resolved user UUID now being impersonated.
     * @throws {TypeError} if `email` is not a non-empty string.
     * @throws {Error} if no account matches the email, more than one account
     *                 matches, the matched account has no `userRef` tag, or the
     *                 extracted user id is not a valid UUID. The error's
     *                 `message` carries a redacted email; the raw value is on
     *                 a non-enumerable `err.email`.
     * @throws Any error raised by the underlying `submitRequest` call
     *         (network failure, authentication error, Haystack parse error,
     *         axios 4xx/5xx, etc.).
     */
    async impersonateAsEmail(email) {
        if (typeof email !== 'string' || email.trim() === '') {
            throw new TypeError(
                'impersonateAsEmail requires a non-empty email string'
            );
        }
        // N3: normalise here too - the perform-lookup helper trims again, but
        // doing it at the entry point makes the value consistent in any logs
        // / error paths added later.
        email = email.trim();

        // M4: prior capture is correct only because the assignment
        // `this._impersonateLookup = run` below runs synchronously with no
        // intervening await. Do not insert an await between prior, the IIFE,
        // and the assignment - a peer could otherwise install its own lookup
        // in the gap and we would lose the serialisation order.
        const prior = this._impersonateLookup;
        const run = (async () => {
            // Serialise: wait for any in-flight lookup to settle so that the
            // last caller's value wins (mirrors getToken's wait-queue semantics).
            if (prior) {
                try { await prior; } catch (_) { /* swallow - we run regardless */ }
            }
            return this._performImpersonateEmailLookup(email);
        })();
        this._impersonateLookup = run;
        try {
            return await run;
        } finally {
            if (this._impersonateLookup === run) {
                this._impersonateLookup = null;
            }
        }
    };

    /**
     * @private
     * Internal: perform the actual Haystack lookup for an email and install
     * impersonation. Always runs unimpersonated (snapshots `_impersonate`,
     * nulls it for the duration of the lookup, restores on failure).
     */
    async _performImpersonateEmailLookup(email) {
        // N3: trim AFTER guard so the validated string is also the one we send.
        email = email.trim();

        // H1: two-pass escape - backslashes first, then double quotes.
        const escaped = email
            .replaceAll('\\', '\\\\')
            .replaceAll('"', '\\"');

        const filter = `account and email=="${escaped}"`;

        // H5: the lookup must run as the configured (authenticated) user, not
        // under any active impersonation. Snapshot, clear, restore on failure.
        const savedImpersonate = this._impersonate;
        this._impersonate = null;

        // N2: snapshot the impersonation generation. If the caller mutates
        // impersonation state synchronously while the lookup is in flight
        // (e.g. calls `unsetImpersonate()` or `impersonateAs('other')`), the
        // generation moves and our completion no longer represents the
        // caller's intent - we abandon our write rather than clobbering.
        const myGen = ++this._impersonateGen;

        let response;
        try {
            // N1 / N10: call submitRequest directly (skipping v2.find) AND mark
            // the request with the module-private `SKIP_IMPERSONATE_JOIN`
            // Symbol so the recursive `_attachReqConfig` invocation does NOT
            // await `_impersonateLookup` (which IS the very promise we are
            // running inside, hence the self-deadlock the original design
            // suffered from). The Symbol survives axios serialisation /
            // `JSON.stringify` / `util.inspect` because Symbols are skipped
            // by all three. The 401-retry path also relies on the Symbol
            // being re-stamped onto the cloned config returned by
            // `_attachReqConfig`.
            response = await this.submitRequest(
                'POST',
                '/api/read',
                {
                    meta: { ver: '2.0' },
                    cols: [{ name: 'filter' }, { name: 'limit' }],
                    rows: [
                        {
                            filter: `s:${filter}`,
                            // limit: 2 so we can detect (and reject) duplicate matches.
                            limit: 'n:2'
                        }
                    ]
                },
                { [SKIP_IMPERSONATE_JOIN]: true }
            );
        } catch (err) {
            // Restore prior impersonation ONLY if no caller intervened.
            if (this._impersonateGen === myGen) {
                this._impersonate = savedImpersonate;
            }
            throw err;
        }

        const rows = (response && response.rows) || [];

        try {
            if (rows.length === 0) {
                throw makeEmailLookupError(
                    `No account found for email ${redactEmail(email)}`,
                    email
                );
            }
            if (rows.length > 1) {
                throw makeEmailLookupError(
                    `Multiple accounts (${rows.length}) found for email ${redactEmail(email)}`,
                    email
                );
            }
            if (typeof rows[0].userRef !== 'string') {
                throw makeEmailLookupError(
                    `Account for ${redactEmail(email)} has no userRef tag`,
                    email
                );
            }
            const userId = HaystackTools.getId(rows[0], 'userRef');
            if (!uuidValidate(userId)) {
                throw makeEmailLookupError(
                    `Account for ${redactEmail(email)} has a malformed userRef ` +
                    `(not a UUID): ${userId}`,
                    email
                );
            }

            // N5: PII-bearing format - email + user id at debug only.
            this.logger.debug(
                "Resolved impersonation email %s to user ID %s",
                email,
                userId
            );

            // N2: only install if no caller intervened. If they did (e.g.
            // explicit impersonateAs('other-uuid') or unsetImpersonate()),
            // honour their write and discard ours.
            if (this._impersonateGen === myGen) {
                this.impersonateAs(userId);
            } else {
                this.logger.debug(
                    "Impersonation generation advanced during email lookup; " +
                    "discarding resolved user ID %s",
                    userId
                );
            }
            return userId;
        } catch (err) {
            if (this._impersonateGen === myGen) {
                this._impersonate = savedImpersonate;
            }
            throw err;
        }
    };

    isImpersonating() {
        return this._impersonate !== null;
    };

    unsetImpersonate() {
        if (this._impersonate !== null) {
            this.logger.info(
                "Cleared impersonation (was user ID %s)",
                this._impersonate
            );
        } else if (this._impersonatePendingEmail !== null) {
            this.logger.info("Cleared pending email-based impersonation");
        }
        this._impersonate = null;
        this._impersonatePendingEmail = null;
        this._impersonateGen++;
    };

    setAcceptGzip(acceptGzip) {
        this._acceptGzipEncoding = Boolean(acceptGzip);
    }

    isAcceptingGzip() {
        return this._acceptGzipEncoding;
    }

    get isProgressEnabled() {
        return this.clientOptions.progress.enable && runtimeEnv == 'node';
    }

    /**
     * Create a progress instance
     * @param size Highest value for the progress counter.
     * @param initialValue Initial value for the progress counter.
     * @returns {*}
     */
    progressCreate(size, initialValue=0) {
        return this.clientOptions.progress.instance[this.clientOptions.progress.create](size, initialValue);
    }

    /**
     * Protected method for submitting requests against the API server with Axios.
     * Low-level axios dispatcher: no queue, no retry. Queue and 401-retry
     * orchestration lives in submitRequest, which wraps both the original
     * dispatch and the retry inside a single queue slot.
     *
     * @param method Request method to be performed. Not case-sensitive.
     * @param uriPath Endpoint to for request to be sent, relative to the base URI given to the client.
     * @param body Body of the request. Ignored if given method is "GET".
     * @param config Request config to be applied. Refer to https://www.npmjs.com/package/axios#request-config for
     * more info.
     * @returns Data from response of request.
     */
    async _wsRawSubmit(method, uriPath, body, config) {
        const uri = this.baseUri + uriPath;

        /* istanbul ignore next */
        if (this.logger) {
            this.logger.trace(redactForLog(config), 'Raw request');
        }

        const axiosCall = () => {
            switch (method.toUpperCase()) {
                case 'GET':    return this.axios.get(uri, config);
                case 'POST':   return this.axios.post(uri, body, config);
                case 'PATCH':  return this.axios.patch(uri, body, config);
                case 'PUT':    return this.axios.put(uri, body, config);
                case 'DELETE': return this.axios.delete(uri, config);
                default:       throw new Error(`Not configured for method ${method}.`);
            }
        };

        let res;
        if (this._requestTimeoutMs > 0 && this.options.http2?.enabled) {
            let timeoutId;
            const timeoutPromise = new Promise((_, reject) => {
                timeoutId = setTimeout(() => {
                    reject(new Error(
                        `Request to ${uriPath} timed out after`
                        + ` ${this._requestTimeoutMs}ms (HTTP/2 mode)`
                    ));
                }, this._requestTimeoutMs);
            });
            try {
                res = await Promise.race([axiosCall(), timeoutPromise]);
            } finally {
                clearTimeout(timeoutId);
            }
        } else {
            res = await axiosCall();
        }
        return res.data;
    };

    /**
     * Attach necessary headers to request config.
     * @param config Existing config to add to.
     * @returns Modified config.
     */
    async _attachReqConfig(config) {
        const token = await this.getToken();

        // N1 / N10 / N13: lookup-internal requests carry SKIP_IMPERSONATE_JOIN
        // as a Symbol-keyed flag so:
        //   - the recursive call below doesn't deadlock by awaiting the very
        //     _impersonateLookup promise it is running inside (N1),
        //   - the flag survives the 401-retry path (N10), where the 401 handler
        //     re-invokes _attachReqConfig with the SAME config object,
        //   - external callers cannot bypass impersonation by setting a plain
        //     string key in their own config (N13).
        //
        // Read by Symbol; propagate by Symbol; never mutate the input object.
        const skipImpersonateJoin = !!(config && config[SKIP_IMPERSONATE_JOIN]);

        // C1/H9: single-flight join with a re-check loop, so concurrent
        // first-burst requests converge on one lookup and one retry on
        // failure, never N retries from N peers.
        //
        // The first request to find a pending email here launches
        // impersonateAsEmail (which synchronously installs _impersonateLookup);
        // every later request sees that promise and awaits it instead of
        // starting a parallel lookup. We deliberately do NOT clear
        // _impersonatePendingEmail before the lookup: on failure, peers that
        // unblock between impersonateAsEmail's finally (which clears
        // _impersonateLookup) and the originator's catch would otherwise see
        // null pending AND null _impersonate, and fall through to send an
        // un-impersonated request. Leaving pending set means peers correctly
        // observe "no lookup, but still pending" and join the retry that the
        // first surviving peer launches. Pending is cleared only on success.
        if (!skipImpersonateJoin) while (true) {
            if (this._impersonateLookup) {
                try {
                    await this._impersonateLookup;
                } catch (_) { /* originator surfaces the error; we just re-check state */ }
                continue;
            }

            if (!this._impersonatePendingEmail || this._impersonate) {
                break;
            }

            // No-yield invariant: the read of _impersonatePendingEmail above,
            // the assignment to `pending` below, and the synchronous portion
            // of `impersonateAsEmail` (up to its `_impersonateLookup = run`
            // assignment) MUST run without an intervening await. Otherwise a
            // peer could win the race for the launch and we would double-launch.
            const pending = this._impersonatePendingEmail;
            try {
                await this.impersonateAsEmail(pending);
                // Success: _impersonate now set by impersonateAs(userId).
                // Forget the pending email so future unsetImpersonate /
                // impersonateAs(null) calls don't re-arm it.
                this._impersonatePendingEmail = null;
            } catch (err) {
                // Pending remains set - peers waiting on _impersonateLookup
                // will re-enter the while loop, see pending still truthy,
                // and the first peer to win the loop iteration will retry.
                // Subsequent peers in that iteration will join the retry via
                // the in-flight _impersonateLookup check above.
                throw err;
            }
            break;
        }

        config = Object.assign({}, config);       // make a copy
        if (config.headers === undefined) {
            config.headers = {};
        }

        config.headers['Authorization'] = 'Bearer ' + token.access_token;
        config.headers['Accept'] = 'application/json';

        if (this.isAcceptingGzip()) {
            config.decompress = true;
        }

        if (this.isImpersonating()) {
            config.headers['X-IMPERSONATE'] = this._impersonate;
        }

        // N10: re-stamp the skip-join Symbol on the cloned config so the
        // 401-retry path (which feeds this config back into _attachReqConfig
        // inside the SAME submitRequest call) still bypasses the join. Axios
        // ignores unknown top-level keys, so leaving the Symbol on the
        // outgoing config has no wire effect.
        if (skipImpersonateJoin) {
            config[SKIP_IMPERSONATE_JOIN] = true;
        }

        return config;
    }

    async submitRequest(method, uri, body={}, config={}) {
        config = await this._attachReqConfig(config);

        // The dispatch + 401-retry sequence is wrapped together so a single
        // queue slot is held across both. If the 401 retry ran OUTSIDE the
        // slot (e.g. directly after queue.add resolves with a rejection),
        // the queue's .finally would release the slot and dispatch the next
        // queued request — which would then race alongside the retry,
        // briefly exceeding maxConcurrent. By keeping the retry inside the
        // same async function passed to queue.add, the slot is held until
        // the retry settles.
        const dispatchWithRetry = async () => {
            this.logger.info("Submitting request [%s] %s", method.toUpperCase(), uri);
            this.logger.debug("With body %j and config %j", redactForLog(body), redactForLog(config));
            try {
                return await this._wsRawSubmit(method, uri, body, config);
            }
            catch (err) {
                if (isAxiosError(err) && err.response
                    && err.response.status === 401 && this._ws_token) {
                    // 401 on dispatch: token expired (likely while waiting
                    // in the queue). Refresh and retry within this same
                    // slot — the queue's _inFlight counter stays at 1 for
                    // this request the whole time.
                    this._ws_token = null;
                    config = await this._attachReqConfig(config);
                    return await this._wsRawSubmit(method, uri, body, config);
                }
                throw err;
            }
        };

        try {
            // Auth endpoint bypass: a tight maxQueueDepth must not be able
            // to reject a token refresh with QueueFullError. /oauth2/token
            // is never invoked through submitRequest in practice (auth uses
            // _wsRawSubmit), but the check is kept defensively.
            if (this._requestQueue && uri !== '/oauth2/token') {
                return await this._requestQueue.add(dispatchWithRetry);
            }
            return await dispatchWithRetry();
        }
        catch (err) {
            let parsedErr = err;
            if (isAxiosError(err) && err.response) {
                parsedErr = RequestError.make(err, this.logger);
            }
            this.logger.error(parsedErr);
            if (parsedErr instanceof GraphQLError && parsedErr.errors.length > 1) {
                parsedErr.errors.forEach((msg, i) => this.logger.error("GraphQL error #%d: %s", i + 1, msg));
            }
            throw parsedErr;
        }
    }

    /**
     * Private method: perform a new log-in.  Returns JSON response from
     * server or raises an error.
     */
    _doLogin() {
        /* istanbul ignore next */
        if (this.logger) {
            this.logger.trace('Performing login attempt');
        }

        return this._wsRawSubmit(
            'POST',
            '/oauth2/token',
            {
                username: this.#username,
                password: this.#password,
                grant_type: 'password'
            },
            {
                auth: {
                    username: this.#clientId,
                    password: this.#clientSecret
                }
            }
        );
    };

    /**
     * Private method: refresh a token. Returns JSON response from server or
     * raises an error. Requires that _ws_token is not null.
     */
    _doRefresh() {
        /* istanbul ignore next */
        if (this.logger) this.logger.trace('Performing token refresh attempt');

        return this._wsRawSubmit(
            'POST',
            '/oauth2/token',
            {
                refresh_token: this._ws_token.refresh_token,
                grant_type: 'refresh_token'
            },
            {
                auth: {
                    username: this.#clientId,
                    password: this.#clientSecret
                }
            }
        );
    };

    _getTokenSuccess(token, resolve) {
        /* istanbul ignore next */
        if (this.logger) {
            this.logger.info('Logged in to API server');
        }
        this._ws_token = token;
        /* CORE-9226 (#178): pin the refresh instant to THIS device's clock.
         * The server-time sample is consumed ONCE and cleared (review N2):
         * it describes the response that carried THIS token, and must never
         * survive to be paired with a later one. A later response that fails
         * to deliver a sample of its own falls back to the raw expiry rather
         * than borrowing this token's. */
        const serverTimeMs = this._ws_server_time_ms;
        this._ws_server_time_ms = null;
        this._ws_token_deadline = this._computeTokenDeadline(
            token, serverTimeMs);

        const waiters = this._ws_token_wait;

        this._ws_token_wait = null;
        resolve(token);
        waiters.forEach(function (waiter) {
            waiter.resolve(token);
        });
    }

    _getTokenFail(err, reject) {
        /* istanbul ignore next */
        if (this.logger) {
            this.logger.warn(err, 'Failed to log into API server');
        }
        this._ws_token = null;

        const waiters = this._ws_token_wait;

        this._ws_token_wait = null;
        reject(err);
        waiters.forEach(function (waiter) {
            waiter.reject(err);
        });
    }

    /**
     * Private method: retrieve the access token.  This performs a login if
     * the current token is absent or attempts a refresh if expired.
     */
    getToken() {
        let firstStep;
        let refresh = false;

        /* Is a request in progress? */
        if (this._ws_token_wait !== null) {
            /* Join the queue */
            /* istanbul ignore next */
            if (this.logger) {
                this.logger.trace('Waiting for token acquisition');
            }

            return new Promise( (resolve, reject) => {
                this._ws_token_wait.push({
                    resolve: resolve,
                    reject: reject
                });
            });
        }

        if (this._ws_token === null) {
            /* No token, so acquire one */
            this._ws_token_wait = [];
            /* istanbul ignore next */
            if (this.logger) {
                this.logger.trace('Begin token acquisition');
            }

            firstStep = this._doLogin();
        }
        /* CORE-9226 (#178): compare against the LOCAL-clock deadline derived at
         * token receipt, not the server's absolute expiry. `?? expires_in`
         * covers a token installed by something other than _getTokenSuccess. */
        else if ((this._ws_token_deadline ?? this._ws_token.expires_in) < Date.now()) {
            /* Token is expired, so do a refresh */
            /* istanbul ignore next */
            if (this.logger) {
                this.logger.trace('Begin token refresh');
            }

            this._ws_token_wait = [];
            firstStep = this._doRefresh();
            refresh = true;
        }
        else {
            return this._ws_token;
        }

        return new Promise( async (resolve, reject) => {
            return firstStep
                .then((token) => this._getTokenSuccess(token, resolve))
                .catch((err) => {
                    /* If we're refreshing, try a full log-in */
                    if (refresh) {
                        /* istanbul ignore next */
                        if (this.logger) {
                            this.logger.info(
                                err,
                                'Refresh fails, trying log-in instead'
                            );
                        }
                        return this._doLogin()
                            .then((token) => this._getTokenSuccess(token, resolve))
                            .catch((err) => this._getTokenFail(err, reject));
                    }
                    else {
                        return this._getTokenFail(err, reject);
                    }
                });
        });
    };

    /**
     * Perform an operation given by the uri with argument ids. Ids can either be a String or an array of String's.
     * @param ids Entity id/s for the operation to be performed on.
     * @param uri API endpoint to perform the operation.
     * @returns {Promise<*>}
     */
    _opByIds(ids, uri) {
        if (typeof ids === 'string' || (Array.isArray(ids) && ids.length === 1)) {
            const id = Array.isArray(ids) ? ids[0] : ids;

            return this.submitRequest(
                'GET',
                uri,
                {},
                {
                    params: {
                        id: (new data.Ref(id)).toHSZINC()
                    }
                }
            );
        }
        else if (Array.isArray(ids)) {
            if (ids.length > 1) {
                // verify input is all strings
                for (const id of ids) {
                    if (!(typeof id === 'string')) {
                        if (id instanceof Object) {
                            // check if its compatible with class Ref
                            try {
                                new data.Ref(id);
                            }
                            catch (error) {
                                throw new Error(
                                    `Parameter 'ids' contains an element that is of type object but not compatible ` +
                                    `with class Ref due to: ${error.message}`
                                );
                            }
                        } else {
                            throw new Error(
                                `Parameter 'ids' contains an element that is not a string. Found ${typeof id}.`
                            );
                        }
                    }
                }

                return this.submitRequest(
                    'POST',
                    uri,
                    {
                        meta: {
                            ver: '2.0',
                        },
                        cols: [
                            {name: 'id'}
                        ],
                        rows: ids.map(function (id) {
                            return {id: (new data.Ref(id)).toHSJSON()};
                        })
                    });
            } else {
                throw new Error(`An empty array of id's was given.`);
            }
        } else {
            throw new Error(`Parameter 'ids' is neither a single id or an array of id's.`);
        }
    }

    /**
     * Perform a filter operation, conducting the necessary checks before doing so.
     * @param op Operation to be completed
     * @param filter Filter to be used.
     * @param limit Limit to be used.
     * @returns {Promise<*>} Result of API call.
     */
    _byFilter(op, filter, limit) {
        if (limit < 0) {
            throw new Error('Invalid negative limit given.');
        }

        if (typeof filter !== 'string') {
            throw new Error(`Invalid filter type ${typeof filter} given. Expected string.`);
        }

        return this.submitRequest(
            "POST",
            `/api/${op}`,
            {
                meta: {
                    ver: "2.0"
                },
                cols: [
                    {
                        "name": "filter"
                    },
                    {
                        "name": "limit"
                    }
                ],
                rows: [
                    {
                        filter: `s:${filter}`,
                        limit: `n:${limit}`
                    }
                ]
            }
        );
    }

    /**
     * Perform a `read` request of the WideSky API server.  This function takes
     * one or more IDs expressed as a list.
     *
     * @param   ids     Entity IDs, either a single ID or an array.  (string or
     *                  array of strings)
     * @returns Promise that resolves to the raw grid.
     */
    read(ids) {
        return this._opByIds(ids, '/api/read');
    };

    /**
     * Perform a graphql request to the WideSky API server.
     * This function takes in a string which contains the
     * graph query.
     *
     * @param   graphql The graph query
     * @param   {QueryMetaData | string} [metadata] - Optional metadata to be appended to the
     * outbound query. This can be an object or a JSON-stringified object.
     * @returns Promise that resolves to the graphql response.
     */
    query(graphql, metadata) {
        graphql = replace.outerBraces(graphql);
        const body = {};

        try {
            const metadataParsed = parseMetadata(metadata);
            if (metadata !== undefined) {
                body.metadata = metadataParsed;
            }
        } catch (err) {
            // Log and allow the original query to pass through
            this.logger.warn('Metadata failed to parse:', err);
        }

        // Insert `query` after metadata
        body.query = graphql;

        return this.submitRequest(
            'POST',
            '/graphql',
            body
        );
    }

    /**
     * Perform a `read` request of the WideSky API server.  This function takes
     * a filter string which is used by the server to scan matching entities.
     *
     * @param   filter      Filter expression (string)
     * @param   limit       Optional limit on the number of entities (integer)
     * @returns Promise that resolves to the raw grid.
     */
    find(filter, limit=0) {
        return this._byFilter('read', filter, limit);
    };

    /**
     * Perform a cache reload request of the WideSky API server.
     * @returns Promise that resolves to the raw grid.
     */
    reloadCache() {
        return this.submitRequest(
            'GET',
            '/api/reloadAuthCache'
        );
    };

    /**
     * Create or Update one or more entities.
     *
     * @param   op          Operation to perform
     * @param   entities    Array of entity objects
     * @returns Promise that resolves to the raw grid.
     */
    _create_or_update(op, entities) {
        if (!(Array.isArray(entities))) {
            entities = [entities];
        }

        /* Generate the columns, make a note of the haystack version needed */
        let cols = [], present = {}, ver = '2.0';

        entities.forEach(function (entity) {
            Object.keys(entity).forEach(function (col) {
                if (!present[col]) {
                    present[col] = true;
                }

                /* Upgrade to Haystack 3.0 */
                if (Array.isArray(entity[col])) {
                    ver = '3.0';
                }
            });
        });

        /* Ensure updateRec lists `id` */
        if ((!present.id) && (op === 'updateRec')) {
            /* istanbul ignore next */
            if (this.logger) {
                this.logger.trace(entities, 'Entities lacks id column');
            }

            throw new Error('id is missing');
        }

        /* Generate the columns to be emitted, starting with the special ones */
        SPECIAL_COLS.forEach((c) => {
            if (present[c]) {
                cols.push(c);
                delete present[c];
            }
        });

        /* Add the others in, in alphabetical order */
        cols = [...cols, ...(Object.keys(present).sort())];

        return this.submitRequest(
            'POST',
            `/api/${op}`,
            {
                meta: {ver: ver},
                cols: cols.map(function (c) {
                    return {name: c};
                }),
                rows: entities
            }
        );
    };

    /**
     * Create one or more entities.  This takes an array of objects and attempts
     * to create those entities in WideSky.
     *
     * @param   entities    Array of entity objects
     * @returns Promise that resolves to the raw grid.
     */
    create(entities) {
        return this._create_or_update('createRec', entities);
    };

    /**
     * Update one or more entities.  This takes an array of objects and attempts
     * to update those entities in WideSky.
     *
     * @param   entities    Array of entity objects
     * @returns Promise that resolves to the raw grid.
     */
    update(entities) {
        return this._create_or_update('updateRec', entities);
    };

    /**
     * Create a new user account.
     *
     * @param   {string}    email       Email (user name) of the new user
     * @param   {string}    name        Name (description) of the new user account,
     *                                  will become the `dis` field of the user entity.
     * @param   {string}    description Purpose of the user account, e.g. "User",
     *                                  "SuperUser", … etc.  Fills in the `primaryFunction` tag.
     * @param   {string[]}  roles       The IDs (UUIDs or names) of the `role` entities to link to
     *                                  this new user.
     * @param   {string?}   password    The new password for the user.  If set to `null` or the
     *                                  empty string, the user will be sent an email to "activate"
     *                                  their user account (and supply a password as they do so).
     * @param   {string?}   method      The authentication method for the new user.  At the time
     *                                  of writing, the choices are: "local" (the default, using
     *                                  OAuth2 authentication) and "scram" (SCRAM authentication).
     */
    createUser(email, name, description, roles, password=null, method=AUTH_METHOD.LOCAL) {
        /* istanbul ignore next */
        if (this.logger) {
            this.logger.trace('Creating a new user: ' + email);
        }

        if (email.length < 1) {
            throw new Error('Email cannot be empty.');
        }

        if (description.length < 1) {
            throw new Error('Description cannot be empty.');
        }

        if (Array.isArray(roles) === false) {
            throw new Error('Roles must be an array.');
        }
        else if (roles.length === 0) {
            throw new Error('At least one roles must be set.');
        }

        if (method !== AUTH_METHOD.LOCAL && method !== AUTH_METHOD.SCRAM) {
            throw new Error('Auth method can only be LOCAL or SCRAM.');
        }

        return this.submitRequest(
            'PUT', '/api/admin/user',
            {email, name, description, roles, password, method}
        );
    }

    /**
     * Change the current session user's password.
     *
     * @param   newPassword - A string
     * @returns Promise that resolves to the raw grid.
     */
    updatePassword(newPassword) {
        /* istanbul ignore next */
        if (this.logger) {
            this.logger.trace('Updating password');
        }

        if (!newPassword) {
            throw new Error('New password cannot be empty.');
        }

        return this.submitRequest(
            'POST',
            '/user/updatePassword',
            {
                newPassword
            }
        );
    };

    /**
     * Delete one or more entities given as IDs.
     *
     * @param   ids     Entity IDs, either a single ID or an array.  (string or
     *                  array of strings)
     * @returns Promise that resolves to the raw grid.
     */
    deleteById(ids) {
        return this._opByIds(ids, '/api/deleteRec');
    };


    /**
     * Delete entities that match a given filter string.
     *
     * @param   filter      Filter expression (string)
     * @param   limit       Optional limit on the number of entities to delete
     *                      (integer)
     * @returns Promise that resolves to the raw grid.
     */
    deleteByFilter(filter, limit=0) {
        return this._byFilter('deleteRec', filter, limit);
    };

    /**
     * Perform a history read request.
     *
     * @param   ids         (string)    Entity to read
     *                      (array)     Entities to read (multi-point)
     * @param   from        (string)    Textual read range (e.g. "today")
     *                      (Date)      Starting timestamp of read
     * @param   to          (Date)      Ending timestamp of read
     *
     * @param   batchSize    (Number)    Optional batch size when reading multiple
     *                                  points.  Some environments may experience
     *                                  issues reading more than a few dozen points
     *                                  at a time due to HTTP request payload
     *                                  restrictions, so bigger reads will be
     *                                  broken up into 50-point groups.
     *                                  The size can be tuned here.
     *
     * The request is always sent as an HTTP POST with the query encoded as a grid
     * in the request body, so the point ids never appear in the URL. This avoids
     * HTTP 414 "URI Too Long" for large multi-point reads. The server returns the
     * same grid it would for the GET form.
     *
     * @returns Promise that resolves to the raw grid.
     */
    hisRead(ids, from, to, batchSize=50) {
        let range;

        if (to !== undefined) {
            /* Full range given, both from and to *must* be Dates */
            if (!(from instanceof Date)) {
                throw new Error('`from` is not a Date');
            }

            if (!(to instanceof Date)) {
                throw new Error('`to` is not a Date');
            }

            range = from.toHSZINC() + ',' + to.toHSZINC();
        }
        else {
            range = from;
        }

        if (!(Array.isArray(ids))) {
            ids = [ids];
        }

        /* Normalise the IDs into standard form. `range` is deliberately left
         * un-encoded here: `_hisRead` encodes it per transport (an HSZINC query
         * parameter for GET, or an HSJSON grid value for POST). */
        ids = ids.map(function (id) {
            return (new data.Ref(id)).toHSJSON();
        });

        if (ids.length < batchSize) {
            /* Small hisRead, handle as normal */
            return this._hisRead(ids, range);
        }

        /* Group the IDs into blocks */
        const reads = [];
        let offset = 0;

        while (offset < ids.length) {
            const block = ids.slice(offset, offset + batchSize);

            reads.push(block);
            offset += block.length;
        }

        /* Assemble the overall result */
        const result = {
            meta: {
                ver: '2.0',
                hisStart: null,
                hisEnd: null
            },
            cols: [
                {name: 'ts'}
            ],
            rows: []
        };

        const status = {
            hisStart: null,
            hisEnd: null,
            rowTs: {},
            colId: {}
        };

        /* Enumerate the columns */
        for (let i = 0; i < ids.length; i++) {
            status.colId[ids[i]] = i;
            result.cols.push({
                name: 'v' + i,
                id: ids[i]
            });
        }

        /* Execute the reads */
        return Promise.all(
            reads.map((block_ids) => {
                return this._hisRead(block_ids, range).then((block_res) => {
                    this._mergeHisReadRes(result, status, block_ids, block_res);
                });
            })
        ).then(() => {
            /* Assemble all the rows */
            let times = Object.keys(status.rowTs).map((ts) => {
                return parseInt(ts);
            });
            times.sort();

            result.rows = times.map(function (ts) {
                return status.rowTs[ts];
            });

            /* Return the merged result */
            return result;
        });
    };

    _mergeHisReadRes(result, status, blockIds, blockRes) {
        /* Merge the header */

        let this_start = data.parse(blockRes.meta.hisStart);
        let this_end = data.parse(blockRes.meta.hisEnd);

        /*
         * Defensive programming: docs say hisStart/hisEnd can be 'm:'
         * and we really shouldn't "trust" the inputs in something
         * that comes from "outside" anyway.
         */

        if ((this_start != null) && (this_start instanceof Date)) {
            /* Is this_start earlier than status.hisStart? */
            this_start = this_start.valueOf();
            if ((status.hisStart == null) || (status.hisStart > this_start)) {
                status.hisStart = this_start;
                result.meta.hisStart = blockRes.meta.hisStart;
            }
        }

        if ((this_end != null) && (this_end instanceof Date)) {
            /* Is this_end later than status.hisStart? */
            this_end = this_end.valueOf();
            if ((status.hisEnd == null) || (status.hisEnd < this_end)) {
                status.hisEnd = this_end;
                result.meta.hisEnd = blockRes.meta.hisEnd;
            }
        }

        /* Are there other fields to merge?  (for future expansion) */

        for (const field in blockRes.meta) {
            if (!result.meta.hasOwnProperty(field)) {
                result.meta[field] = blockRes.meta[field];
            }
        }

        /* Now, merge the data */

        for (let r = 0; r < blockRes.rows.length; r++) {
            const in_row = blockRes.rows[r];
            let ts = data.parse(in_row.ts);

            /* Sanity check, `ts` must be a Date */
            if ((ts == null) || !(ts instanceof Date)) {
                throw new Error(
                    'Expected date/time for ts column, got: ' + in_row.ts
                );
            }

            /* Extract ms time */
            ts = ts.valueOf();
            let out_row;

            if (status.rowTs.hasOwnProperty(ts)) {
                out_row = status.rowTs[ts];
            }
            else {
                out_row = {ts: in_row.ts};
                status.rowTs[ts] = out_row;
            }

            /* Copy the columns in */
            for (let c = 0; c < blockIds.length; c++) {
                const val = in_row['v' + c];

                if (val != null) {
                    const id = blockIds[c];
                    const col = status.colId[id];

                    if (col == null) {
                        throw new Error('Unexpected ID ' + id);
                    }

                    out_row['v' + col] = val;
                }
            }
        }
    };

    _hisRead(ids, range) {
        /* Encode the query as a single-row grid in the request body (POST), so the
         * point ids never appear in the URL. This avoids HTTP 414 "URI Too Long"
         * for large multi-point reads. The server returns the same grid shape as
         * the legacy GET form (ts + v0..vN columns), so response merging and callers
         * are unchanged. `ids` are already HSJSON refs (`r:<id>`); `range` is a Str,
         * encoded here as `s:<range>`. */
        const row = { range: range.toHSJSON() };
        if (ids.length === 1) {
            row.id = ids[0];
        }
        else {
            ids.forEach((id, idx) => {
                row['id' + idx] = id;
            });
        }

        return this.submitRequest(
            'POST',
            '/api/hisRead',
            {
                meta: {ver: '2.0'},
                cols: Object.keys(row).map((name) => ({name})),
                rows: [row]
            }
        );
    };

    /**
     * Perform a history write request.
     *
     * @param   records     Records to be written keyed by timestamp (object)
     *                      Each record value should map the point to its value
     *                      for that time record. Records should have the format of:
     *                      {
     *                          <time>: {
     *                              <id>: <valueToBeWritten>,
     *                              ...
     *                          },
     *                          ...
     *                      }
     *                      where each of the '<>' values are in HayStack format.
     * @returns Promise that resolves to the raw grid.
     */
    hisWrite(records) {
        const cols = {}, outCols = [{name: 'ts'}];
        const rows = Object.keys(records).map(function (ts) {
            const rec = records[ts];
            const row = {ts: ts};

            Object.keys(rec).sort().forEach((id) => {
                /* Determine column */
                let col = cols[id];
                if (col === undefined) {
                    col = 'v' + (outCols.length - 1);
                    outCols.push({name: col, id: id});
                    cols[id] = col;
                }

                /* Insert */
                row[col] = rec[id];
            });

            return row;
        }).sort((r1, r2) => {
            /*
             * This function is at the mercy of the sorting algorithm
             * so is not guaranteed to use all code paths.
             */
            if (r1.ts < r2.ts)
                return -1;
            /* istanbul ignore next */
            if (r1.ts > r2.ts)
                return 1;
            /* istanbul ignore next */
            return 0
        });

        return this.submitRequest(
            'POST',
            '/api/hisWrite',
            {
                meta: {ver: '2.0'},
                cols: outCols,
                rows: rows
            }
        );
    };

    /**
     *
     * @param id (string) Identifier of the object point.
     * @param ts (string) Timestamp which the upload will perform against the object point.
     * @param file (string|buffer) The upload target, this can either be an absolute file path or a buffer.
     * @param filename (string) Name of the upload.
     * @param mediaType (string) Media type of the upload. (e.g. pdf = application/pdf)
     * @param inlineRetrieval (boolean) Optional. When true, client that supports the HTTP header contentDisposition will
     *                                 render the uploaded file on the screen instead of presenting the
     *                                 'Save as' dialog. If nothing is set then true is assumed.
     * @param cacheMaxAge (number) Optional. The number of seconds a client, that supports the HTTP header CacheMaxAge,
     *                             should store the retrieved file (stored in this op)
     *                             in cache before re-downloading it again.
     * @param force (boolean) Optional. When true, the server will forcefully overwrite a previously stored file that shares
     *                        the same given ts. Default is false.
     * @param tags (object) Optional. An object consisting of additional file tags that will go with the upload.
     *                      Key of the object is the tagName while value is its tagValue.
     *                      E.g. { 'UploadedBy': 'AuthorABC'}
     */
    fileUpload (id,
                ts,
                file,
                filename,
                mediaType,
                inlineRetrieval=true,
                cacheMaxAge=1800,       // 30 minutes
                force=false,
                tags={}) {

        if (typeof file === 'string') {
            // Assume an absolute file path
            file = fs.createReadStream(file);
        }
        else if (Buffer.isBuffer(file)) {
            // buffer is ok
        }
        else {
            throw new Error('File can only be a buffer or an absolute file path (string).');
        }

        if (typeof filename !== 'string') {
            throw new Error('File name must be a string.');
        }

        if (typeof force !== 'boolean') {
            throw new Error('Force must be of type boolean.');
        }

        if (typeof inlineRetrieval !== 'boolean') {
            throw new Error('InlineRetrieval must be of type boolean.');
        }

        if (typeof cacheMaxAge !== 'number') {
            throw new Error('CacheMaxAge must be of type number.');
        }
        else {
            if (cacheMaxAge < 0) {
                throw new Error('CacheMaxAge must be more than or equals to 0.');
            }
        }

        if (typeof tags !== 'object') {
            throw new Error(`Tags must be an object not ${typeof tags}.`);
        }

        const requestTags = [];

        const tagKeys = Object.keys(tags);
        for (let index = 0; index < tagKeys.length; index++) {
            const tagKey = tagKeys[index];
            const tagVal = tags[tagKey];

            if (typeof tagVal !== 'string') {
                throw new Error('Tag value for key ' + tagKey + ' must be string.');
            }

            requestTags.push(`${tagKey}=${tagVal}`);
        }

        let contentDisposition = inlineRetrieval ? 'inline': 'attachment';
        if (!inlineRetrieval && filename) {
            // e.g. attachment; filename="myPDF.pdf"
            contentDisposition += '; filename="' + filename + "'";
        }

        // Create form
        const formData = new FormData();
        const form = {
            'id': id,
            'ts': ts,
            'data': file,
            'force': force.toString(),
            'cacheMaxAge': cacheMaxAge.toString(),
            'contentDisposition': contentDisposition,
            'tags': JSON.stringify(requestTags)
        };

        for (const [key, value] of Object.entries(form)) {
            if (key === 'data') {
                // formdata needs to know the mimetype of the File or Buffer
                // the mimetype is derived automatically by looking at the given filename.
                // MimeType is required or otherwise it will be disregarded and not sent to API server
                formData.append(key, value, {
                    filename,
                    'contentType': mediaType
                });
            }
            else {
                formData.append(key, value);
            }
        }

        return this.submitRequest(
            'PUT',
            '/api/file/storage',
            formData,
            {
                headers: {
                    'content-type': 'multipart/form-data'
                }
            }
        );
    }

    /**
     * Delete a set of files given a point id and time range.
     * Returning an object keyed by the requested point id,
     * where the value is an array of objects containing the file uuid and time.
     *
     * Return example:
     * [
     *       {
     *           "pointId": 'ff681fb8-cc87-4982-9139-1faafa173dcd',
     *           "removed": [
     *               {
     *                   "time": '2034-02-12T08:00:00.000Z',
     *                   "fileId": '347a4d75-3a5e-4cd3-8925-e0a3d2521f8c'
     *               }
     *           ]
     *       }
     *   ]
     *
     * @param   {string} pointId   The point id of the point a file is attached to.
     *                             The point must be `kind=File`
     * @param   {Date} start  Starting ISO8601 timestamp to delete files from.
     * @param   {Date} end    Ending ISO8601 timestamp to delete files from.
     *
     * @returns {Promise<Array<{pointId: string, removed: Array<{time: string, fileId: string}>}>>}
     *
     */
    fileDelete (pointId, start, end) {

        if(!pointId) {
            throw new Error("Missing point id input for file delete.");
        }

        if (!start) {
            throw new Error("Missing start date input for file delete.");
        }

        if (!end) {
            throw new Error("Missing end date input for file delete.");
        }

        if (["last", "first", "today", "yesterday"].includes(start) ||
            ["last", "first", "today", "yesterday"].includes(end)) {
            throw new Error("File delete does not support " +
                "input that is not in date format (YYYY-MM-DD).");
        }

        const mStart = moment(start);
        const mEnd = moment(end);

        if (mStart.isValid() !== true) {
            throw new Error('Start date ' + start + ' is not a valid date.');
        }

        if (mEnd.isValid() !== true) {
            throw new Error('End date ' + end + ' is not a valid date.');
        }

        return this.submitRequest(
            'DELETE',
            '/api/file/storage',
            {},
            {
                params: {
                    id: pointId,
                    start: mStart.utc().format(MOMENT_FORMAT_MS_PRECISION),
                    end: mEnd.utc().format(MOMENT_FORMAT_MS_PRECISION),
                }
            }
        );
    }

    /**
     * Retrieve a previously stored file the configured WideSky server.
     * This API will return an object keyed by the requested point ids,
     * where the value is an array of file URLs which can be used to retrieve
     * the file data via the HTTP GET method.
     *
     * Date inputs for this function is the standard ISO8601 dates.
     * Examples:
     * 2022-03-30T11:30:00Z
     * 2022-07-26T11:00:00+02:00
     *
     * @param   pointIds      (string)    The file point identifier, one with kind=File
     *                        (array)     An array of file point identifiers in string.
     * @param   from          (date)      Starting ISO8601 timestamp of the retrieve.
     * @param   to            (date)      Ending ISO8601 timestamp of the retrieve.
     * @param   presigned     (boolean)   Flag for indicating if the returned URL should be presigned.
     * @param   presignExpiry (number)    Duration in seconds where the presigned link will expire.
     *
     *
     * @returns Promise that resolves to the following format.
     * [
     *     {
     *         pointId: c7bd64d9-0a72-4584-945a-c667081c97f6,
     *         urls: [
     *             time: 2087911800,
     *             value: https://abc.on.widesky.cloud/api/file/storage/2087911800_zxcvbn...
     *         ]
     *     }
     * ]
     */
    fileRetrieve(pointIds, from, to, presigned=true, presignExpiry=1800) {
        if (!(Array.isArray(pointIds))) {
            if (typeof pointIds !== 'string') {
                throw new Error(`Point id ${pointIds} must be a string.`);
            } else {
                pointIds = [pointIds];
            }
        }
        else {
            for (let index = 0; index < pointIds.length; index++) {
                if (typeof pointIds[index] !== 'string') {
                    throw new Error('Point id ' + pointIds[index] + ' must be string.');
                }
            }
        }

        const mFrom = moment(from);
        if (mFrom.isValid() !== true) {
            throw new Error('From date ' + from + ' is not a valid date.');
        }

        const mTo = moment(to);
        if (mTo.isValid() !== true) {
            throw new Error('To date ' + from + ' is not a valid date.');
        }

        if (mFrom.valueOf() === mTo.valueOf()) {
            // User probably meant at the point in time.
            // Push the 'to' datetime by 1 ms later so WideSky will match something, otherwise
            // such query is going to return nothing.
            mTo.add(1, 'ms');
        }

        if (typeof presigned !== 'boolean') {
            throw new Error('Presigned flag must be a boolean value.');
        }
        else if (presigned === true) {
            if (typeof presignExpiry !== 'number') {
                throw new Error('PresignExpiry value ' + presignExpiry + ' must be a number');
            }
            else if (presignExpiry < 0) {
                throw new Error('PresignExpiry value ' + presignExpiry + ' must be greater than zero.');
            }
        }

        return this.submitRequest(
            'GET',
            '/api/file/storage',
            {},
            {
                params: {
                    pointIds: JSON.stringify(pointIds),
                    from: mFrom.utc().format(MOMENT_FORMAT_MS_PRECISION),
                    to: mTo.utc().format(MOMENT_FORMAT_MS_PRECISION),
                    presigned: presigned.toString(),
                    presignExpiry: presignExpiry.toString()
                }
            }
        );
    }

    /**
     * Initiate a haystack watchSub op based on the given list of point ids
     * @param {*} pointIds String or Array. The point Ids to perform watchSub on.
     * @param {string} lease Duration (ms) the watch will exist
     * @param {string} description A short description for the watch session
     * @param {Object} config Configuration options used in `submitRequest()`
     * @returns Promise that resolves to a watch object.
     */
    watchSub(pointIds, lease, description, config = {}) {
        if (!(Array.isArray(pointIds))) {
            pointIds = [pointIds];
        }

        const rows = pointIds.map((id) => {
            return {id: `r:${id}`};
        });

        return this.submitRequest(
            'POST',
            '/api/watchSub',
            {
                meta: {
                    ver: '2.0',
                    watchDis: `s:${description}`,
                    lease: lease
                },
                cols: [
                    {name: 'id'}
                ],
                rows: rows
            },
            config
        );
    }

    /**
     * Initiate a haystack watchSub op to extend a watch given the watchId
     * and lease.
     * @param {string} watchId ID of the opened watch.
     * @param {*} pointIds String or Array. The points.
     * @param {string} lease Duration (ms) the watch was created with.
     * @param {Object} config Configuration options used in `submitRequest()`
     * @returns Promise
     */
    watchExtend(watchId, pointIds, lease, config = {}) {
        if (!(Array.isArray(pointIds))) {
            pointIds = [pointIds];
        }

        const rows = pointIds.map((id) => {
            return {id: `r:${id}`};
        });

        return this.submitRequest(
            'POST',
            '/api/watchSub',
            {
                meta: {
                    ver: '2.0',
                    watchId: `s:${watchId}`,
                    lease: lease
                },
                cols: [{name: 'id'}],
                rows: rows
            },
            config
        );
    }

    /**
     * Initiate a watchUnsub op using the given watchId.
     * If deletePointIds is set, then the listed points will be removed
     * from the watch.
     * @param {string} watchId ID of the opened watch.
     * @param {*} deletePointIds String or Array. The points to be deleted.
     * @param {boolean} close If true, the watch session will be closed.
     * @param {Object} config Configuration options used in `submitRequest()`
     * @returns Promise
     */
    watchUnsub(watchId, deletePointIds, close = true, config = {}) {
        if (!(Array.isArray(deletePointIds))) {
            deletePointIds = [deletePointIds];
        }

        const payload = {
            meta: {
                ver: '2.0',
                watchId: `s:` + watchId,
            },
            cols: [],
            rows: []
        };

        if (deletePointIds.length > 0) {
            payload.cols.push({name: 'id'});

            for (let index = 0; index < deletePointIds.length; index++) {
                payload.rows.push({id: 'r:' + deletePointIds[index]});
            }
        }
        else {
            payload.cols.push({name: 'empty'});
        }

        if (close) {
            payload.meta['close'] = 'm:';
        }

        return this.submitRequest(
            'POST',
            '/api/watchUnsub',
            payload,
            config
        );
    }

    /**
     * Initiate a watch socket object given a valid watch ID string.
     * @param {string} watchId the watch ID string.
     * @returns a socket.io Socket object.
     */
    getWatchSocket(watchId) {
        const tokens = this.getToken();
        const accessToken = tokens.access_token;

        const parsedUrl = new Url(this.baseUri);
        const baseUrl = `${parsedUrl.protocol}//${parsedUrl.host}`;
        const url = `${baseUrl}/${watchId}`;

        let subPath = '';
        if (parsedUrl.pathname && parsedUrl.pathname !== '/') {
            subPath = parsedUrl.pathname;
        }

        this.logger.debug(
            `baseUrl: "${baseUrl}", subPath: "${subPath}", nsp: "${watchId}"`
        );

        return socket.connect(url, {
            query: { Authorization: accessToken },
            'force new connection': true,
            autoConnect: false,
            /* Reconnection pacing (-lpa.2, hot-loop audit H2): socket.io's
             * defaults (1 s delay, 5 s ceiling) turn a server-side rejection
             * or outage into a fast reconnect flap (measured ~6 MB/h per
             * denied device: every attempt is a full TLS + engine.io
             * handshake carrying the token). Base 5 s, ceiling 5 min, with
             * the default 0.5 randomization so a fleet does not retry in
             * lockstep. Values shared with PublisherSession / ControlSession. */
            reconnectionDelay: PublisherSession.RECONNECTION_DELAY_MS,
            reconnectionDelayMax: PublisherSession.RECONNECTION_DELAY_MAX_MS,
            randomizationFactor: 0.5,
            path: `${subPath}/socket.io`
        });
    }

    /**
     * Create a realtime publisher session for cur-ingress over WebSocket.
     *
     * The returned PublisherSession registers a publisher watch over REST
     * (watchPub), opens a socket.io connection to the watch namespace using the
     * same token handshake as getWatchSocket, emits pointUpdate frames, and
     * surfaces pointCadence / pointUpdateError events. See
     * docs/design/realtime-publisher.md §5, §7.
     *
     * @param {Object} [options]  Session options forwarded to PublisherSession,
     *                            e.g. { autoRecover: false } to opt out of the
     *                            built-in socket-loss recovery, or
     *                            { perMessageDeflate: { threshold: 100 } } to
     *                            tune outbound frame compression (engine.io's
     *                            default 1024-byte threshold leaves small frames
     *                            uncompressed).
     * @returns {PublisherSession} A new, unregistered publisher session bound to
     *                             this client.
     */
    createPublisher(options) {
        return new PublisherSession(this, options);
    }

    /**
     * Create a realtime control-command listener session.
     *
     * The returned ControlSession registers a control listener over REST
     * (controlSub), connects a socket (or reuses an owning publisher's socket
     * when the server returns a shared registration), surfaces inbound
     * pointWrite commands as 'command' events, and settles them with
     * reportWrite(). It raises no publisher demand and receives no point value
     * data. See docs/design/realtime-publisher.md.
     *
     * @param {Object} [options]  Session options forwarded to ControlSession,
     *                            e.g. { publisher } to reuse a publisher session's
     *                            socket for a shared registration, or
     *                            { autoRecover: false } to opt out of socket-loss
     *                            recovery.
     * @returns {ControlSession} A new, unregistered control listener session
     *                           bound to this client.
     */
    createControlListener(options) {
        return new ControlSession(this, options);
    }

    /**
     * Create a lease auto-renewer for a consumer watch.
     *
     * /api/watchPoll renews a watch's lease server-side as a side effect of
     * polling, so a polling consumer never needs explicit renewal. A socket-style
     * consumer (watchSub + getWatchSocket, no watchPoll) gets no special lease
     * treatment and its watch expires when the lease lapses even while the socket
     * stays connected. The returned renewer re-issues watchSub with the watchId
     * (watchExtend) at half the lease until stopped.
     *
     * @param {Object} opts  { watchId, pointIds, lease, leaseMs?, renewFraction?,
     *                         onError? } — see ConsumerWatchRenewer.
     * @returns {ConsumerWatchRenewer} A new, unstarted renewer bound to this
     *                                 client; call start() to begin renewing.
     */
    createWatchRenewer(opts) {
        return new ConsumerWatchRenewer(this, opts);
    }

    /**
     * Perform a history delete request.
     * @param {*} ids An array of point entity UUIDs for the delete operations or a single string.
     * @param {String} range A valid hisRead range string.
     * @returns Promise that resoves into haystack response grid.
     */
    hisDelete(ids, range) {
        // If id was given as string, put in array.
        if (!Array.isArray(ids)) {
            ids = [ids];
        }

        if (!(ids.length > 0)) {
            throw new Error('`ids` must contain at least one point UUID.');
        }

        // Validate the range
        const range_err = 'An invalid hisRead range input was given: ';
        if (!range.startsWith('s:')) {
            throw new Error(range_err + 'Missing `s:`.');
        }

        const range_val = range.replace('s:', '');
        if (range_val === '') {
            throw new Error(range_err + 'No range was given.');
        }

        if (!(range_val === 'last' ||
              range_val === 'first' ||
              range_val === 'today' ||
              range_val === 'yesterday')) {

            if (range_val.includes(',')) {
                const ranges = range_val.split(',');

                // Should not be more or less than 2 date(time) values in a range.
                if (ranges.length !== 2) {
                    throw new Error(range_err + 'Number of timestamps cannot exceed 2.');
                }

                for (const ts in ranges) {
                    if (ranges[ts].includes(' ')) {
                        ranges[ts] = ranges[ts].trimStart().split(' ')[0];
                    }
                    if (!moment(ranges[ts].trim(), moment.ISO_8601).isValid()) {
                        throw new Error(range_err + 'Invalid ISO8601 timestamp.');
                    }
                }

            } else {
                if (!moment(range_val, moment.ISO_8601).isValid()) {
                    throw new Error(range_err + 'Invalid ISO8601 timestamp.');
                }
            }
        }

        // Normalise the IDs into standard form
        ids = ids.map(function (id) {
            return new data.Ref(id).toHSJSON();
        });

        // Build request body
        const payload = {
            meta: {
                ver: '2.0',
            },
            cols: [
                {
                    name: 'range',
                },
            ],
            rows: [
                {
                    range: range,
                },
            ],
        };

        if (ids.length === 1) {
            payload.rows[0].id = new data.Ref(ids[0]).toHSJSON();
            payload.cols.push({name: 'id'});
        } else {
            ids.forEach((id, idx) => {
                payload.rows[0]['id' + idx] = new data.Ref(id).toHSJSON();
                payload.cols.push({name: 'id' + idx});
            });
        }

        return this.submitRequest('POST', '/api/hisDelete', payload, {});
    }

    /**
     * Get the number of entities to be returned from a filter.
     * @param filter Filter to select entities.
     * @returns {Promise<*>} Number of entities found.
     */
    async entityCount(filter) {
        const query = `
{
  haystack {
    search(filter: "${filter.replaceAll('"', '\\"')}", limit: 0) {
      count
    }
  }
}
`;
        return Number((await this.query(query)).data.haystack.search.count);
    }

    /**
     * Perform a read by filter but only return the IDs of the entities found.
     * @param filter Filter to select entities.
     * @param limit Limit to be imposed on the given filter.
     * @returns {Promise<*>} A list of UUID's of all entities found.
     */
    async findAsId(filter, limit=0) {
        const query = `
{
  haystack {
    search(filter: "${filter.replaceAll('"', '\\"')}", limit: ${limit}) {
      entity {
        id
      }
    }
  }
}
`;
        return (await this.query(query)).data.haystack.search.entity
            .map((entity) => entity.id);
    }
}


// attach for testing
WideSkyClient.initLogger = initLogger;
/**
 * Test-only re-export of the impersonation-join bypass Symbol (N13).
 *
 * The Symbol itself is module-private; tests need it to assert that the
 * lookup helper's bypass flag propagates through the request config.
 *
 * **Internal. Do NOT use externally.** Public callers that set this on a
 * `submitRequest` config will silently bypass the in-flight lookup join
 * and may issue un-impersonated requests. This static is exposed only so
 * the unit tests in `test/client/internals/impersonateAsEmail.js` can
 * round-trip the Symbol without exporting it from the module surface.
 */
WideSkyClient._skipImpersonateJoinSymbol = SKIP_IMPERSONATE_JOIN;

/* Exported symbols */
module.exports = WideSkyClient;
