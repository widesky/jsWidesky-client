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
const moment = require("moment-timezone");
const { WideSkyClient } = require("../../index");
const HisWritePayload = require("../../src/utils/hisWritePayload");

const WS_E2E_URL = process.env.WS_E2E_URL;
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const SITE = "jsclient_hisdelete_e2e";
const EQUIP = `${SITE}.plantroom`;
const RUN_ID = Date.now().toString(36);

const makeClient = () => new WideSkyClient(WS_E2E_URL, process.env.WS_E2E_USER, process.env.WS_E2E_PASS,
    process.env.WS_E2E_CLIENT_ID, process.env.WS_E2E_CLIENT_SECRET, { level: "error" });
const bareId = (raw) => raw.substring(2).split(" ")[0];

async function resolve(ws, fqname) {
    const rows = ((await ws.find(`id==@${fqname}`, 0)) || {}).rows || [];
    return rows.length === 1 ? bareId(rows[0].id) : null;
}

async function createPoint(ws, name, tz) {
    const fq = `${EQUIP}.${name}`;
    if (await resolve(ws, fq)) return resolve(ws, fq); // idempotent if exists
    if (!(await resolve(ws, SITE))) {
        await ws.create({ name: `s:${SITE}`, dis: "s:hisDelete E2E Site", site: "m:", tz: "s:Brisbane" });
    }
    if (!(await resolve(ws, EQUIP))) {
        await ws.create({ name: "s:plantroom", dis: "s:Plant Room", equip: "m:", siteRef: `r:${SITE}`, tz: "s:Brisbane" });
    }
    await ws.create({ name: `s:${name}`, dis: `s:${name}`, point: "m:", his: "m:", kind: "s:Number",
        unit: "s:°C", equipRef: `r:${EQUIP}`, siteRef: `r:${SITE}`, tz: `s:${tz}` });
    return resolve(ws, fq);
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

// Resolve a Haystack range string to [fromMs, toMs] in UTC, per the point's timezone.
// offset tokens: absolute UTC; tz-less: point's local timezone; date-only end: whole local day.
function resolveRange(range, pointTz) {
    const [startStr, endStr] = range.split(",");

    // Parse start: offset tokens absolute, tz-less in point's tz
    let fromMs;
    if (startStr.includes("T")) {
        // "2026-06-01T00:00:00Z" or with offset
        fromMs = Date.parse(startStr);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(startStr)) {
        // tz-less date: start of that day in point's tz
        fromMs = moment.tz(startStr, "YYYY-MM-DD", pointTz).valueOf();
    } else if (startStr === "yesterday") {
        // yesterday = previous day's start in point's tz
        fromMs = moment().tz(pointTz).subtract(1, "day").startOf("day").valueOf();
    } else {
        throw new Error(`Unhandled start token: ${startStr}`);
    }

    // Parse end: offset tokens absolute, tz-less date in point's tz (inclusive of that day)
    let toMs;
    if (endStr.includes("T")) {
        // "2026-06-04T00:00:00Z" or with offset
        toMs = Date.parse(endStr);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
        // tz-less date: start of next day (exclusive) in point's tz, so subtract 1ms for inclusive end
        toMs = moment.tz(endStr, "YYYY-MM-DD", pointTz).add(1, "day").valueOf() - 1;
    } else if (endStr === "yesterday") {
        // yesterday = previous day's end (start of current day) in point's tz
        toMs = moment().tz(pointTz).startOf("day").valueOf() - 1;
    } else {
        throw new Error(`Unhandled end token: ${endStr}`);
    }

    return [fromMs, toMs];
}

// Fixture builders for different scenarios.
function shapesRegular(startMs, endMs) {
    // 1 day of 1-minute data (1440 rows), plus edges
    const edges = [startMs - 1, startMs, endMs, endMs + 1];
    return {
        a_minute_1d: [...every(startMs, 1440, MIN), ...edges],
        b_sparse_gap: [...every(startMs, 12, HOUR), ...every(startMs + 12 * HOUR, 12, HOUR), ...edges],
        // 1200 rows at 250ms spacing (~5 min duration)
        c_burst: [...every(startMs + 5 * HOUR, 1200, 250), ...edges],
        ...Object.fromEntries(Array.from({ length: 9 }, (_, i) => [
            `uniform_${i}`,
            [...every(startMs, 72, HOUR), ...edges]
        ])),
    };
}

// For tz-less scenario: two 600-row bursts in first and last local hours, plus sparse background.
// Total in-range rows must stay <= 1500.
function shapesTzless(startMs, endMs, pointIdx) {
    // Two 600-row bursts at 250ms: one in first hour, one in last hour
    const burst1 = every(startMs + 10 * MIN, 600, 250); // 10min into first hour
    const burst2 = every(endMs - 15 * MIN, 600, 250);   // last 15 min of last hour
    // Background: ~250 rows spread across the range at irregular intervals
    // 3 days worth: place roughly 83 rows per day
    const day1Bg = every(startMs + 30 * MIN, 83, 30 * MIN);
    const day2Bg = every(startMs + DAY + 30 * MIN, 83, 30 * MIN);
    const day3Bg = every(startMs + 2 * DAY + 30 * MIN, 84, 30 * MIN);
    const bg = [...day1Bg, ...day2Bg, ...day3Bg];
    const edges = [startMs - 1, startMs, endMs, endMs + 1];
    const data = [...burst1, ...burst2, ...bg, ...edges].sort((a, b) => a - b);
    // Assert total is <= 1500 (should be ~1384 before edges)
    if (data.length > 1504) throw new Error(`tz-less shape exceeds 1504 rows: ${data.length}`);
    return data;
}

(WS_E2E_URL ? describe : describe.skip)("batch.hisDelete against a live stack", function () {
    this.timeout(600000);
    let ws;
    before(() => { ws = makeClient(); });

    async function scenario({ label, isTzless, range, startMs, endMs, tz, options = {}, mutateAfterPlan }) {
        // Default batchSize to 200 to force bisection in regular scenarios
        const opts = { batchSize: 200, ...options };

        // Compute startMs/endMs from range if not provided (for simple string ranges)
        if (!startMs || !endMs) {
            if (isTzless && range === "2026-06-01,2026-06-03") {
                // tz-less date range: 3 local days
                const tz_local = tz === "New_York" ? "America/New_York" : "Australia/Brisbane";
                startMs = moment.tz("2026-06-01", "YYYY-MM-DD", tz_local).valueOf();
                endMs = moment.tz("2026-06-04", "YYYY-MM-DD", tz_local).valueOf() - 1;
            } else if (range.includes("T")) {
                // UTC range
                const [s, e] = range.split(",");
                startMs = Date.parse(s);
                endMs = Date.parse(e);
            }
        }

        // Build shape: tz-less uses special 3-day shape with two bursts, others use regular 1-day shape
        const shape = isTzless ? shapesTzless(startMs, endMs, 0) : shapesRegular(startMs, endMs);
        const names = isTzless ? ["combined_data"] : Object.keys(shape);

        const X = {}, Y = {}, C = {};

        // Create fresh points with run ID appended
        if (isTzless) {
            // For tz-less: create 12 points alternating tz, plus controls
            for (let i = 0; i < 12; i++) {
                const pointTz = i % 2 === 0 ? "Brisbane" : "New_York";
                const n = `point_${i}`;
                const suffix = `_${label}_x_${n}_${RUN_ID}`;
                X[n] = await createPoint(ws, suffix.substring(1), pointTz);
                const ysuffix = `_${label}_y_${n}_${RUN_ID}`;
                Y[n] = await createPoint(ws, ysuffix.substring(1), pointTz);
            }
            // Controls also alternate tz
            for (const i of ["control_1", "control_2"]) {
                const pointTz = i === "control_1" ? "Brisbane" : "New_York";
                const csuffix = `_${label}_${i}_${RUN_ID}`;
                C[i] = await createPoint(ws, csuffix.substring(1), pointTz);
            }
        } else {
            // For regular scenarios: use shape keys
            for (const n of names) {
                const suffix = `_${label}_x_${n}_${RUN_ID}`;
                X[n] = await createPoint(ws, suffix.substring(1), tz);
                const ysuffix = `_${label}_y_${n}_${RUN_ID}`;
                Y[n] = await createPoint(ws, ysuffix.substring(1), tz);
            }
            for (const i of ["control_1", "control_2"]) {
                const csuffix = `_${label}_${i}_${RUN_ID}`;
                C[i] = await createPoint(ws, csuffix.substring(1), tz);
            }
        }

        // Seed identical data into X and Y
        if (isTzless) {
            // All points get the same data for tz-less scenario
            const data = shape;
            for (const id of [...Object.values(X), ...Object.values(Y), ...Object.values(C)]) {
                await seed(ws, id, data);
            }
        } else {
            // Regular scenarios: use shape[name]
            for (const n of names) {
                const data = shape[n];
                for (const id of [X[n], Y[n]]) {
                    await seed(ws, id, data);
                }
            }
            // Control points use a_minute_1d
            for (const id of Object.values(C)) {
                await seed(ws, id, shape.a_minute_1d);
            }
        }

        // Read snapshots before deletion
        const before = {};
        for (const n of Object.keys(X)) before[n] = await readAll(ws, X[n]);
        const controlsBefore = {};
        for (const [n, id] of Object.entries(C)) controlsBefore[n] = await readAll(ws, id);

        // Recording wrapper: captures requests and errors. Restores in finally.
        const seen = [];
        const rejections = [];
        const raw = ws._wsRawSubmit.bind(ws);
        let firstDelete = true;
        try {
            ws._wsRawSubmit = async (method, uri, body, config) => {
                seen.push({ uri, body });
                if (uri === "/api/hisDelete" && firstDelete && mutateAfterPlan) {
                    firstDelete = false;
                    // Write late rows through unwrapped submit (not recorded)
                    await mutateAfterPlan();
                }
                try {
                    return await raw(method, uri, body, config);
                } catch (err) {
                    rejections.push({ uri, error: err.message });
                    throw err;
                }
            };

            const res = await ws.batch.hisDelete(Object.values(X), range, opts);

            // Oracle: plain hisDelete with same range on Y
            await ws.hisDelete(Object.values(Y), range.startsWith("s:") ? range : `s:${range}`);

            // Assertion: no errors in batch.hisDelete
            expect(res.errors, JSON.stringify(res.errors)).to.eql([]);

            // Assertion: X matches Y (oracle) and range boundaries are correct
            for (const n of Object.keys(X)) {
                const survivorsX = await readAll(ws, X[n]);
                const survivorsY = await readAll(ws, Y[n]);
                expect(survivorsX, `${label} ${n}: X vs oracle`).to.eql(survivorsY);

                // Resolve this point's range for its timezone
                const pointTz = isTzless ? (n.includes("point_") && parseInt(n.split("_")[1]) % 2 === 1 ? "America/New_York" : "Australia/Brisbane") : tz;
                const tzName = pointTz === "America/New_York" ? "America/New_York" : "Australia/Brisbane";
                const [fromMs, toMs] = resolveRange(range, tzName);

                // Assertion C1: no rows strictly inside (fromMs, toMs)
                const inside = survivorsX.filter((ts) => ts > fromMs && ts < toMs);
                expect(inside.length, `${label} ${n}: no rows strictly inside range`).to.equal(0);

                // Assertion C2: all rows outside [fromMs, toMs] survive
                const outside = before[n].filter((ts) => ts <= fromMs || ts >= toMs);
                expect(survivorsX.sort((a, b) => a - b), `${label} ${n}: survivors outside`).to.eql(outside.sort((a, b) => a - b));
            }

            // Assertion: controls untouched
            for (const [n, id] of Object.entries(C)) {
                const controlsAfter = await readAll(ws, id);
                expect(controlsAfter, `${label} control ${n}`).to.eql(controlsBefore[n]);
            }

            // Assertion: no hisRead calls during planning
            expect(seen.some((s) => s.uri.includes("hisRead")), `${label}: no hisRead`).to.equal(false);

            // Assertion: rows per request <= batchSize + 1
            const deleteRequests = seen.filter((s) => s.uri === "/api/hisDelete");
            expect(deleteRequests.length, `${label}: at least 1 delete request`).to.be.greaterThan(0);
            let maxRowsInAnyRequest = 0;
            for (const req of deleteRequests) {
                const row = req.body.rows[0];
                if (!row) continue;
                const idCount = Object.keys(row).filter((k) => /^id\d*$/.test(k)).length;
                maxRowsInAnyRequest = Math.max(maxRowsInAnyRequest, idCount);
            }
            expect(maxRowsInAnyRequest, `${label}: ids per request <= batchSize`).to.be.at.most(opts.batchSize + 1);

            // For bisection scenario, check rejections
            if (mutateAfterPlan) {
                const hasRecordLimitError = rejections.some((r) => r.error.includes("data points per entity cannot exceed"));
                expect(hasRecordLimitError, `${label}: at least 1 record-limit rejection`).to.be.true;
            }

            return { X, Y, seen, rejections };
        } finally {
            ws._wsRawSubmit = raw;
        }
    }

    it("absolute UTC range", () => scenario({
        label: "utc", isTzless: false, range: "2026-06-01T00:00:00Z,2026-06-02T00:00:00Z",
        startMs: Date.parse("2026-06-01T00:00:00Z"), endMs: Date.parse("2026-06-02T00:00:00Z"),
        tz: "Brisbane"
    }));

    it("tz-less date range (mixed points)", () => scenario({
        label: "tzl", isTzless: true, range: "2026-06-01,2026-06-03",
        startMs: undefined, endMs: undefined, tz: "Brisbane" // will be computed per-point
    }));

    it("end-inclusive date pair with offsets", () => scenario({
        label: "dates", isTzless: false, range: "2026-06-01T00:00:00Z,2026-06-02T00:00:00Z",
        startMs: Date.parse("2026-06-01T00:00:00Z"), endMs: Date.parse("2026-06-02T00:00:00Z"),
        tz: "Brisbane"
    }));

    it("relative range (yesterday)", function () {
        // Record local date before and after to detect midnight crossing
        const dateBefore = moment().tz("Australia/Brisbane").format("YYYY-MM-DD");
        const yesterday = moment().tz("Australia/Brisbane").subtract(1, "day").startOf("day");
        const start = yesterday.valueOf();
        const end = yesterday.clone().add(1, "day").valueOf() - 1;

        return scenario({
            label: "rel", isTzless: false, range: "yesterday",
            startMs: start, endMs: end, tz: "Brisbane"
        }).then(() => {
            const dateAfter = moment().tz("Australia/Brisbane").format("YYYY-MM-DD");
            if (dateBefore !== dateAfter) {
                throw new Error("crossed local midnight during the run — re-run");
            }
        });
    });

    it("bisects when rows arrive after planning", function () {
        return scenario({
            label: "bisect", isTzless: false, range: "2026-06-01T00:00:00Z,2026-06-02T00:00:00Z",
            startMs: Date.parse("2026-06-01T00:00:00Z"), endMs: Date.parse("2026-06-02T00:00:00Z"),
            tz: "Brisbane",
            options: { batchSize: 1500, parallel: 1 },
            mutateAfterPlan: async () => {
                // Write late rows to c_burst point through raw (unwrapped) submit
                const freshWs = makeClient();
                const cBurstName = `bisect_x_c_burst_${RUN_ID}`;
                const id = await resolve(freshWs, `${EQUIP}.${cBurstName}`);
                if (!id) throw new Error(`c_burst point ${cBurstName} not found for bisect`);
                // Late rows that push point over 1500
                const lateRows = every(Date.parse("2026-06-01T23:00:00.500Z"), 1000, 1000);
                await seed(freshWs, id, lateRows);
            }
        });
    });
});
