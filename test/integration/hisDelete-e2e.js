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
 * Y with plain client.hisDelete of the same range (one call per timezone group), which is the
 * server's own semantics.
 * Every point's in-range rows are <= 1500, so the plain call cannot hit the server's per-entity
 * limit. Surviving rows must match exactly, including rows 1 ms either side of the range.
 * Points get a per-run suffix, so nothing is wiped; the site and equip are reused.
 *
 * SKIPPED unless WS_E2E_URL is set. Run:
 *   WS_E2E_URL=http://localhost:3000 WS_E2E_USER=... WS_E2E_PASS=... \
 *   WS_E2E_CLIENT_ID=... WS_E2E_CLIENT_SECRET=... npx mocha --timeout 600000 test/integration/hisDelete-e2e.js
 */

const expect = require("chai").expect;
const moment = require("moment-timezone");
const { WideSkyClient } = require("../../index");
const HisWritePayload = require("../../src/utils/hisWritePayload");
const H = require("./hisDelete-e2e-helpers");

const WS_E2E_URL = process.env.WS_E2E_URL;
const SITE = "jsclient_hisdelete_e2e";
const EQUIP = `${SITE}.plantroom`;
const RUN_ID = Date.now().toString(36);
const LIMIT_MESSAGE = "data points per entity cannot exceed";
const BATCH_SIZE_ENTITY = 10; // client default
const BUG_4_IDS = "server bug: a hisDelete naming exactly 4 ids skips the 4th, see CORE-9209 D1 evidence";

const UTC_RANGE = "2026-06-01T00:00:00Z,2026-06-04T00:00:00Z";
const OFFSET_RANGE = "2026-06-01T00:00:00+10:00 Brisbane,2026-06-04T00:00:00+10:00 Brisbane";
const TZLESS_RANGE = "2026-06-01,2026-06-03";

const makeClient = () => new WideSkyClient(WS_E2E_URL, process.env.WS_E2E_USER, process.env.WS_E2E_PASS,
    process.env.WS_E2E_CLIENT_ID, process.env.WS_E2E_CLIENT_SECRET, { level: "error" });
const bareId = (raw) => raw.substring(2).split(" ")[0];

async function resolve(ws, fqname) {
    const rows = ((await ws.find(`id==@${fqname}`, 0)) || {}).rows || [];
    return rows.length === 1 ? bareId(rows[0].id) : null;
}

async function ensureSiteAndEquip(ws) {
    if (!(await resolve(ws, SITE))) {
        await ws.create({ name: `s:${SITE}`, dis: "s:hisDelete E2E Site", site: "m:", tz: "s:Brisbane" });
    }
    if (!(await resolve(ws, EQUIP))) {
        await ws.create({ name: "s:plantroom", dis: "s:Plant Room", equip: "m:", siteRef: `r:${SITE}`, tz: "s:Brisbane" });
    }
}

