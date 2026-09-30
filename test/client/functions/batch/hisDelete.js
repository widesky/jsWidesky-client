"use strict";

const expect = require("chai").expect;
const stubs = require("../../../stubs");
const { FakeHistoryServer, haystackError, networkError } = require("./fakeHistoryServer");

// Realistic point ids for a plant-room site.
const PT = {
    chwFlowTemp: "5f0c2a1e-8d3b-4c7a-9e21-3b6f1d0a7c11",
    chwReturnTemp: "5f0c2a1e-8d3b-4c7a-9e21-3b6f1d0a7c12",
    boilerKw: "5f0c2a1e-8d3b-4c7a-9e21-3b6f1d0a7c13",
};
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const t = (iso) => Date.parse(iso);
const every = (fromIso, count, stepMs) => Array.from({ length: count }, (_, i) => t(fromIso) + i * stepMs);
const deletes = (fake) => fake.requests.filter((r) => r.uri === "/api/hisDelete");
const counts = (fake) => fake.requests.filter((r) => r.uri === "/graphql");

function client(points, fakeOpts = {}, clientOptions) {
    const ws = stubs.getInstance(new stubs.StubHTTPClient(), new stubs.StubLogger(),
        clientOptions ? { clientOptions } : {});
    const fake = new FakeHistoryServer({ points, ...fakeOpts }).install(ws);
    return { ws, fake };
}

const RANGE = "s:2026-09-01T00:00:00Z,2026-09-04T00:00:00Z";
const START = t("2026-09-01T00:00:00Z"), END = t("2026-09-04T00:00:00Z");

