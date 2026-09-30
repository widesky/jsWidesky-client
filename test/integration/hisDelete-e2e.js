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

// S1: Helper to convert Haystack tz to IANA timezone name
function hsTzToIana(hsTz) {
    return moment.tz.zone(hsTz) ? hsTz : moment.tz.names().find(n => n.split("/").pop() === hsTz);
}

async function resolve(ws, fqname) {
    const rows = ((await ws.find(`id==@${fqname}`, 0)) || {}).rows || [];
    return rows.length === 1 ? bareId(rows[0].id) : null;
}

async function createPoint(ws, name, hsTz) {
    const fq = `${EQUIP}.${name}`;
    if (await resolve(ws, fq)) return resolve(ws, fq); // idempotent if exists
    if (!(await resolve(ws, SITE))) {
        await ws.create({ name: `s:${SITE}`, dis: "s:hisDelete E2E Site", site: "m:", tz: "s:Brisbane" });
    }
    if (!(await resolve(ws, EQUIP))) {
        await ws.create({ name: "s:plantroom", dis: "s:Plant Room", equip: "m:", siteRef: `r:${SITE}`, tz: "s:Brisbane" });
    }
    await ws.create({ name: `s:${name}`, dis: `s:${name}`, point: "m:", his: "m:", kind: "s:Number",
        unit: "s:°C", equipRef: `r:${EQUIP}`, siteRef: `r:${SITE}`, tz: `s:${hsTz}` });
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

// S2: Resolve a Haystack range string to {fromMs, toMs} in UTC, per the point's timezone.
// Captures nowMs once at scenario start; never calls Date.now() inside.
function resolveRange(range, hsTz, nowMs) {
    const iana = hsTzToIana(hsTz);
    let rangeStr = range.startsWith("s:") ? range.substring(2) : range;

    // Handle "today" and "yesterday" as complete local days
    if (rangeStr === "today") {
        const start = moment.tz(nowMs, iana).startOf("day");
        return {
            fromMs: start.valueOf(),
            toMs: start.clone().add(1, "day").valueOf()
        };
    }
    if (rangeStr === "yesterday") {
        const start = moment.tz(nowMs, iana).subtract(1, "day").startOf("day");
        return {
            fromMs: start.valueOf(),
            toMs: start.clone().add(1, "day").valueOf()
        };
    }

    // Split on comma and extract tokens (part before first space)
    const [startStr, endStr] = rangeStr.split(",").map(s => s.trim().split(" ")[0]);

    let fromMs;
    if (startStr.includes("T") || startStr.includes("Z") || startStr.includes("+") || startStr.includes("-")) {
        // Token with offset: absolute UTC
        fromMs = Date.parse(startStr);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(startStr)) {
        // Date-only: local midnight in the zone
        fromMs = moment.tz(startStr, "YYYY-MM-DD", iana).valueOf();
    } else {
        throw new Error(`Unhandled start token: ${startStr}`);
    }

    let toMs;
    if (endStr.includes("T") || endStr.includes("Z") || endStr.includes("+") || endStr.includes("-")) {
        // Token with offset: absolute UTC
        toMs = Date.parse(endStr);
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(endStr)) {
        // Date-only end: end of that day (start of next day minus 1ms)
        toMs = moment.tz(endStr, "YYYY-MM-DD", iana).add(1, "day").valueOf() - 1;
    } else {
        throw new Error(`Unhandled end token: ${endStr}`);
    }

    return { fromMs, toMs };
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

// S6: Tz-less scenario: each point builds from ITS OWN timezone.
// Returns an object mapping point index to its data array.
function buildTzlessData(hsTz) {
    const iana = hsTzToIana(hsTz);
    const localStart = moment.tz("2026-06-01", "YYYY-MM-DD", iana).valueOf();
    const localEnd = moment.tz("2026-06-04", "YYYY-MM-DD", iana).valueOf();

    // Burst 1: 600 rows at 250ms from localStart
    const burst1 = every(localStart, 600, 250);
    // Burst 2: 600 rows at 250ms ending before localEnd (start 150s = 150000ms before end)
    const burst2 = every(localEnd - 150000, 600, 250);

    // Background: ~250 rows strictly between (localStart + 1h) and (localEnd - 1h)
    // Spacing to achieve ~250 rows: (localEnd - 1h - localStart - 1h) / 250 ≈ (3 days - 2h) / 250 ≈ 288000ms
    const bgStart = localStart + HOUR;
    const bgEnd = localEnd - HOUR;
    const bgSpacing = Math.floor((bgEnd - bgStart) / 250);
    const background = every(bgStart, 250, bgSpacing);

    const edges = [localStart - 1, localStart, localEnd, localEnd + 1];
    const data = [...burst1, ...burst2, ...background, ...edges].sort((a, b) => a - b);

    // Assert total in-range is <= 1500
    const inRange = data.filter(ts => ts >= localStart && ts <= localEnd);
    if (inRange.length > 1500) {
        throw new Error(`tz-less data for ${hsTz} exceeds 1500 in-range rows: ${inRange.length}`);
    }

    return data;
}

(WS_E2E_URL ? describe : describe.skip)("batch.hisDelete against a live stack", function () {
    this.timeout(600000);
    let ws;
    before(() => { ws = makeClient(); });

    async function scenario({ label, isTzless, range, tz, options = {}, mutateAfterPlan }) {
        // Capture nowMs once at scenario start (S2, S7)
        const nowMs = Date.now();

        // Default batchSize to 200 to force bisection in regular scenarios
        const opts = { batchSize: 200, ...options };

        // Build shape: tz-less uses per-point data, others use regular 1-day shape
        let startMs, endMs;
        if (!isTzless) {
            const rangeParts = range.split(",");
            startMs = Date.parse(rangeParts[0].split(" ")[0]);
            endMs = Date.parse(rangeParts[1].split(" ")[0]);
        }

        const shape = !isTzless ? shapesRegular(startMs, endMs) : null;
        const names = !isTzless ? Object.keys(shape) : ["data"];

        const X = {}, Y = {}, C = {};
        const pointTzs = {}; // Map point name to its Haystack tz

        // Create fresh points with run ID appended
        if (isTzless) {
            // For tz-less: create 12 points alternating Brisbane/New_York, plus controls
            for (let i = 0; i < 12; i++) {
                const hsTz = i % 2 === 0 ? "Brisbane" : "New_York";
                const n = `point_${i}`;
                const suffix = `_${label}_x_${n}_${RUN_ID}`;
                X[n] = await createPoint(ws, suffix.substring(1), hsTz);
                pointTzs[`x_${n}`] = hsTz;
                const ysuffix = `_${label}_y_${n}_${RUN_ID}`;
                Y[n] = await createPoint(ws, ysuffix.substring(1), hsTz);
                pointTzs[`y_${n}`] = hsTz;
            }
            // Controls also alternate tz
            for (const idx of [0, 1]) {
                const hsTz = idx === 0 ? "Brisbane" : "New_York";
                const i = `control_${idx + 1}`;
                const csuffix = `_${label}_${i}_${RUN_ID}`;
                C[i] = await createPoint(ws, csuffix.substring(1), hsTz);
                pointTzs[i] = hsTz;
            }
        } else {
            // For regular scenarios: use shape keys, all points use same tz
            for (const n of names) {
                const suffix = `_${label}_x_${n}_${RUN_ID}`;
                X[n] = await createPoint(ws, suffix.substring(1), tz);
                pointTzs[`x_${n}`] = tz;
                const ysuffix = `_${label}_y_${n}_${RUN_ID}`;
                Y[n] = await createPoint(ws, ysuffix.substring(1), tz);
                pointTzs[`y_${n}`] = tz;
            }
            for (const i of ["control_1", "control_2"]) {
                const csuffix = `_${label}_${i}_${RUN_ID}`;
                C[i] = await createPoint(ws, csuffix.substring(1), tz);
                pointTzs[i] = tz;
            }
        }

        // Seed identical data into X and Y
        if (isTzless) {
            // For tz-less, each point gets its own per-tz data
            for (const [n, id] of Object.entries(X)) {
                const hsTz = n.includes("point_") ?
                    (parseInt(n.split("_")[1]) % 2 === 0 ? "Brisbane" : "New_York") :
                    pointTzs[`x_${n}`];
                const data = buildTzlessData(hsTz);
                await seed(ws, id, data);
                await seed(ws, Y[n], data); // Same data for Y twin
            }
            // Seed controls
            for (const [n, id] of Object.entries(C)) {
                const hsTz = pointTzs[n];
                const data = buildTzlessData(hsTz);
                await seed(ws, id, data);
            }
        } else {
            // Regular scenarios: use shape[n]
            for (const n of names) {
                const data = shape[n];
                await seed(ws, X[n], data);
                await seed(ws, Y[n], data);
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

        // Recording wrapper: captures requests and errors, plus success/failure status.
        const seen = [];
        const raw = ws._wsRawSubmit.bind(ws);
        let firstDelete = true;
        try {
            ws._wsRawSubmit = async (method, uri, body, config) => {
                let success = true;
                try {
                    const result = await raw(method, uri, body, config);
                    if (uri === "/api/hisDelete" && firstDelete && mutateAfterPlan) {
                        firstDelete = false;
                        await mutateAfterPlan();
                    }
                    seen.push({ uri, body, success: true });
                    return result;
                } catch (err) {
                    seen.push({ uri, body, error: err.message, success: false });
                    throw err;
                }
            };

            const res = await ws.batch.hisDelete(Object.values(X), range, opts);

            // Oracle: plain hisDelete with same range on Y (S2 resolveRange used by oracle)
            await ws.hisDelete(Object.values(Y), range.startsWith("s:") ? range : `s:${range}`);

            // S7: Check for midnight crossing (immediately after Y delete, before assertions)
            if (isTzless || tz === "Brisbane" || range.includes("yesterday")) {
                const iana = hsTzToIana(tz || "Brisbane");
                const dateAtNow = moment.tz(Date.now(), iana).format("YYYY-MM-DD");
                const dateAtCapture = moment.tz(nowMs, iana).format("YYYY-MM-DD");
                if (dateAtNow !== dateAtCapture) {
                    throw new Error("crossed local midnight during the run — re-run");
                }
            }

            // Assertion: no errors in batch.hisDelete
            expect(res.errors, JSON.stringify(res.errors)).to.eql([]);

            // S3: Assertions C1, C2, plus no-hisRead and rows-per-request
            for (const n of Object.keys(X)) {
                const survivorsX = await readAll(ws, X[n]);
                const survivorsY = await readAll(ws, Y[n]);

                // Assertion: X matches Y (oracle)
                expect(survivorsX, `${label} ${n}: X vs oracle`).to.eql(survivorsY);

                // Resolve this point's range using its own tz
                const hsTz = pointTzs[`x_${n}`];
                const { fromMs, toMs } = resolveRange(range, hsTz, nowMs);

                // Assertion C1: no rows strictly inside (fromMs, toMs)
                const inside = survivorsX.filter((ts) => ts > fromMs && ts < toMs);
                expect(inside.length, `${label} ${n}: C1 no rows strictly inside range`).to.equal(0);

                // Assertion C2: every snapshot row outside [fromMs, toMs] (strict) survives
                // Using Set membership check as specified
                const outsideSnapshot = before[n].filter((ts) => ts < fromMs || ts > toMs);
                const survivorSet = new Set(survivorsX);
                for (const row of outsideSnapshot) {
                    expect(survivorSet.has(row), `${label} ${n}: C2 outside row ${row} survives`).to.be.true;
                }
                // Comment: rows exactly at fromMs or toMs checked ONLY by X==Y
            }

            // Assertion: controls untouched
            for (const [n, id] of Object.entries(C)) {
                const controlsAfter = await readAll(ws, id);
                expect(controlsAfter, `${label} control ${n}`).to.eql(controlsBefore[n]);
            }

            // Assertion: no hisRead calls during planning
            expect(seen.some((s) => s.uri.includes("hisRead")), `${label}: no hisRead`).to.equal(false);

            // S4: Rows per request assertion
            const deleteRequests = seen.filter((s) => s.uri === "/api/hisDelete");
            expect(deleteRequests.length, `${label}: at least 1 delete request recorded`).to.be.greaterThan(0);

            // For bisection scenario, count only successful requests; for others, count all
            const countRequests = mutateAfterPlan ? deleteRequests.filter(r => r.success) : deleteRequests;
            let maxRowsInAnyRequest = 0;

            for (const req of countRequests) {
                const row = req.body.rows[0];
                if (!row) continue;

                // Extract ids from the body (id, id1, id2, ...)
                const idFields = Object.keys(row).filter((k) => /^id\d*$/.test(k));
                for (const idField of idFields) {
                    const idValue = row[idField];
                    // Strip "r:" prefix and remove " dis" suffix
                    const id = idValue.substring(2).split(" ")[0];

                    // Find point by id to determine its tz
                    let pointHsTz = tz; // default
                    for (const [n, pid] of Object.entries(X)) {
                        if (pid === id) {
                            pointHsTz = pointTzs[`x_${n}`];
                            break;
                        }
                    }
                    for (const [n, pid] of Object.entries(Y)) {
                        if (pid === id) {
                            pointHsTz = pointTzs[`y_${n}`];
                            break;
                        }
                    }

                    // Resolve request range with point's tz
                    const rangeStr = row.range.startsWith("s:") ? row.range.substring(2) : row.range;
                    const { fromMs: reqStart, toMs: reqEnd } = resolveRange(rangeStr, pointHsTz, nowMs);

                    // Count snapshot rows within [reqStart, reqEnd] (inclusive)
                    let rowCount = 0;
                    for (const n of Object.keys(X)) {
                        if (X[n] === id) {
                            rowCount = before[n].filter((ts) => ts >= reqStart && ts <= reqEnd).length;
                            break;
                        }
                    }
                    for (const n of Object.keys(Y)) {
                        if (Y[n] === id) {
                            rowCount = before[n].filter((ts) => ts >= reqStart && ts <= reqEnd).length;
                            break;
                        }
                    }
                    for (const [n, pid] of Object.entries(C)) {
                        if (pid === id) {
                            rowCount = controlsBefore[n].filter((ts) => ts >= reqStart && ts <= reqEnd).length;
                            break;
                        }
                    }

                    maxRowsInAnyRequest = Math.max(maxRowsInAnyRequest, rowCount);
                }
            }

            expect(maxRowsInAnyRequest, `${label}: rows per request <= batchSize + 1`).to.be.at.most(opts.batchSize + 1);
            // Comment: one row can sit on a shared boundary

            return { X, Y, seen };
        } finally {
            ws._wsRawSubmit = raw;
        }
    }

    it("absolute UTC range", () => scenario({
        label: "utc", isTzless: false, range: "2026-06-01T00:00:00Z,2026-06-02T00:00:00Z",
        tz: "Brisbane"
    }));

    it("tz-less date range (mixed points)", () => scenario({
        label: "tzl", isTzless: true, range: "2026-06-01,2026-06-03",
        tz: "Brisbane" // not used for tz-less
    }));

    it("end-inclusive date pair with offsets", () => scenario({
        label: "dates", isTzless: false, range: "2026-06-01T00:00:00+10:00 Brisbane,2026-06-04T00:00:00+10:00 Brisbane",
        tz: "Brisbane"
    }));

    it("relative range (yesterday)", function () {
        return scenario({
            label: "rel", isTzless: false, range: "yesterday",
            tz: "Brisbane"
        });
    });

    it("bisects when rows arrive after planning", function () {
        return scenario({
            label: "bisect", isTzless: false, range: "2026-06-01T00:00:00Z,2026-06-02T00:00:00Z",
            tz: "Brisbane",
            options: { batchSize: 1500, parallel: 1 },
            mutateAfterPlan: async () => {
                // Write late rows to c_burst point through fresh unwrapped submit
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