async function createPoint(ws, name, hsTz) {
    await ws.create({ name: `s:${name}`, dis: `s:${name}`, point: "m:", his: "m:", kind: "s:Number",
        unit: "s:°C", equipRef: `r:${EQUIP}`, siteRef: `r:${SITE}`, tz: `s:${hsTz}` });
    return resolve(ws, `${EQUIP}.${name}`);
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

/** Rejection text as the client surfaces it: the server's meta.dis (RequestError.make strips "s:"). */
function rejectionMessage(err) {
    const dis = err && err.response && err.response.data && err.response.data.meta && err.response.data.meta.dis;
    return typeof dis === "string" ? dis.replace(/^s:/, "") : String(err && err.message);
}

// Scenario builders: nowMs -> { targets: [{name, tz, data}], controls: [{name, tz, data}] }.
function regularBuild(range, tz, only) {
    return (nowMs) => {
        const { fromMs, toMs } = H.resolveRange(range, tz, nowMs);
        const shapes = H.shapesRegular(fromMs, toMs);
        const names = only || Object.keys(shapes);
        return {
            targets: names.map((name) => ({ name, tz, data: shapes[name] })),
            controls: ["control_1", "control_2"].map((name) => ({ name, tz, data: shapes.a_minute_1d })),
        };
    };
}

// Adelaide (+09:30) checks the planner's wall-time "+00:00 Adelaide" form against the real server:
// its zero-offset reading and its tzMins*60 offset arithmetic are what that form relies on.
const TZLESS_ZONES = ["Brisbane", "New_York", "Adelaide"];

function tzlessBuild() {
    const zoneOf = (i) => TZLESS_ZONES[i % TZLESS_ZONES.length];
    return () => ({
        // 15 targets, 5 per zone, run with batchSizeEntity 15: every X tz sub-group and every Y
        // per-zone group names 5 ids, never 4
        // (server bug: a hisDelete naming exactly 4 ids skips the 4th, see CORE-9209 D1 evidence).
        targets: Array.from({ length: 15 }, (_, i) => ({ name: `point_${i}`, tz: zoneOf(i), data: H.buildTzlessData(zoneOf(i)) })),
        controls: TZLESS_ZONES.map((zone, i) => ({ name: `control_${i + 1}`, tz: zone, data: H.buildTzlessData(zone) })),
    });
}

function yesterdayBuild() {
    return (nowMs) => ({
        // 5 targets: one unplanned request naming 4 ids would trip
        // (server bug: a hisDelete naming exactly 4 ids skips the 4th, see CORE-9209 D1 evidence).
        targets: Array.from({ length: 5 }, (_, i) => ({ name: `point_${i}`, tz: "Brisbane", data: H.buildYesterdayData("Brisbane", nowMs) })),
        controls: [1, 2].map((i) => ({ name: `control_${i}`, tz: "Brisbane", data: H.buildYesterdayData("Brisbane", nowMs) })),
    });
}

(WS_E2E_URL ? describe : describe.skip)("batch.hisDelete against a live stack", function () {
    this.timeout(600000);
    let ws;
    before(async () => { ws = makeClient(); await ensureSiteAndEquip(ws); });

    /**
     * @param {object} s
     * @param {string} s.label
     * @param {string} s.range          range passed to both deletes
     * @param {string} s.tz             zone used for the now-dependent midnight guard
     * @param {Function} s.build        nowMs -> {targets, controls}
     * @param {object} [s.options]      batch.hisDelete options over {batchSize: 200}
     * @param {Function} [s.beforeFirstDelete] async ({X}) run before the first /api/hisDelete is forwarded
     * @param {boolean} [s.expectRejection] assert the server rejected >= 1 delete with the record-limit message
     */
    async function scenario({ label, range, tz, build, options = {}, beforeFirstDelete, expectRejection }) {
        const nowMs = Date.now(); // captured once; never re-read except by the midnight guard
        const opts = { batchSize: 200, ...options };
        const { targets, controls } = build(nowMs);

        const X = {}, Y = {}, C = {}; // name -> id
        const tzOf = {};              // id -> Haystack tz, built once as points are created
        const dataOf = {};            // id -> seeded timestamps
        for (const t of targets) {
            X[t.name] = await createPoint(ws, `${label}_x_${t.name}_${RUN_ID}`, t.tz);
            Y[t.name] = await createPoint(ws, `${label}_y_${t.name}_${RUN_ID}`, t.tz);
            tzOf[X[t.name]] = tzOf[Y[t.name]] = t.tz;
            dataOf[X[t.name]] = dataOf[Y[t.name]] = t.data;
        }
        for (const c of controls) {
            C[c.name] = await createPoint(ws, `${label}_${c.name}_${RUN_ID}`, c.tz);
            tzOf[C[c.name]] = c.tz;
            dataOf[C[c.name]] = c.data;
        }
        for (const id of Object.keys(dataOf)) await seed(ws, id, dataOf[id]);

        // Pre-delete snapshots of X and the controls, by id.
        const snapshots = {};
        for (const id of [...Object.values(X), ...Object.values(C)]) snapshots[id] = await readAll(ws, id);

        // Recording wrapper: every request, with outcome. Restored in finally.
        const seen = [];
        const raw = ws._wsRawSubmit.bind(ws);
        let hooked = false;
        try {
            ws._wsRawSubmit = async (method, uri, body, config) => {
                if (uri === "/api/hisDelete" && !hooked && beforeFirstDelete) {
                    hooked = true;
                    await beforeFirstDelete({ X }); // before the request is forwarded
                }
                try {
                    const result = await raw(method, uri, body, config);
                    seen.push({ uri, body, ok: true });
                    return result;
                } catch (err) {
                    seen.push({ uri, body, ok: false, message: rejectionMessage(err) });
                    throw err;
                }
            };

            const res = await ws.batch.hisDelete(Object.values(X), range, opts);
            ws._wsRawSubmit = raw; // the oracle calls are not part of the recording

            // Oracle: ONE plain hisDelete PER TIMEZONE GROUP of Y points, not one over all of them
            // (server bug: mixed-timezone date-only delete, see CORE-9209 D1 evidence).
            const yGroups = {};
            for (const id of Object.values(Y)) (yGroups[tzOf[id]] = yGroups[tzOf[id]] || []).push(id);
            const yRequestSizes = Object.values(yGroups).map((g) => g.length);
            for (const group of Object.values(yGroups)) {
                await ws.hisDelete(group, range.startsWith("s:") ? range : `s:${range}`);
            }

            // Only now-dependent ranges can drift; check before any assertion, in the scenario's zone.
            if (H.isNowDependent(range)) {
                const iana = H.hsTzToIana(tz);
                if (moment.tz(Date.now(), iana).format("YYYY-MM-DD") !== moment.tz(nowMs, iana).format("YYYY-MM-DD")) {
                    throw new Error("crossed local midnight during the run — re-run");
                }
            }

            const deletes = seen.filter((s) => s.uri === "/api/hisDelete");
            // Guard: no X or Y request may name exactly 4 ids (server bug: a hisDelete naming exactly 4 ids skips the 4th, see CORE-9209 D1 evidence).
            const requestSizes = [...deletes.map((d) => H.idsOfBody(d.body).length), ...yRequestSizes];
            expect(requestSizes.filter((n) => n === 4).length,
                `${label}: a delete request named exactly 4 ids; the ${BUG_4_IDS}. Sizes: ${JSON.stringify(requestSizes)}`).to.equal(0);
            if (expectRejection) {
                const rejections = deletes.filter((d) => !d.ok && d.message.includes(LIMIT_MESSAGE));
                expect(rejections.length, `${label}: >= 1 record-limit rejection (${JSON.stringify(deletes.map((d) => d.message))})`).to.be.at.least(1);
            }
            expect(res.errors, JSON.stringify(res.errors)).to.eql([]);

            for (const n of Object.keys(X)) {
                const survivorsX = await readAll(ws, X[n]);
                const survivorsY = await readAll(ws, Y[n]);
                expect(survivorsX, `${label} ${n}: X vs oracle`).to.eql(survivorsY);

                const { fromMs, toMs } = H.resolveRange(range, tzOf[X[n]], nowMs);
                // C1: nothing strictly inside the range survives.
                expect(survivorsX.filter((ts) => ts > fromMs && ts < toMs), `${label} ${n}: C1`).to.eql([]);
                // C2: every snapshot row strictly outside [fromMs, toMs] survives. Rows exactly at
                // fromMs / toMs are judged only by X == Y above (server boundary semantics).
                const survivorSet = new Set(survivorsX);
                const lost = snapshots[X[n]].filter((ts) => (ts < fromMs || ts > toMs) && !survivorSet.has(ts));
                expect(lost, `${label} ${n}: C2 outside rows lost`).to.eql([]);
            }

            for (const [n, id] of Object.entries(C)) {
                expect(await readAll(ws, id), `${label} control ${n}`).to.eql(snapshots[id]);
            }

            expect(seen.filter((s) => s.uri.includes("hisRead")).length, `${label}: no hisRead`).to.equal(0);

            const ok = deletes.filter((d) => d.ok);
            expect(ok.length, `${label}: >= 1 successful delete request`).to.be.at.least(1);
            for (const d of deletes) {
                const ids = H.idsOfBody(d.body);
                expect(ids.length, `${label}: ids per delete request`).to.be.at.most(opts.batchSizeEntity || BATCH_SIZE_ENTITY);
            }
            for (const r of H.rowsPerRequest(ok.map((d) => d.body), snapshots, tzOf, nowMs)) {
                // + ids: each point may have one row on a boundary shared by two adjacent windows.
                expect(r.rows, `${label}: rows summed over the points of ${r.range}`)
                    .to.be.at.most(opts.batchSize + r.ids.length);
            }
            return { X, Y, seen };
        } finally {
            ws._wsRawSubmit = raw;
        }
    }

    it("absolute UTC range", () => scenario({
        label: "utc", range: UTC_RANGE, tz: "Brisbane", build: regularBuild(UTC_RANGE, "Brisbane"),
    }));

    it("tz-less date range (mixed points)", () => scenario({
        label: "tzl", range: TZLESS_RANGE, tz: "Brisbane", build: tzlessBuild(),
        // 15 so each tz sub-group of X is 5 ids (server bug: a hisDelete naming exactly 4 ids skips the 4th, see CORE-9209 D1 evidence).
        options: { batchSizeEntity: 15 },
    }));

    it("end-inclusive date pair with offsets", () => scenario({
        label: "offs", range: OFFSET_RANGE, tz: "Brisbane", build: regularBuild(OFFSET_RANGE, "Brisbane"),
    }));

    it("relative range (yesterday)", () => scenario({
        label: "rel", range: "yesterday", tz: "Brisbane", build: yesterdayBuild(),
        // Relative ranges are not planned: one request per group carries all ~1441 rows, so raise
        // batchSize to keep the rows-per-request bound meaningful.
        options: { batchSize: 1500 },
    }));

    it("bisects when rows arrive after planning", () => scenario({
        label: "bisect", range: UTC_RANGE, tz: "Brisbane",
        // Only the burst point is a target, so the first request includes it: 1200 burst rows +
        // 2 edges = 1202 <= 1500 at planning time.
        build: regularBuild(UTC_RANGE, "Brisbane", ["c_burst"]),
        options: { batchSize: 1500, parallel: 1 },
        expectRejection: true,
        beforeFirstDelete: async ({ X }) => {
            // Unwrapped second client. 400 extra interior rows take the point to 1602 > 1500. They are
            // in range, so both X and the oracle Y end with the same survivors.
            const late = makeClient();
            const start = Date.parse("2026-06-01T00:00:00Z");
            await seed(late, X.c_burst, H.every(start + 8 * H.HOUR + 500, 400, 250));
        },
    }));
});