describe("client.batch.hisDelete", () => {
    describe("absolute ranges", () => {
        let ws, fake, outsideBefore, outsideAfter;
        beforeEach(() => {
            outsideBefore = [START - 1, START - MIN];
            outsideAfter = [END, END + 1];
            ({ ws, fake } = client({
                [PT.chwFlowTemp]: { rows: [...outsideBefore, ...every("2026-09-01T00:00:00Z", 3 * 1440, MIN), ...outsideAfter] }
            }));
        });

        it("deletes every row inside the range and none outside it", async () => {
            const res = await ws.batch.hisDelete([PT.chwFlowTemp], RANGE);
            expect(res.errors).to.eql([]);
            expect(fake.rows(PT.chwFlowTemp)).to.eql([...outsideBefore, ...outsideAfter].sort((a, b) => a - b));
        });

        it("keeps every request within the per-entity row budget", async () => {
            await ws.batch.hisDelete([PT.chwFlowTemp], RANGE);
            const sizes = deletes(fake).map((r) => r.deleted[0]);
            expect(Math.max(...sizes)).to.be.at.most(500);
            expect(sizes.reduce((a, b) => a + b, 0)).to.equal(3 * 1440);
            // Packed, not cut at every bucket: about total / budget requests, with a little slack.
            expect(sizes.length).to.be.at.most(Math.ceil(3 * 1440 / 500) + 1);
        });

        it("plans from COUNT histograms and never reads history", async () => {
            await ws.batch.hisDelete([PT.chwFlowTemp], RANGE);
            const uris = new Set(fake.requests.map((r) => r.uri));
            expect([...uris].sort()).to.eql(["/api/hisDelete", "/graphql"]);
            expect(counts(fake)[0].unit).to.equal("DAY");
        });

        it("keeps the caller's start and end tokens on the first and last request", async () => {
            const range = "2026-09-01T10:00:00+10:00 Brisbane,2026-09-04T10:00:00+10:00 Brisbane";
            await ws.batch.hisDelete([PT.chwFlowTemp], range);
            const ranges = deletes(fake).map((r) => r.range);
            expect(ranges[0].startsWith("s:2026-09-01T10:00:00+10:00 Brisbane,")).to.be.true;
            expect(ranges[ranges.length - 1].endsWith(",2026-09-04T10:00:00+10:00 Brisbane")).to.be.true;
        });

        it("tiles the range with contiguous requests", async () => {
            await ws.batch.hisDelete([PT.chwFlowTemp], RANGE);
            const ranges = deletes(fake).map((r) => r.range.replace(/^s:/, "").split(","));
            for (let i = 1; i < ranges.length; i++) {
                expect(ranges[i][0]).to.equal(ranges[i - 1][1]);
            }
        });

        it("deletes rows that sit exactly on an interior boundary", async () => {
            await ws.batch.hisDelete([PT.chwFlowTemp], RANGE);
            // Each interior boundary is the end token of one request and the start token of the next.
            const boundaries = deletes(fake).slice(0, -1).map((r) => Date.parse(r.range.replace(/^s:/, "").split(",")[1]));
            expect(boundaries.length).to.be.greaterThan(0);
            for (const b of boundaries) {
                expect(fake.rows(PT.chwFlowTemp)).to.not.include(b);
            }
        });

        it("accepts the range with or without the s: prefix, and as two Dates", async () => {
            await ws.batch.hisDelete([PT.chwFlowTemp], RANGE.replace(/^s:/, ""));
            expect(fake.rows(PT.chwFlowTemp)).to.eql([...outsideBefore, ...outsideAfter].sort((a, b) => a - b));

            const again = client({ [PT.chwFlowTemp]: { rows: every("2026-09-01T00:00:00Z", 1440, MIN) } });
            await again.ws.batch.hisDelete([PT.chwFlowTemp], new Date(START), new Date(END));
            expect(again.fake.rows(PT.chwFlowTemp)).to.eql([]);
        });
    });

    it("refines a dense burst down to the minute and splits an over-budget minute", async () => {
        // One hour of 1-second data: each minute holds 60 rows, over a 40-row budget.
        const { ws, fake } = client({ [PT.boilerKw]: { rows: every("2026-09-02T05:00:00Z", 3600, 1000) } });
        await ws.batch.hisDelete([PT.boilerKw], RANGE, { batchSize: 40 });
        expect(counts(fake).map((r) => r.unit)).to.include.members(["DAY", "HOUR", "MINUTE"]);
        expect(fake.rows(PT.boilerKw)).to.eql([]);
        expect(Math.max(...deletes(fake).map((r) => r.deleted[0]))).to.be.at.most(40);
    });

    it("deletes rows written into a gap after planning", async () => {
        // Hourly data with a two-day gap; rows appear inside the gap between planning and deleting.
        const rows = [...every("2026-09-01T00:00:00Z", 12, HOUR), ...every("2026-09-03T12:00:00Z", 12, HOUR)];
        const { ws, fake } = client({ [PT.chwReturnTemp]: { rows } });
        const lateRows = every("2026-09-02T06:00:00Z", 3, HOUR);
        fake.beforeFirstDelete((server) => {
            const p = server.points.get(PT.chwReturnTemp);
            p.rows = [...p.rows, ...lateRows].sort((a, b) => a - b);
        });
        await ws.batch.hisDelete([PT.chwReturnTemp], RANGE, { batchSize: 5 });
        expect(fake.rows(PT.chwReturnTemp)).to.eql([]);
    });

    it("groups entities by batchSizeEntity and counts each group once per level", async () => {
        const ids = Array.from({ length: 12 }, (_, i) => `7a1d3c55-0b2e-4f6a-8c9d-00000000${String(i).padStart(4, "0")}`);
        const points = Object.fromEntries(ids.map((id) => [id, { rows: every("2026-09-01T00:00:00Z", 24, HOUR) }]));
        const { ws, fake } = client(points);
        await ws.batch.hisDelete(ids, RANGE);
        const dayCounts = counts(fake).filter((r) => r.unit === "DAY");
        expect(dayCounts.map((r) => r.ids)).to.eql([ids.slice(0, 10), ids.slice(10)]);
        expect(Math.max(...deletes(fake).map((r) => r.ids.length))).to.be.at.most(10);
        for (const id of ids) expect(fake.rows(id)).to.eql([]);
    });

    it("still sends one whole-range request for a group with no data", async () => {
        const { ws, fake } = client({ [PT.chwFlowTemp]: { rows: [] } });
        await ws.batch.hisDelete([PT.chwFlowTemp], RANGE);
        expect(deletes(fake).map((r) => r.range)).to.eql([RANGE]);
    });

    it("returns each response when returnResult is set", async () => {
        const { ws } = client({ [PT.chwFlowTemp]: { rows: every("2026-09-01T00:00:00Z", 1440, MIN) } });
        const res = await ws.batch.hisDelete([PT.chwFlowTemp], RANGE, { returnResult: true });
        const deletedRows = res.success.reduce((n, grid) => n + grid.rows.length, 0);
        expect(deletedRows).to.equal(1440);
    });
    it("treats a null option as absent, so the configured retries still apply", async () => {
        const { ws, fake } = client(
            { [PT.chwFlowTemp]: { rows: every("2026-09-01T00:00:00Z", 60, MIN) } },
            {},
            { batch: { hisDelete: { retries: 1 } } });
        fake.failNext((r) => r.uri === "/api/hisDelete", () => haystackError(503, "upstream unavailable"), 1);
        const res = await ws.batch.hisDelete([PT.chwFlowTemp], RANGE, { retries: null, retryDelay: 0 });
        expect(res.errors).to.eql([]);
        expect(fake.rows(PT.chwFlowTemp)).to.eql([]);
        expect(deletes(fake)).to.have.length(2);
    });
    describe("ranges without an offset", () => {
        const moment = require("moment-timezone");
        const BNE = "b1e2c3d4-0000-4a5b-8c9d-0000000000b1";   // tz Brisbane, UTC+10
        const NYC = "e5f6a7b8-0000-4a5b-8c9d-0000000000e5";   // tz New_York, UTC-4 in September
        const RANGE_LOCAL = "2026-09-01,2026-09-03";          // three whole local days
        // Dense 1-second data in the first and last local hour, 1-minute data between, and one
        // row a millisecond either side of the local range.
        function localPoint(hsTz, ianaTz) {
            const from = moment.tz("2026-09-01", ianaTz).valueOf();
            const to = moment.tz("2026-09-04", ianaTz).valueOf();
            const rows = [from - 1, to];
            for (let ms = from; ms < from + HOUR; ms += 1000) rows.push(ms);
            for (let ms = from + HOUR; ms < to - HOUR; ms += MIN) rows.push(ms);
            for (let ms = to - HOUR; ms < to; ms += 1000) rows.push(ms);
            return { tz: hsTz, rows, outside: [from - 1, to], from, to };
        }
        const two = () => {
            const bne = localPoint("Brisbane", "Australia/Brisbane");
            const nyc = localPoint("New_York", "America/New_York");
            return { bne, nyc, ...client({ [BNE]: bne, [NYC]: nyc }) };
        };

        it("deletes each point's whole local range and nothing outside it", async () => {
            const { bne, nyc, ws, fake } = two();
            const res = await ws.batch.hisDelete([BNE, NYC], RANGE_LOCAL);
            expect(res.errors).to.eql([]);
            expect(fake.rows(BNE)).to.eql(bne.outside);
            expect(fake.rows(NYC)).to.eql(nyc.outside);
        });

        it("reads each group once to learn point timezones", async () => {
            const { ws, fake } = two();
            await ws.batch.hisDelete([BNE, NYC], RANGE_LOCAL);
            expect(fake.requests.filter((r) => r.uri === "/api/read").map((r) => r.ids)).to.eql([[BNE, NYC]]);
        });

        it("keeps requests within budget despite dense data at both local ends", async () => {
            const { ws, fake } = two();
            await ws.batch.hisDelete([BNE, NYC], RANGE_LOCAL, { maxBisectDepth: 0 });
            for (const r of deletes(fake)) {
                expect(Math.max(...r.deleted), r.range).to.be.at.most(500);
            }
        });

        it("places interior boundaries inside each point's local range", async () => {
            const { bne, nyc, ws, fake } = two();
            await ws.batch.hisDelete([BNE, NYC], RANGE_LOCAL);
            for (const [id, p] of [[BNE, bne], [NYC, nyc]]) {
                const mine = deletes(fake).filter((r) => r.ids.includes(id));
                const interior = mine.slice(1).map((r) => Date.parse(r.range.replace(/^s:/, "").split(",")[0]));
                expect(interior.length).to.be.greaterThan(0);
                for (const b of interior) expect(b).to.be.within(p.from + 1, p.to - 1);
                expect(mine[0].range.startsWith("s:2026-09-01,")).to.be.true;
                expect(mine[mine.length - 1].range.endsWith(",2026-09-03")).to.be.true;
            }
        });

        it("falls back to the 14-hour margin for a point with no timezone", async () => {
            const NOTZ = "0a0b0c0d-0000-4a5b-8c9d-00000000000a";
            // The fake resolves a point without tz in UTC; data is 1-minute across the UTC days.
            const from = Date.parse("2026-09-01T00:00:00Z"), to = Date.parse("2026-09-04T00:00:00Z");
            const rows = [from - 1, ...every("2026-09-01T00:00:00Z", 3 * 1440, MIN), to];
            const { ws, fake } = client({ [NOTZ]: { tz: null, rows } });
            const warn = ws.logger.warn;   // StubLogger already stubs warn; read its recorded calls
            const res = await ws.batch.hisDelete([NOTZ], RANGE_LOCAL);
            expect(res.errors).to.eql([]);
            expect(fake.rows(NOTZ)).to.eql([from - 1, to]);
            expect(warn.getCalls().some((c) => c.args.join(" ").includes("14 h margin"))).to.be.true;
            const interior = deletes(fake).slice(1).map((r) => Date.parse(r.range.replace(/^s:/, "").split(",")[0]));
            for (const b of interior) expect(b).to.be.within(from + 14 * HOUR, to - 14 * HOUR);
        });

        it("skips a group whose timezone read fails, and deletes nothing from it", async () => {
            const { bne, ws, fake } = two();
            const { haystackError } = require("./fakeHistoryServer");
            fake.failNext((r) => r.uri === "/api/read", () => haystackError(500, "Read failed"));
            const res = await ws.batch.hisDelete([BNE, NYC], RANGE_LOCAL);
            expect(res.errors).to.eql([{ error: "Read failed", args: ["countQuery", [BNE, NYC], RANGE_LOCAL] }]);
            expect(deletes(fake)).to.eql([]);
            expect(fake.rows(BNE)).to.have.length(bne.rows.length);
        });
    });

    describe("relative ranges", () => {
        it("sends yesterday as one request per group without counting", async () => {
            const id = PT.chwFlowTemp;
            const moment = require("moment-timezone");
            const yStart = moment.tz(Date.parse("2026-09-30T02:00:00Z"), "UTC").startOf("day").subtract(1, "day").valueOf();
            const { ws, fake } = client({ [id]: { rows: [yStart - 1, ...every(new Date(yStart).toISOString(), 1440, MIN)] } });
            await ws.batch.hisDelete([id], "yesterday");
            expect(counts(fake)).to.eql([]);
            expect(deletes(fake).map((r) => r.range)).to.eql(["s:yesterday"]);
            expect(fake.rows(id)).to.eql([yStart - 1]);
        });
    });

    describe("failures", () => {
        const id = PT.chwFlowTemp;
        const day = () => ({ [id]: { rows: every("2026-09-01T00:00:00Z", 1440, MIN) } });
        const isDelete = (r) => r.uri === "/api/hisDelete";

        it("retries a 503 and a reset connection, then succeeds", async () => {
            for (const makeError of [() => haystackError(503, "Service Unavailable"), () => networkError("ECONNRESET")]) {
                const { ws, fake } = client(day());
                fake.failNext(isDelete, makeError);
                const res = await ws.batch.hisDelete([id], RANGE, { retries: 2, retryDelay: 0 });
                expect(res.errors).to.eql([]);
                expect(fake.rows(id)).to.eql([]);
            }
        });

        it("does not retry by default", async () => {
            const { ws, fake } = client(day());
            fake.failNext(isDelete, () => haystackError(503, "Service Unavailable"));
            const res = await ws.batch.hisDelete([id], RANGE);
            expect(res.errors).to.have.length(1);
            expect(res.errors[0].args[0]).to.equal("hisDelete");
        });

        it("does not retry a 400 or a 429", async () => {
            for (const status of [400, 429]) {
                // Ten rows: the plan is exactly one request, so any retry shows as a second attempt.
                const { ws, fake } = client({ [id]: { rows: every("2026-09-01T00:00:00Z", 10, MIN) } });
                fake.failNext(isDelete, () => haystackError(status, "Rejected"), 5);
                const res = await ws.batch.hisDelete([id], RANGE, { retries: 3, retryDelay: 0 });
                expect(fake.requests.filter(isDelete), `status ${status}`).to.have.length(1);
                expect(res.errors).to.have.length(1);
            }
        });

        it("bisects instead of retrying when a retryable status carries the record-limit text", async () => {
            // Ten rows: the plan is one request. A 503 whose body is the record-limit message is a
            // size problem, so a retry of the same request cannot help; it is halved (1 + 2 requests).
            const { ws, fake } = client({ [id]: { rows: every("2026-09-01T00:00:00Z", 10, MIN) } });
            fake.failNext(isDelete, () => haystackError(503, "data points per entity cannot exceed 100"));
            const res = await ws.batch.hisDelete([id], RANGE, { retries: 2, retryDelay: 0 });
            expect(res.errors).to.eql([]);
            expect(fake.requests.filter(isDelete)).to.have.length(3);
            expect(fake.rows(id)).to.eql([]);
        });

        it("bisects a request rejected for the record limit and keeps the other results", async () => {
            // Plan against 1500 rows; 400 more arrive after planning, so the one request is too big.
            const { ws, fake } = client({ [id]: { rows: every("2026-09-01T00:00:00Z", 1500, MIN) } }, { recordLimit: 1500 });
            fake.beforeFirstDelete((server) => {
                server.points.get(id).rows.push(...every("2026-09-02T02:00:00Z", 400, MIN));
                server.points.get(id).rows.sort((a, b) => a - b);
            });
            const res = await ws.batch.hisDelete([id], RANGE, { batchSize: 1500, returnResult: true });
            expect(res.errors).to.eql([]);
            expect(fake.rows(id)).to.eql([]);
            expect(res.success.reduce((n, g) => n + g.rows.length, 0)).to.equal(1900);
        });

        it("reports the request instead of bisecting when maxBisectDepth is 0", async () => {
            // Planned at up to 1500 rows per request against a server that rejects over 100.
            const { ws, fake } = client({ [id]: { rows: every("2026-09-01T00:00:00Z", 2000, 1000) } }, { recordLimit: 100 });
            const res = await ws.batch.hisDelete([id], RANGE, { batchSize: 1500, maxBisectDepth: 0 });
            const attempts = fake.requests.filter(isDelete);
            expect(attempts.length).to.be.greaterThan(0);
            expect(res.errors).to.have.length(attempts.length);      // one error per planned request, none halved
            for (const e of res.errors) {
                expect(e.error).to.include("data points per entity cannot exceed");
                expect(e.args[0]).to.equal("hisDelete");
            }
            expect(fake.rows(id)).to.have.length(2000);
        });

        it("stops halving at maxBisectDepth", async () => {
            // The server rejects any request holding a row. Ten rows in the first ten minutes keep
            // landing in the earlier half, so each level retries one failing half and one empty
            // half: 1 + 2 + 2 attempts, and the depth cap leaves one reported failure.
            const { ws, fake } = client({ [id]: { rows: every("2026-09-01T00:00:00Z", 10, MIN) } }, { recordLimit: 0 });
            const res = await ws.batch.hisDelete([id], RANGE, { maxBisectDepth: 2 });
            expect(fake.requests.filter(isDelete)).to.have.length(5);
            expect(res.errors).to.have.length(1);
            expect(fake.rows(id)).to.have.length(10);
        });

        it("skips only the group whose count query fails", async () => {
            const ids = Array.from({ length: 12 }, (_, i) => `7a1d3c55-0b2e-4f6a-8c9d-10000000${String(i).padStart(4, "0")}`);
            const points = Object.fromEntries(ids.map((x) => [x, { rows: every("2026-09-01T00:00:00Z", 24, HOUR) }]));
            const { ws, fake } = client(points);
            fake.failNext((r) => r.uri === "/graphql" && r.ids.includes(ids[11]), () => haystackError(500, "Count failed"));
            const res = await ws.batch.hisDelete(ids, RANGE);
            expect(res.errors.map((e) => e.args[0])).to.eql(["countQuery"]);
            expect(res.errors[0].args[1]).to.eql(ids.slice(10));
            for (const x of ids.slice(0, 10)) expect(fake.rows(x)).to.eql([]);
            for (const x of ids.slice(10)) expect(fake.rows(x)).to.have.length(24);
        });

        it("skips only the group whose timezone read fails and carries on with the others", async () => {
            // Offset-less range: each group is read for its tz first. A failed read is treated like a
            // failed count for that group alone.
            const ids = Array.from({ length: 12 }, (_, i) => `8b2e4d66-1c3f-4a7b-9d0e-20000000${String(i).padStart(4, "0")}`);
            const points = Object.fromEntries(ids.map((x) => [x, { tz: "Brisbane", rows: every("2026-09-01T00:00:00+10:00", 24, HOUR) }]));
            const { ws, fake } = client(points);
            const range = "2026-09-01,2026-09-03";
            fake.failNext((r) => r.uri === "/api/read" && r.ids.includes(ids[11]), () => haystackError(500, "Read failed"));
            const res = await ws.batch.hisDelete(ids, range);
            expect(res.errors).to.eql([{ error: "Read failed", args: ["countQuery", ids.slice(10), range] }]);
            for (const x of ids.slice(0, 10)) expect(fake.rows(x), x).to.eql([]);
            for (const x of ids.slice(10)) expect(fake.rows(x), x).to.have.length(24);
        });

        it("treats a GraphQL error body as a failed count", async () => {
            const { ws, fake } = client(day());
            const original = fake.count.bind(fake);
            fake.count = () => ({ errors: [{ message: "Cannot query data by group" }] });
            const res = await ws.batch.hisDelete([id], RANGE);
            fake.count = original;
            expect(res.errors).to.eql([{ error: "Cannot query data by group", args: ["countQuery", [id], RANGE] }]);
            expect(fake.rows(id)).to.have.length(1440);
        });

        it("runs requests in parallel without losing any", async () => {
            const { ws, fake } = client({ [id]: { rows: every("2026-09-01T00:00:00Z", 3 * 1440, MIN) } });
            const res = await ws.batch.hisDelete([id], RANGE, { parallel: 3 });
            expect(res.errors).to.eql([]);
            expect(fake.rows(id)).to.eql([]);
        });
    });
});
