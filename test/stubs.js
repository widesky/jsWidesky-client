/*
 * vim: set tw=78 et ts=4 sw=4 si fileencoding=utf-8:
 *
 * Unit test stubs
 */
"use strict";

const sinon = require('sinon'),
    expect = require('chai').expect,
    WideSkyClient = require('../src/client/client');

const WS_URI = 'http://localhost:3000',
    WS_USER = 'user@example.com',
    WS_PASSWORD = 'password',
    WS_CLIENT_ID = 'client id string',
    WS_CLIENT_SECRET = 'client secret',
    WS_ACCESS_TOKEN = 'an access token',
    WS_REFRESH_TOKEN = 'a refresh token',
    WS_ACCESS_TOKEN2 = 'another access token',
    WS_REFRESH_TOKEN2 = 'another refresh token';

/**
 * StubLogger is a logger object that spoofs a Bunyan-style logger. Every
 * level reports itself enabled, as Bunyan's `log.debug()` does when called
 * with no arguments.
 */
const StubLogger = function() {
    const self = this;
    ['fatal','error','warn','info','debug','trace'].forEach((l) => {
        self[l] = sinon.stub().returns(true);
    });
    self.resetHistory = () => {
        ['fatal','error','warn','info','debug','trace'].forEach((l) => {
            self[l].resetHistory();
        });
    }
};

/**
 * StubHTTPStatusCodeError is a class that mimics the `StatusCodeError`
 * in `request-promise`.
 */
const StubHTTPStatusCodeError = function(message, statusCode) {
    Error.captureStackTrace(this, this.constructor);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.message = message;
};
require('util').inherits(StubHTTPStatusCodeError, Error);

/**
 * StubHTTPClient is a class that mimics `request-promise`'s interface whilst
 * providing a means to "spoof" a response as if a real HTTP request had been
 * made and the response returned.
 */
const StubHTTPClient = function() {
    const self = this;
    let handler = null;

    /**
     * Assign a new handler that will receive the request and generate the
     * expected response.  Handler is expected to take a simple `options`
     * object in the same manner as `request-promise` and either throw an
     * exception to terminate the test, or to return the expected data.
     *
     * See https://github.com/request/request-promise for an idea of how we
     * need to behave.  The WideSky client really doesn't use much.
     *
     * This may be replaced at any time.
     */
    self.setHandler = function(h) {
        handler = h;
    };

    /**
     * Stub a WideSkyClient instance with this HTTP client instance.
     */
    self.stubClient = function(ws) {
        ws._wsRawSubmit = sinon.spy((method, uri, body, config) => {
            if (uri === "/oauth2/token") {
                return Promise.resolve({
                    access_token: WS_ACCESS_TOKEN
                });
            }
            return Promise.resolve()
        });
    };
};

/**
 * Create a stubbed instance of WideSky Client for testing.
 * @param {Object} http An instance of a stub http client.
 * @param {Object} log An instance of a stub logger.
 * @param {Object} [opts] An object to override default options for client instance.
 * @returns An instance of the WideSky Client.
 */
const getInstance = function(http, log, override={}) {
    const options = { ...(override.options ?? {}) };
    if (override.clientOptions !== undefined) {
        options.client = override.clientOptions;
    }
    let c = new WideSkyClient(
        override.baseUrl ?? WS_URI,
        override.user ?? WS_USER,
        override.pass ?? WS_PASSWORD,
        override.clientId ?? WS_CLIENT_ID,
        override.clientSecret ?? WS_CLIENT_SECRET,
        log,
        undefined,
        options
    );
    http.stubClient(c);
    return c;
};

const authHandler = function(opts) {
    let body;
    opts = opts || {};

    if (opts.refresh) {
        body = {
            refresh_token: opts.expect_refresh_token || WS_REFRESH_TOKEN,
            grant_type: 'refresh_token'
        };
    } else {
        body = {
            username: opts.expect_user || WS_USER,
            password: opts.expect_password || WS_PASSWORD,
            grant_type: 'password'
        };
    }

    return (options) => {
        expect(options).to.eql({
            baseUrl: WS_URI,
            method: 'POST',
            uri: '/oauth2/token',
            auth: {
                username: WS_CLIENT_ID,
                password: WS_CLIENT_SECRET,
                sendImmediately: true
            },
            json: true,
            body: body
        });

        if (opts.err) {
            return Promise.reject(new (opts.err.errorClass || Error)(opts.err.message));
        } else {
            return Promise.resolve({
                access_token: opts.send_access_token || WS_ACCESS_TOKEN,
                refresh_token: opts.send_refresh_token || WS_REFRESH_TOKEN,
                expires_in: Date.now() + (opts.expires_in || 10)
            });
        }
    }
};

/* Exported symbols */
module.exports = Object.freeze({
    StubLogger,
    StubHTTPClient,
    StubHTTPStatusCodeError,
    getInstance,
    authHandler,
    /* Constants */
    WS_URI,
    WS_USER,
    WS_PASSWORD,
    WS_CLIENT_ID,
    WS_CLIENT_SECRET,
    WS_ACCESS_TOKEN,
    WS_REFRESH_TOKEN,
    WS_ACCESS_TOKEN2,
    WS_REFRESH_TOKEN2
});
