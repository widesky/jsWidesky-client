/*
 * vim: set tw=100 et ts=4 sw=4 si fileencoding=utf-8:
 * © 2026 WideSky.Cloud Pty Ltd
 * SPDX-License-Identifier: MIT
 */
"use strict";

/**
 * No credential may reach a log record, even at trace level.
 *
 * Drives the public client against a real local HTTP server with a Bunyan
 * logger capturing every record, through login, a successful request, a failed request and the two
 * password-carrying calls (createUser, updatePassword), then searches every
 * serialised record for the secrets.
 */
const http = require("http");
const bunyan = require("bunyan");
const { expect } = require("chai");
const { WideSkyClient } = require("../../../index");

const SECRETS = {
    password: "Pw-LEAKCHECK-7731",
    clientSecret: "CS-LEAKCHECK-5512",
    accessToken: "AT-LEAKCHECK-9001",
    refreshToken: "RT-LEAKCHECK-4410",
    newUserPassword: "NUP-LEAKCHECK-6620",
    changedPassword: "CHP-LEAKCHECK-1187"
};

function startServer() {
    const server = http.createServer((req, res) => {
        let body = "";
        req.on("data", (c) => body += c);
        req.on("end", () => {
            res.setHeader("content-type", "application/json");
            if (req.url === "/oauth2/token") {
                return res.end(JSON.stringify({
                    access_token: SECRETS.accessToken,
                    refresh_token: SECRETS.refreshToken,
                    token_type: "Bearer",
                    expires_in: Date.now() + 3600 * 1000
                }));
            }
            if (req.url.startsWith("/api/read") && body.includes("missingTag")) {
                res.statusCode = 400;
                return res.end(JSON.stringify({
                    meta: { ver: "2.0", err: "m:", dis: "s:Unknown filter: missingTag" }, cols: [], rows: []
                }));
            }
            res.end(JSON.stringify({ meta: { ver: "2.0" }, cols: [], rows: [] }));
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

describe("client logging: credential redaction", function () {
    this.timeout(10000);
    let server;

    before(async () => {
        server = await startServer();
    });
    after(() => new Promise((resolve) => server.close(resolve)));

    it("keeps tokens, the password and the client secret out of every record at trace", async () => {
        const records = [];
        const logger = bunyan.createLogger({
            name: "leak-check",
            level: "trace",
            streams: [{ type: "raw", level: "trace", stream: { write: (r) => records.push(r) } }]
        });
        const url = `http://127.0.0.1:${server.address().port}`;
        const ws = new WideSkyClient(url, "ops@example.com", SECRETS.password,
            "tEYQAFiAAmLrS2Dl", SECRETS.clientSecret, logger);

        await ws.find("site", 1);
        let failed = false;
        try {
            await ws.find("site and missingTag", 1);
        } catch (err) {
            failed = true;
        }

        await ws.createUser("new.operator@example.com", "New Operator", "created by leak check",
            ["00000000-c000-0000-0000-000000000000"], SECRETS.newUserPassword);
        await ws.updatePassword(SECRETS.changedPassword);

        expect(failed, "second request should have failed").to.equal(true);
        expect(records.length, "logger captured records").to.be.greaterThan(3);
        const text = JSON.stringify(records);
        for (const [name, value] of Object.entries(SECRETS)) {
            expect(text.includes(value), `${name} leaked into logs`).to.equal(false);
        }
    });
});
