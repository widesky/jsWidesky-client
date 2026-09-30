/*
 * vim: set tw=100 et ts=4 sw=4 si fileencoding=utf-8:
 * © 2026 WideSky.Cloud Pty Ltd
 * SPDX-License-Identifier: MIT
 */
"use strict";

/**
 * Oracle test for batch.hisDelete (CORE-9209) against a LIVE apiserver stack.
 *
 * Every scenario seeds two identical point sets, X and Y. X is deleted with batch.hisDelete;
 * Y with ONE plain client.hisDelete of the same range, which is the server's own semantics.
 * Surviving rows must match exactly, including rows 1 ms either side of the range.
 *
 * SKIPPED unless WS_E2E_URL is set. Run:
 *   WS_E2E_URL=http://localhost:3000 WS_E2E_USER=... WS_E2E_PASS=... \
 *   WS_E2E_CLIENT_ID=... WS_E2E_CLIENT_SECRET=... npx mocha --timeout 600000 test/integration/hisDelete-e2e.js
 */

const expect = require("chai").expect;
const { WideSkyClient } = require("../../index");
const HisWritePayload = require("../../src/utils/hisWritePayload");

const WS_E2E_URL = process.env.WS_E2E_URL;
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const SITE = "jsclient_hisdelete_e2e";
const EQUIP = `${SITE}.plantroom`;

const makeClient = () => new WideSkyClient(WS_E2E_URL, process.env.WS_E2E_USER, process.env.WS_E2E_PASS,
    process.env.WS_E2E_CLIENT_ID, process.env.WS_E2E_CLIENT_SECRET, { level: "error" });
const bareId = (raw) => raw.substring(2).split(" ")[0];

async function resolve(ws, fqname) {
    const rows = ((await ws.find(`id==@${fqname}`, 0)) || {}).rows || [];
    return rows.length === 1 ? bareId(rows[0].id) : null;
}

async function ensurePoint(ws, name, tz) {
    if (!(await resolve(ws, SITE))) {
        await ws.create({ name: `s:${SITE}`, dis: "s:hisDelete E2E Site", site: "m:", tz: "s:Brisbane" });
    }
    if (!(await resolve(ws, EQUIP))) {
        await ws.create({ name: "s:plantroom", dis: "s:Plant Room", equip: "m:", siteRef: `r:${SITE}`, tz: "s:Brisbane" });
    }
    const fq = `${EQUIP}.${name}`;
    if (!(await resolve(ws, fq))) {
        await ws.create({ name: `s:${name}`, dis: `s:${name}`, point: "m:", his: "m:", kind: "s:Number",
            unit: "s:°C", equipRef: `r:${EQUIP}`, siteRef: `r:${SITE}`, tz: `s:${tz}` });
    }
    return resolve(ws, fq);
}

async function wipe(ws, id) {
    await ws.hisDelete([id], "s:2000-01-01T00:00:00Z,2100-01-01T00:00:00Z");
}

async function seed(ws, id, timestamps) {
    for (let i = 0; i < timestamps.length; i += 10000) {
        const payload = new HisWritePayload();
        payload.add(`r:${id}`, timestamps.slice(i, i + 10000).map((ms) => ({ ts: `t:${new Date(ms).toISOString()} UTC`, val: "n:1" })));
        const res = await ws.batch.hisWrite(payload);
        if (res.errors.length) throw new Error(`seed failed: ${res.errors[0].error}`);
    }
}

async function readAll(ws, id) {
    const res = await ws.batch.hisRead([id], new Date("2000-01-01T00:00:00Z"), new Date("2100-01-01T00:00:00Z"), { batchSize: 1 });
    if (res.errors.length) throw new Error(`read failed: ${res.errors[0].error}`);
    return (res.success[0] || []).map((r) => Date.parse(r.ts.substring(2).split(" ")[0])).sort((a, b) => a - b);
}

const every = (fromMs, count, stepMs) => Array.from({ length: count }, (_, i) => fromMs + i * stepMs);

// Shapes from spec 9.2, anchored at a range start/end in UTC ms.
function shapes(startMs, endMs) {
    const edges = [startMs - 1, startMs, endMs, endMs + 1];
    return {
        a_minute_3d: [...every(startMs, 3 * 1440, MIN), ...edges],
        b_sparse_gap: [...every(startMs, 12, HOUR), ...every(startMs + 2 * DAY + 12 * HOUR, 12, HOUR), ...edges],
        c_burst: [...every(startMs + DAY + 5 * HOUR, 3600, 1000), ...edges],
        ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`uniform_${i}`, [...every(startMs, 3 * 24, HOUR), ...edges]])),
    };
}

