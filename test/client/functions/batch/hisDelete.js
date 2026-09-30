"use strict";

const expect = require("chai").expect;
const stubs = require("../../../stubs");
const { FakeHistoryServer, haystackError } = require("./fakeHistoryServer");

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
});
