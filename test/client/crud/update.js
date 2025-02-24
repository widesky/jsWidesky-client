/*
 * vim: set tw=78 et ts=4 sw=4 si fileencoding=utf-8:
 *
 * Unit tests for client CRUD methods
 */
"use strict";

const stubs = require('../../stubs'),
    sinon = require('sinon'),
    expect = require('chai').expect,
    WS_ACCESS_TOKEN = stubs.WS_ACCESS_TOKEN,
    WS_REFRESH_TOKEN = stubs.WS_REFRESH_TOKEN,
    getInstance = stubs.getInstance;
const {verifyRequestCall} = require("./../utils");

describe('client', () => {
    let ws, http, log;
    beforeEach(() => {
        http = new stubs.StubHTTPClient();
        log = new stubs.StubLogger();
        ws = getInstance(http, log);
    });

    describe('update', () => {
        beforeEach(() => {
            // Correct spy for function _wsRawSubmit()
            ws._wsRawSubmit = sinon.stub().callsFake((method, uri, body, config) => {
                if (uri === "/oauth2/token") {
                    return Promise.resolve({
                        access_token: WS_ACCESS_TOKEN,
                        refresh_token: WS_REFRESH_TOKEN,
                        expires_in: Date.now() + 2000
                    });
                } else if (uri === "/api/updateRec") {
                    return Promise.resolve("Grid goes here");
                } else {
                    return Promise.reject("Did not expect to go this path");
                }
            });
        });

        afterEach(() => {
            ws._wsRawSubmit.reset();
        });

        it('should generate updateRec request', async () => {
            const res = await ws.update({
                name: "s:testing",
                c: "n:1234",
                dis: "s:My test entity",
                b: true,
                a: "s:test",
                id: "r:cf60bce8-da3b-4c96-a4f8-f7a6580ede09"
            });
            expect(res).to.equal("Grid goes here");

            expect(ws._wsRawSubmit.callCount).to.equal(2);
            verifyRequestCall(
                ws._wsRawSubmit.secondCall.args,
                "POST",
                "/api/updateRec",
                {
                    meta: {ver: "2.0"},
                    cols: [
                        /*
                         * `id`, `name` and `dis` will be first.
                         */
                        {name: "id"},
                        {name: "name"},
                        {name: "dis"},
                        {name: "a"},
                        {name: "b"},
                        {name: "c"}
                    ],
                    rows: [
                        {
                            id: "r:cf60bce8-da3b-4c96-a4f8-f7a6580ede09",
                            a: "s:test", b: true, c: "n:1234",
                            dis: "s:My test entity", name: "s:testing"
                        }
                    ]
                },
                {
                    headers: {
                        Authorization: `Bearer ${WS_ACCESS_TOKEN}`,
                        Accept: "application/json"
                    },
                    decompress: true
                }
            );
        });

        it('should require `id`', async () => {
            try {
                await ws.update({
                    name: "s:testing",
                    c: "n:1234",
                    dis: "s:My test entity",
                    b: true,
                    a: "s:test",
                });
                throw new Error('This should not have worked');
            } catch (err) {
                expect(err.message).to.equal("id is missing");
            }
        });
    });
});