(WS_E2E_URL ? describe : describe.skip)("batch.hisDelete against a live stack", function () {
    this.timeout(600000);
    let ws;
    before(() => { ws = makeClient(); });

    async function scenario({ label, range, startMs, endMs, tz, options = {}, mutateAfterPlan }) {
        const shape = shapes(startMs, endMs);
        const names = Object.keys(shape);
        const X = {}, Y = {}, C = {};
        for (const n of names) {
            X[n] = await ensurePoint(ws, `${label}_x_${n}`, tz);
            Y[n] = await ensurePoint(ws, `${label}_y_${n}`, tz);
        }
        for (const n of ["control_1", "control_2"]) C[n] = await ensurePoint(ws, `${label}_${n}`, tz);
        for (const n of names) {
            for (const id of [X[n], Y[n]]) { await wipe(ws, id); await seed(ws, id, shape[n]); }
        }
        for (const id of Object.values(C)) { await wipe(ws, id); await seed(ws, id, shape.a_minute_3d); }
        const before = {};
        for (const n of names) before[n] = await readAll(ws, X[n]);
        const controlsBefore = {};
        for (const [n, id] of Object.entries(C)) controlsBefore[n] = await readAll(ws, id);

        // Recording wrapper: every delete request's range and ids, plus every URI.
        const seen = [];
        const raw = ws._wsRawSubmit.bind(ws);
        let firstDelete = true;
        ws._wsRawSubmit = async (method, uri, body, config) => {
            seen.push({ uri, body });
            if (uri === "/api/hisDelete" && firstDelete && mutateAfterPlan) { firstDelete = false; await mutateAfterPlan(X); }
            return raw(method, uri, body, config);
        };
        const res = await ws.batch.hisDelete(Object.values(X), range, options);
        ws._wsRawSubmit = raw;
        await ws.hisDelete(Object.values(Y), range.startsWith("s:") ? range : `s:${range}`);

        expect(res.errors, JSON.stringify(res.errors)).to.eql([]);
        for (const n of names) {
            const survivorsX = await readAll(ws, X[n]);
            const survivorsY = await readAll(ws, Y[n]);
            expect(survivorsX, `${label} ${n}: X vs oracle`).to.eql(survivorsY);                // assertion 2
            expect(survivorsX.length, `${label} ${n}: something deleted`).to.be.lessThan(before[n].length);
        }
        for (const [n, id] of Object.entries(C)) {
            expect(await readAll(ws, id), `${label} ${n}`).to.eql(controlsBefore[n]);           // assertion 3
        }
        expect(seen.some((s) => s.uri.includes("hisRead"))).to.equal(false);                    // assertion 4
        const deleteIds = seen.filter((s) => s.uri === "/api/hisDelete")
            .map((s) => Object.keys(s.body.rows[0]).filter((k) => /^id\d*$/.test(k)).length);
        expect(Math.max(...deleteIds)).to.be.at.most(options.batchSizeEntity || 10);
        return { X, Y, seen };
    }

    it("absolute UTC range", () => scenario({
        label: "utc", range: "2026-06-01T00:00:00Z,2026-06-04T00:00:00Z",
        startMs: Date.parse("2026-06-01T00:00:00Z"), endMs: Date.parse("2026-06-04T00:00:00Z"), tz: "Brisbane"
    }));

    it("tz-less date range (Brisbane points)", () => scenario({
        label: "tzl_bne", range: "2026-06-01,2026-06-03",
        startMs: Date.parse("2026-06-01T00:00:00+10:00"), endMs: Date.parse("2026-06-04T00:00:00+10:00"), tz: "Brisbane"
    }));

    it("tz-less date range (New York points)", () => scenario({
        label: "tzl_nyc", range: "2026-06-01,2026-06-03",
        startMs: Date.parse("2026-06-01T00:00:00-04:00"), endMs: Date.parse("2026-06-04T00:00:00-04:00"), tz: "New_York"
    }));

    it("end-inclusive date pair with offsets", () => scenario({
        label: "dates", range: "2026-06-01T00:00:00+10:00 Brisbane,2026-06-04T00:00:00+10:00 Brisbane",
        startMs: Date.parse("2026-06-01T00:00:00+10:00"), endMs: Date.parse("2026-06-04T00:00:00+10:00"), tz: "Brisbane"
    }));

    it("relative range (yesterday)", () => {
        const now = Date.now();
        const y = new Date(now - DAY); y.setUTCHours(0, 0, 0, 0);
        return scenario({ label: "rel", range: "yesterday", startMs: y.getTime() - 10 * HOUR, endMs: y.getTime() + 14 * HOUR, tz: "Brisbane" });
    });

    it("bisects when rows arrive after planning", () => scenario({
        label: "bisect", range: "2026-06-01T00:00:00Z,2026-06-04T00:00:00Z",
        startMs: Date.parse("2026-06-01T00:00:00Z"), endMs: Date.parse("2026-06-04T00:00:00Z"), tz: "Brisbane",
        options: { batchSize: 1500 },
        mutateAfterPlan: async (X) => seed(ws, X.c_burst, every(Date.parse("2026-06-02T05:00:00.500Z"), 3600, 1000))
    }));
});
