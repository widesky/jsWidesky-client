"use strict";

const expect = require("chai").expect;
const stubs = require("../../../stubs");
const moment = require("moment-timezone");
const sinon = require("sinon");
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
// Range tokens: "2026-09-01T00:00:00Z", or "2026-09-01T10:00:00.000+10:00 Brisbane".
const ends = (r) => r.range.replace(/^s:/, "").split(",");
const tokMs = (tok) => Date.parse(tok.split(" ")[0]);

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

        it("keeps every request within the row budget", async () => {
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
            const res = await ws.batch.hisDelete([PT.chwFlowTemp], range);
            expect(res.errors).to.eql([]);
            const ranges = deletes(fake).map((r) => r.range);
            expect(ranges.length).to.be.greaterThan(1);
            expect(ranges[0].startsWith("s:2026-09-01T10:00:00+10:00 Brisbane,")).to.be.true;
            expect(ranges[ranges.length - 1].endsWith(",2026-09-04T10:00:00+10:00 Brisbane")).to.be.true;
            // Interior boundaries are written in the same zone with the same name.
            for (const r of deletes(fake).slice(1)) {
                expect(ends(r)[0]).to.match(/^2026-09-0\dT\d{2}:\d{2}:\d{2}\.\d{3}\+10:00 Brisbane$/);
            }
            expect(fake.rows(PT.chwFlowTemp)).to.eql([...outsideBefore, ...outsideAfter].sort((a, b) => a - b));
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

    it("keeps the rows of each request within batchSize summed over all its points", async () => {
        // Each point alone (400 rows) fits the 500-row budget; together (1200) they do not.
        const points = Object.fromEntries([PT.chwFlowTemp, PT.chwReturnTemp, PT.boilerKw]
            .map((id) => [id, { rows: every("2026-09-01T00:00:00Z", 400, 10 * MIN) }]));
        const { ws, fake } = client(points);
        const res = await ws.batch.hisDelete(Object.keys(points), RANGE);
        expect(res.errors).to.eql([]);
        const totals = deletes(fake).map((r) => r.deleted.reduce((a, b) => a + b, 0));
        expect(Math.max(...totals)).to.be.at.most(500);
        expect(totals.reduce((a, b) => a + b, 0)).to.equal(1200);
        for (const r of deletes(fake)) expect(r.ids).to.have.length(3);
        for (const id of Object.keys(points)) expect(fake.rows(id)).to.eql([]);
    });

    it("keeps a minute whose rows are bunched at its start within batchSize", async () => {
        // 5 meters logging 4 rows/s from 05:00:00 to 05:02:30: the 05:02 minute holds 600 rows, all
        // in its first 30 s, so equal time slices of that minute would put 400 rows in the first.
        const meters = Array.from({ length: 5 }, (_, i) => `e1ec7a1c-3b2d-4c5e-9f60-00000000000${i}`);
        const points = Object.fromEntries(meters.map((id) => [id, { rows: every("2026-09-02T05:00:00Z", 600, 250) }]));
        const { ws, fake } = client(points);
        const res = await ws.batch.hisDelete(meters, RANGE, { batchSize: 200 });
        expect(res.errors).to.eql([]);
        const totals = deletes(fake).map((r) => r.deleted.reduce((a, b) => a + b, 0));
        expect(Math.max(...totals)).to.be.at.most(200);
        expect(totals.reduce((a, b) => a + b, 0)).to.equal(3000);
        for (const id of meters) expect(fake.rows(id)).to.eql([]);
    });

    it("puts fewer points in a request when batchSize is below batchSizeEntity", async () => {
        // 10 points logging on the same minute stamps: 10 rows share every instant, so a 4-row
        // budget can only hold if a request names at most 4 points.
        const ids = Array.from({ length: 10 }, (_, i) => `a11a57a0-3b2d-4c5e-9f60-0000000000${String(i).padStart(2, "0")}`);
        const points = Object.fromEntries(ids.map((id) => [id, { rows: every("2026-09-01T00:00:00Z", 30, MIN) }]));
        const { ws, fake } = client(points);
        const res = await ws.batch.hisDelete(ids, RANGE, { batchSize: 4 });
        expect(res.errors).to.eql([]);
        for (const r of deletes(fake)) {
            expect(r.ids.length, r.range).to.be.at.most(4);
            expect(r.deleted.reduce((a, b) => a + b, 0), r.range).to.be.at.most(4);
        }
        for (const id of ids) expect(fake.rows(id)).to.eql([]);
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
    it("rejects a range that is neither a string nor two Dates", async () => {
        const { ws, fake } = client({ [PT.chwFlowTemp]: { rows: every("2026-09-01T00:00:00Z", 10, MIN) } });
        for (const args of [[new Date(START)], [new Date(START), "2026-09-04"], [START, END]]) {
            let thrown;
            try {
                await ws.batch.hisDelete([PT.chwFlowTemp], ...args);
            } catch (error) {
                thrown = error;
            }
            expect(thrown && thrown.message).to.equal(
                "range must be a Haystack range string, or timeStart and timeEnd must both be Date objects");
        }
        expect(fake.requests).to.eql([]);
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
                expect(r.deleted.reduce((a, b) => a + b, 0), r.range).to.be.at.most(500);
            }
        });

        it("places interior boundaries inside each point's local range", async () => {
            const { bne, nyc, ws, fake } = two();
            await ws.batch.hisDelete([BNE, NYC], RANGE_LOCAL);
            for (const [id, p] of [[BNE, bne], [NYC, nyc]]) {
                const mine = deletes(fake).filter((r) => r.ids.includes(id));
                const interior = mine.slice(1).map((r) => tokMs(ends(r)[0]));
                expect(interior.length).to.be.greaterThan(0);
                for (const b of interior) expect(b).to.be.within(p.from + 1, p.to - 1);
            }
        });

        it("writes every request of a split plan as datetimes in the point's zone and tz name", async () => {
            const { ws, fake } = two();
            const res = await ws.batch.hisDelete([BNE, NYC], RANGE_LOCAL);
            expect(res.errors).to.eql([]);
            for (const [id, first, last, name] of [
                [BNE, "2026-09-01T00:00:00.000+10:00 Brisbane", "2026-09-04T00:00:00.000+10:00 Brisbane", "Brisbane"],
                [NYC, "2026-09-01T00:00:00.000-04:00 New_York", "2026-09-04T00:00:00.000-04:00 New_York", "New_York"]
            ]) {
                const mine = deletes(fake).filter((r) => r.ids.includes(id));
                expect(mine.length, id).to.be.greaterThan(1);
                expect(ends(mine[0])[0]).to.equal(first);
                expect(ends(mine[mine.length - 1])[1]).to.equal(last);
                for (const r of mine) for (const tok of ends(r)) expect(tok.endsWith(` ${name}`), tok).to.be.true;
            }
        });

        it("sends a date-only range verbatim when it needs only one request", async () => {
            const bne = localPoint("Brisbane", "Australia/Brisbane");
            const { ws, fake } = client({ [BNE]: { tz: "Brisbane", rows: [bne.from - 1, bne.from, bne.to - 1, bne.to] } });
            await ws.batch.hisDelete([BNE], RANGE_LOCAL);
            expect(deletes(fake).map((r) => r.range)).to.eql([`s:${RANGE_LOCAL}`]);
            expect(fake.rows(BNE)).to.eql([bne.from - 1, bne.to]);
        });

        it("bisects a date-only request in the point's zone form", async () => {
            // Planned as one verbatim request; rows arriving after planning push it over the limit.
            const bne = localPoint("Brisbane", "Australia/Brisbane");
            const rows = every(new Date(bne.from).toISOString(), 1500, MIN);
            const { ws, fake } = client({ [BNE]: { tz: "Brisbane", rows } });
            fake.beforeFirstDelete((server) => {
                server.points.get(BNE).rows.push(...every(new Date(bne.from + 2 * DAY).toISOString(), 400, MIN));
                server.points.get(BNE).rows.sort((a, b) => a - b);
            });
            const res = await ws.batch.hisDelete([BNE], RANGE_LOCAL, { batchSize: 1500 });
            expect(res.errors).to.eql([]);
            expect(fake.rows(BNE)).to.eql([]);
            const sent = deletes(fake).map((r) => r.range);
            expect(sent[0]).to.equal(`s:${RANGE_LOCAL}`);
            expect(sent.slice(1)).to.eql([
                "s:2026-09-01T00:00:00.000+10:00 Brisbane,2026-09-02T12:00:00.000+10:00 Brisbane",
                "s:2026-09-02T12:00:00.000+10:00 Brisbane,2026-09-04T00:00:00.000+10:00 Brisbane"
            ]);
        });

        it("reports and does not delete from points with no or an unmappable timezone", async () => {
            const NOTZ = "0a0b0c0d-0000-4a5b-8c9d-00000000000a";
            const ODDTZ = "0a0b0c0d-0000-4a5b-8c9d-00000000000b";
            const rows = every("2026-09-01T00:00:00Z", 3 * 24, HOUR);
            const { ws, fake } = client({ [NOTZ]: { tz: null, rows }, [ODDTZ]: { tz: "Mawson_Station", rows }, [BNE]: localPoint("Brisbane", "Australia/Brisbane") });
            const res = await ws.batch.hisDelete([NOTZ, ODDTZ, BNE], RANGE_LOCAL);
            expect(res.errors.map((e) => e.args)).to.eql([["plan", [NOTZ], RANGE_LOCAL], ["plan", [ODDTZ], RANGE_LOCAL]]);
            for (const e of res.errors) expect(e.error).to.match(/^not sent: no usable timezone/);
            expect(fake.rows(NOTZ)).to.eql(rows);
            expect(fake.rows(ODDTZ)).to.eql(rows);
            for (const id of [NOTZ, ODDTZ]) {
                expect(deletes(fake).some((r) => r.ids.includes(id)), id).to.be.false;
                expect(counts(fake).some((r) => r.ids.includes(id)), id).to.be.false;
            }
            // The Brisbane point in the same group is still planned and split.
            expect(deletes(fake).filter((r) => r.ids.includes(BNE)).length).to.be.greaterThan(1);
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

        describe("in a zone whose offset is not a whole number of hours", () => {
            // The API server reads "+09:30" as +39:00 (HZincReader: tzHours*60 + tzMins*60 minutes)
            // but reads a zero offset with a zone name as local wall time in that zone. A split
            // plan for these zones writes local wall time + "+00:00 <Name>"; the fake resolves
            // tokens exactly as the server does, so a wrong form deletes the wrong rows.
            const ADL = "ad1e2c3d-0000-4a5b-8c9d-0000000000ad";   // Adelaide, +09:30 / +10:30 (DST)
            const WALL_TOK = (name) => new RegExp(`^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}\\+00:00 ${name}$`);

            for (const [hsTz, ianaTz, range, first, last] of [
                ["Adelaide", "Australia/Adelaide", RANGE_LOCAL, "2026-09-01", "2026-09-04"],
                // Crosses Adelaide's DST start (2026-10-04 02:00, +09:30 -> +10:30).
                ["Adelaide", "Australia/Adelaide", "2026-10-03,2026-10-05", "2026-10-03", "2026-10-06"],
                ["Kathmandu", "Asia/Kathmandu", RANGE_LOCAL, "2026-09-01", "2026-09-04"],
                ["St_Johns", "America/St_Johns", RANGE_LOCAL, "2026-09-01", "2026-09-04"]
            ]) {
                it(`deletes exactly the local days of ${range} on a ${hsTz} point, in wall-time tokens`, async () => {
                    const [from, to] = [first, last].map((d) => moment.tz(d, ianaTz).valueOf());
                    const rows = [from - 1, to];
                    for (let ms = from; ms < from + HOUR; ms += 1000) rows.push(ms);
                    for (let ms = from + HOUR; ms < to - HOUR; ms += MIN) rows.push(ms);
                    for (let ms = to - HOUR; ms < to; ms += 1000) rows.push(ms);
                    const { ws, fake } = client({ [ADL]: { tz: hsTz, rows } });
                    const res = await ws.batch.hisDelete([ADL], range, { maxBisectDepth: 0 });
                    expect(res.errors).to.eql([]);
                    expect(fake.rows(ADL)).to.eql([from - 1, to]);
                    const sent = deletes(fake);
                    expect(sent.length).to.be.greaterThan(1);
                    expect(ends(sent[0])[0]).to.equal(`${first}T00:00:00.000+00:00 ${hsTz}`);
                    expect(ends(sent[sent.length - 1])[1]).to.equal(`${last}T00:00:00.000+00:00 ${hsTz}`);
                    for (const r of sent) {
                        for (const tok of ends(r)) expect(tok, tok).to.match(WALL_TOK(hsTz));
                        expect(r.deleted[0], r.range).to.be.at.most(500);
                    }
                });
            }

            it("bisects an Adelaide date-only request at a wall-time midpoint", async () => {
                const from = moment.tz("2026-09-01", "Australia/Adelaide").valueOf();
                const rows = every(new Date(from).toISOString(), 1500, MIN);
                const { ws, fake } = client({ [ADL]: { tz: "Adelaide", rows: [from - 1, ...rows] } });
                fake.beforeFirstDelete((server) => {
                    server.points.get(ADL).rows.push(...every(new Date(from + 2 * DAY).toISOString(), 400, MIN));
                    server.points.get(ADL).rows.sort((a, b) => a - b);
                });
                const res = await ws.batch.hisDelete([ADL], RANGE_LOCAL, { batchSize: 1500 });
                expect(res.errors).to.eql([]);
                expect(fake.rows(ADL)).to.eql([from - 1]);
                const sent = deletes(fake).map((r) => r.range);
                expect(sent[0]).to.equal(`s:${RANGE_LOCAL}`);
                expect(sent.slice(1)).to.eql([
                    "s:2026-09-01T00:00:00.000+00:00 Adelaide,2026-09-02T12:00:00.000+00:00 Adelaide",
                    "s:2026-09-02T12:00:00.000+00:00 Adelaide,2026-09-04T00:00:00.000+00:00 Adelaide"
                ]);
            });

            it("never cuts inside the hour a DST change repeats when the token would be wall time", async () => {
                // London falls back 2026-10-25 01:00Z: wall 01:00-02:00 GMT ("+00:00 London") occurs
                // twice, so the server could read such a cut an hour early.
                const LON = "1d0e2c3d-0000-4a5b-8c9d-00000000001d";
                const from = moment.tz("2026-10-24", "Europe/London").valueOf();
                const to = moment.tz("2026-10-26", "Europe/London").valueOf();
                const rows = [from - 1, ...every(new Date(from).toISOString(), (to - from) / MIN, MIN), to];
                const { ws, fake } = client({ [LON]: { tz: "London", rows } });
                // 61: the 00:59Z minute (BST) plus the 60 GMT minutes that cannot be cut from it.
                const res = await ws.batch.hisDelete([LON], "2026-10-24,2026-10-25", { batchSize: 61 });
                expect(res.errors).to.eql([]);
                expect(fake.rows(LON)).to.eql([from - 1, to]);
                const toks = deletes(fake).flatMap(ends);
                expect(toks.length).to.be.greaterThan(2);
                expect(toks.filter((tok) => /^2026-10-25T01:\d{2}:\d{2}\.\d{3}\+00:00 London$/.test(tok))).to.eql([]);
            });

            it("keeps the real-offset form for a whole-hour zone in the same group", async () => {
                const adl = localPoint("Adelaide", "Australia/Adelaide");
                const bne = localPoint("Brisbane", "Australia/Brisbane");
                const { ws, fake } = client({ [ADL]: adl, [BNE]: bne });
                const res = await ws.batch.hisDelete([ADL, BNE], RANGE_LOCAL);
                expect(res.errors).to.eql([]);
                expect(fake.rows(ADL)).to.eql(adl.outside);
                expect(fake.rows(BNE)).to.eql(bne.outside);
                const mine = deletes(fake).filter((r) => r.ids.includes(BNE));
                expect(mine.length).to.be.greaterThan(1);
                for (const r of mine) {
                    for (const tok of ends(r)) expect(tok, tok).to.match(/^2026-09-0\dT\d{2}:\d{2}:\d{2}\.\d{3}\+10:00 Brisbane$/);
                }
            });
        });
    });

    describe("ranges in part-hour zones that are left unsplit", () => {
        // The server misreads a "+hh:mm" offset with minutes by (minutes x 59) minutes, so cuts
        // written in a part-hour zone's real offset would land far from where they are meant.
        // These are sent as one request, the caller's range verbatim, and the server decides.
        const ADL = "ad1e2c3d-0000-4a5b-8c9d-0000000000ad";
        const LHI = "10e0a1b2-0000-4a5b-8c9d-0000000010e0";
        const BNE = "b0e1a2c3-0000-4a5b-8c9d-0000000000b0";
        const minuteRows = (fromMs, days) => Array.from({ length: days * 1440 }, (_, i) => fromMs + i * MIN);

        for (const [label, id, tz, range, days, reason] of [
            ["a +10:00 Adelaide named range", ADL, "Adelaide",
                "2026-06-01T00:00:00+10:00 Adelaide,2026-06-04T00:00:00+10:00 Adelaide", "2026-05-30", /part-hour UTC offset/],
            // Lord_Howe springs forward 2026-10-04 02:00 (+10:30 -> +11:00).
            ["a date-only range containing Lord_Howe's 30-minute DST change", LHI, "Lord_Howe",
                "2026-10-03,2026-10-05", "2026-10-02", /not a whole number of hours/],
            // DST ends 2026-04-05 02:00 local (+11:00 -> +10:30).
            ["a Lord_Howe named range containing its April DST change", LHI, "Lord_Howe",
                "2026-04-04T00:00:00+11:00 Lord_Howe,2026-04-07T00:00:00+11:00 Lord_Howe", "2026-04-03", /not a whole number of hours/]
        ]) {
            it(`reports ${label} and deletes nothing`, async () => {
                const rows = minuteRows(t(`${days}T00:00:00Z`), 7);
                const { ws, fake } = client({ [id]: { tz, rows } });
                const res = await ws.batch.hisDelete([id], range);
                expect(res.errors.map((e) => e.args)).to.eql([["plan", [id], range]]);
                expect(res.errors[0].error).to.match(reason);
                expect(counts(fake)).to.eql([]);
                expect(deletes(fake)).to.eql([]);
                expect(fake.rows(id)).to.eql(rows);
            });
        }

        it("still plans a Lord_Howe date-only range with no DST change, in wall-time tokens", async () => {
            const from = moment.tz("2026-09-01", "Australia/Lord_Howe").valueOf();
            const to = moment.tz("2026-09-04", "Australia/Lord_Howe").valueOf();
            const rows = [from - 1, to, ...minuteRows(from, 3)];
            const { ws, fake } = client({ [LHI]: { tz: "Lord_Howe", rows } });
            const res = await ws.batch.hisDelete([LHI], "2026-09-01,2026-09-03");
            expect(res.errors).to.eql([]);
            expect(fake.rows(LHI)).to.eql([from - 1, to]);
            const sent = deletes(fake);
            expect(sent.length).to.be.greaterThan(1);
            for (const r of sent) {
                for (const tok of ends(r)) expect(tok, tok).to.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00 Lord_Howe$/);
            }
        });

        for (const range of [
            "2026-06-01T00:00:00+10:00 Brisbane,2026-06-04T00:00:00+10:00 Brisbane",
            "2026-06-01,2026-06-03"
        ]) {
            it(`keeps writing Brisbane splits of ${range} with the real +10:00 offset`, async () => {
                const rows = minuteRows(t("2026-06-01T00:00:00+10:00"), 3);
                const { ws, fake } = client({ [BNE]: { tz: "Brisbane", rows } });
                await ws.batch.hisDelete([BNE], range);
                const sent = deletes(fake);
                expect(sent.length).to.be.greaterThan(1);
                for (const r of sent) {
                    for (const tok of ends(r)) expect(tok, tok).to.match(/\+10:00 Brisbane$/);
                }
            });
        }
    });

    describe("a repeated daylight-saving hour", () => {
        // London falls back 2026-10-25 02:00 BST -> 01:00 GMT. The GMT pass of 01:00-02:00 would be
        // written "+00:00 London", which the server reads as the earlier (BST) pass, so no cut can
        // go there.
        const LDN = "10d0e1f2-0000-4a5b-8c9d-0000000010d0";
        const RANGE_LDN = "2026-10-24,2026-10-26";
        const bst = every("2026-10-25T00:10:00Z", 600, 1000);   // 01:10-01:20 BST: cuttable
        const gmt = every("2026-10-25T01:10:00Z", 600, 1000);   // 01:10-01:20 GMT: not cuttable

        it("reports a group whose rows in that hour exceed batchSize, and deletes nothing", async () => {
            const { ws, fake } = client({ [LDN]: { tz: "London", rows: [...bst, ...gmt] } });
            const res = await ws.batch.hisDelete([LDN], RANGE_LDN, { batchSize: 200 });
            expect(res.errors.map((e) => e.args)).to.eql([["plan", [LDN], RANGE_LDN]]);
            expect(res.errors[0].error).to.match(/^not sent: .*more than batchSize \(200\) rows/);
            expect(deletes(fake)).to.eql([]);
            expect(fake.rows(LDN)).to.eql([...bst, ...gmt]);
        });

        it("cuts before the hour when the first bucket of the range sits right before it", async () => {
            // 2026-10-25 in London opens 2026-10-24T23:00Z (BST midnight): 150 rows in that first
            // UTC hour (the first, clipped DAY bucket), nothing at 00:xxZ, 100 rows in the GMT pass
            // and 150 at noon, so the 10-25 UTC day is over budget and counted by the hour.
            const first = every("2026-10-24T23:10:00Z", 150, 1000);
            const inHour = every("2026-10-25T01:10:00Z", 100, 1000);
            const noon = every("2026-10-25T12:10:00Z", 150, 1000);
            const { ws, fake } = client({ [LDN]: { tz: "London", rows: [...first, ...inHour, ...noon] } });
            const res = await ws.batch.hisDelete([LDN], "2026-10-25", { batchSize: 200, countBucketUnits: ["DAY", "HOUR"] });
            expect(res.errors).to.eql([]);
            expect(deletes(fake).map((r) => r.deleted[0])).to.eql([150, 100, 150]);
            expect(fake.rows(LDN)).to.eql([]);
        });

        it("still plans the range when that hour fits in batchSize", async () => {
            // 02:00 GMT is not repeated, so a cut can go there, between the hour and later rows.
            const later = every("2026-10-25T03:00:00Z", 600, 1000);
            const { ws, fake } = client({ [LDN]: { tz: "London", rows: [...gmt, ...later] } });
            const res = await ws.batch.hisDelete([LDN], RANGE_LDN, { batchSize: 600 });
            expect(res.errors).to.eql([]);
            expect(deletes(fake).length).to.be.greaterThan(1);
            for (const r of deletes(fake)) expect(r.deleted[0], r.range).to.be.at.most(600);
            expect(fake.rows(LDN)).to.eql([]);
        });
    });

    describe("ranges the planner does not split", () => {
        // None of these can be cut into requests of at most batchSize rows, so none is sent: each
        // group gets one "plan" error and keeps its rows.
        for (const range of [
            "2026-09-01,2026-09-04T00:00:00Z",
            "2026-09-01T00:00:00+10:00,2026-09-04T00:00:00+10:00",
            "2026-09-01T00:00:00,2026-09-04T00:00:00",
            "2026-09-01T00:00:00+10:00 Brisbane,2026-09-04T00:00:00+10:00 Sydney",
            // The server requires seconds in a datetime.
            "2026-09-01T00:00Z,2026-09-04T00:00Z",
            "2026-09-01T00:00+10:00 Brisbane,2026-09-04T00:00+10:00 Brisbane",
            // The server ignores a zero offset and reads the wall time in the named zone, so these
            // name an instant other than the ISO one whenever the zone is not at UTC+0 then.
            "2026-09-01T00:00:00Z London,2026-09-04T00:00:00Z London",
            "2026-09-01T00:00:00+00:00 New_York,2026-09-04T00:00:00+00:00 New_York",
            // A single datetime runs to "now", which the client cannot pin.
            "2026-09-01T00:00:00Z"
        ]) {
            it(`reports ${range} and deletes nothing`, async () => {
                const rows = every("2026-09-01T00:00:00Z", 3 * 1440, MIN);
                const ids = [PT.chwFlowTemp, PT.chwReturnTemp];
                const { ws, fake } = client(Object.fromEntries(ids.map((id) => [id, { tz: "Brisbane", rows }])));
                const res = await ws.batch.hisDelete(ids, `s:${range}`);
                expect(res.errors).to.have.length(1);
                expect(res.errors[0].args).to.eql(["plan", ids, `s:${range}`]);
                expect(res.errors[0].error).to.match(/^not sent: .* is not a range batch\.hisDelete can split/);
                expect(counts(fake)).to.eql([]);
                expect(deletes(fake)).to.eql([]);
                for (const id of ids) expect(fake.rows(id)).to.eql(rows);
            });
        }

        for (const range of ["2026-09-01T00:00:00Z UTC,2026-09-04T00:00:00Z UTC",
            "2026-09-01T00:00:00+00:00 UTC,2026-09-04T00:00:00+00:00 UTC",
            // London is at UTC+0 in January, so its wall time is the ISO instant.
            "2026-01-05T00:00:00+00:00 London,2026-01-08T00:00:00+00:00 London"]) {
            it(`still plans ${range}`, async () => {
                const from = Date.parse(range.slice(0, 19) + "Z"), to = from + 3 * DAY;
                const rows = [from - 1, ...every(new Date(from).toISOString(), 3 * 1440, MIN), to];
                const { ws, fake } = client({ [PT.chwFlowTemp]: { tz: "Brisbane", rows } });
                const res = await ws.batch.hisDelete([PT.chwFlowTemp], range);
                expect(res.errors).to.eql([]);
                expect(deletes(fake).length).to.be.greaterThan(1);
                expect(Math.max(...deletes(fake).map((r) => r.deleted[0]))).to.be.at.most(500);
                expect(fake.rows(PT.chwFlowTemp)).to.eql([from - 1, to]);
            });
        }

        it("the fake accepts only the range forms the API server accepts", () => {
            const { parseRange } = require("./fakeHistoryServer");
            for (const ok of ["yesterday", "2026-09-01,2026-09-03", "2026-09-01T00:00:00Z,2026-09-02T00:00:00.000Z",
                "2026-09-01T00:00:00Z UTC,2026-09-02T00:00:00+00:00 UTC",
                "2026-09-01T00:00:00+10:00 Brisbane,2026-09-02T00:00:00.000+10:00 Brisbane"]) {
                expect(() => parseRange(`s:${ok}`), ok).to.not.throw();
            }
            for (const bad of ["2026-09-01T00:00:00Z,2026-09-02", "2026-09-01T00:00:00Z,2026-09-02T00:00:00+10:00 Brisbane",
                "2026-09-01T00:00:00+10:00,2026-09-02T00:00:00+10:00", "2026-09-01T00:00:00,2026-09-02T00:00:00",
                "2026-09-01T00:00Z,2026-09-02T00:00Z", "2026-09-01T00:00+10:00 Brisbane,2026-09-02T00:00+10:00 Brisbane"]) {
                expect(() => parseRange(`s:${bad}`), bad).to.throw();
            }
        });

        it("the fake reads datetime ends as the API server does", () => {
            const { parseRange } = require("./fakeHistoryServer");
            const at = (r) => { const { start, end } = parseRange(`s:${r}`); return [start.ms, end.ms]; };
            // Whole-hour offsets and "Z" / "UTC" are read as ISO 8601 instants.
            expect(at("2026-06-01T00:00:00+10:00 Brisbane,2026-06-02T00:00:00.500+10:00 Brisbane"))
                .to.eql([t("2026-05-31T14:00:00Z"), t("2026-06-01T14:00:00.500Z")]);
            expect(at("2026-06-01T00:00:00-04:00 New_York,2026-06-02T00:00:00-04:00 New_York"))
                .to.eql([t("2026-06-01T04:00:00Z"), t("2026-06-02T04:00:00Z")]);
            expect(at("2026-06-01T00:00:00Z,2026-06-02T00:00:00+00:00 UTC")).to.eql([t("2026-06-01T00:00:00Z"), t("2026-06-02T00:00:00Z")]);
            // A non-zero offset with minutes is applied as hours*60 + minutes*60 minutes: +09:30 -> +39:00.
            expect(at("2026-06-01T00:00:00+09:30 Adelaide,2026-06-02T00:00:00+09:30 Adelaide"))
                .to.eql([t("2026-06-01T00:00:00Z") - 39 * HOUR, t("2026-06-02T00:00:00Z") - 39 * HOUR]);
            expect(at("2026-06-01T00:00:00-02:30 St_Johns,2026-06-02T00:00:00-02:30 St_Johns"))
                .to.eql([t("2026-06-01T00:00:00Z") + 32 * HOUR, t("2026-06-02T00:00:00Z") + 32 * HOUR]);
            // A zero offset with a zone name is read as wall time in that zone.
            expect(at("2026-06-01T00:00:00+00:00 Adelaide,2026-06-02T00:00:00Z Adelaide"))
                .to.eql([t("2026-05-31T14:30:00Z"), t("2026-06-01T14:30:00Z")]);
            expect(at("2026-09-01T00:00:00Z London,2026-09-02T00:00:00+00:00 London"))
                .to.eql([t("2026-08-31T23:00:00Z"), t("2026-09-01T23:00:00Z")]);
        });
    });

    describe("id forms", () => {
        // client.hisDelete accepts "@<uuid>" and "r:<uuid> Dis"; planning must too.
        const BNE_ZINC = "c4d5e6f7-0000-4a5b-8c9d-0000000000c4";
        const BNE_DIS = "c4d5e6f7-0000-4a5b-8c9d-0000000000c5";
        const ids = [`@${BNE_ZINC}`, `r:${BNE_DIS} Plant Room CHW Flow Temp`];
        const points = () => ({
            [BNE_ZINC]: { tz: "Brisbane", rows: every("2026-08-31T14:00:00Z", 3 * 1440, MIN) },
            [BNE_DIS]: { tz: "Brisbane", rows: every("2026-08-31T14:00:00Z", 3 * 1440, MIN) }
        });

        it("counts and deletes points given as @uuid and r:uuid with a display name", async () => {
            const { ws, fake } = client(points());
            const res = await ws.batch.hisDelete(ids, "2026-08-31T14:00:00Z,2026-09-03T14:00:00Z");
            expect(res.errors).to.eql([]);
            expect(counts(fake)[0].ids).to.eql([BNE_ZINC, BNE_DIS]);
            expect(deletes(fake).length).to.be.greaterThan(1);
            expect(fake.rows(BNE_ZINC)).to.eql([]);
            expect(fake.rows(BNE_DIS)).to.eql([]);
        });

        it("reads their timezone and plans a date-only range in it", async () => {
            const { ws, fake } = client(points());
            const res = await ws.batch.hisDelete(ids, "2026-09-01,2026-09-03");
            expect(res.errors).to.eql([]);
            expect(fake.requests.filter((r) => r.uri === "/api/read").map((r) => r.ids)).to.eql([[BNE_ZINC, BNE_DIS]]);
            const sent = deletes(fake);
            expect(sent.length).to.be.greaterThan(1);
            for (const r of sent) for (const tok of ends(r)) expect(tok.endsWith(" Brisbane"), tok).to.be.true;
            expect(fake.rows(BNE_ZINC)).to.eql([]);
            expect(fake.rows(BNE_DIS)).to.eql([]);
        });
    });

    describe("relative ranges", () => {
        // The fake's "now" (2026-09-30T02:00Z) is 12:00 in Brisbane and 22:00 the day before in
        // New York, so "today" and "yesterday" are different dates in the two zones.
        const NOW = Date.parse("2026-09-30T02:00:00Z");
        const BNE = "b0e1a2c3-0000-4a5b-8c9d-0000000000b1", NYC = "4e0a1b2c-0000-4a5b-8c9d-0000000000e1";
        let clock;
        beforeEach(() => { clock = sinon.useFakeTimers({ now: NOW, toFake: ["Date"] }); });
        afterEach(() => clock.restore());

        for (const [keyword, bneDay, nycDay] of [["yesterday", "2026-09-29", "2026-09-28"], ["today", "2026-09-30", "2026-09-29"]]) {
            it(`resolves ${keyword} to explicit dates in each point's timezone and plans them`, async () => {
                const day = (d, z) => [moment.tz(d, z).valueOf(), moment.tz(d, z).add(1, "day").valueOf()];
                const [bFrom, bTo] = day(bneDay, "Australia/Brisbane"), [nFrom, nTo] = day(nycDay, "America/New_York");
                const minutes = (from, to) => Array.from({ length: (to - from) / MIN }, (_, i) => from + i * MIN);
                const { ws, fake } = client({
                    [BNE]: { tz: "Brisbane", rows: [bFrom - 1, ...minutes(bFrom, bTo), bTo] },
                    [NYC]: { tz: "New_York", rows: [nFrom - 1, ...minutes(nFrom, nTo), nTo] }
                });
                const res = await ws.batch.hisDelete([BNE, NYC], keyword);
                expect(res.errors).to.eql([]);
                expect(fake.rows(BNE)).to.eql([bFrom - 1, bTo]);
                expect(fake.rows(NYC)).to.eql([nFrom - 1, nTo]);
                expect(counts(fake).length).to.be.greaterThan(0);
                for (const r of deletes(fake)) {
                    expect(r.range).to.not.include(keyword);
                    expect(r.deleted.reduce((a, b) => a + b, 0), r.range).to.be.at.most(500);
                }
            });
        }

        it("plans a single date as that whole day", async () => {
            const [from, to] = [moment.tz("2026-09-01", "Australia/Brisbane").valueOf(), moment.tz("2026-09-02", "Australia/Brisbane").valueOf()];
            const rows = [from - 1, ...every(new Date(from).toISOString(), 1440, MIN), to];
            const { ws, fake } = client({ [BNE]: { tz: "Brisbane", rows } });
            const res = await ws.batch.hisDelete([BNE], "2026-09-01");
            expect(res.errors).to.eql([]);
            expect(deletes(fake).length).to.be.greaterThan(1);
            expect(fake.rows(BNE)).to.eql([from - 1, to]);
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

        for (const [what, uri, range] of [
            ["count query", "/graphql", "2026-08-31T14:00:00Z,2026-09-03T14:00:00Z"],
            ["timezone read", "/api/read", "2026-09-01,2026-09-03"]
        ]) {
            it(`retries a failed ${what} with the delete retry settings`, async () => {
                const { ws, fake } = client({ [id]: { tz: "Brisbane", rows: every("2026-08-31T14:00:00Z", 3 * 1440, MIN) } });
                fake.failNext((r) => r.uri === uri, () => haystackError(503, "Service Unavailable"));
                const res = await ws.batch.hisDelete([id], range, { retries: 1, retryDelay: 0 });
                expect(res.errors).to.eql([]);
                expect(fake.rows(id)).to.eql([]);
                expect(fake.requests.filter((r) => r.uri === uri).length).to.be.greaterThan(1);
            });
        }

        it("treats a GraphQL error body as a failed count", async () => {
            const { ws, fake } = client(day());
            const original = fake.count.bind(fake);
            fake.count = () => ({ errors: [{ message: "Cannot query data by group" }] });
            const res = await ws.batch.hisDelete([id], RANGE);
            fake.count = original;
            expect(res.errors).to.eql([{ error: "Cannot query data by group", args: ["countQuery", [id], RANGE] }]);
            expect(fake.rows(id)).to.have.length(1440);
        });

        it("still sends every planned request when one of them fails, and reports only that one", async () => {
            // Three days of 1-minute rows at the default 500 budget plan into several requests.
            const rows = every("2026-09-01T00:00:00Z", 3 * 1440, MIN);
            const { ws, fake } = client({ [id]: { rows } });
            let seen = 0;
            fake.failNext((r) => isDelete(r) && ++seen === 2, () => haystackError(400, "Rejected"));
            const res = await ws.batch.hisDelete([id], RANGE, { retries: 3, retryDelay: 0 });
            const sent = fake.requests.filter(isDelete);
            expect(sent.length).to.be.greaterThan(2);
            const failed = sent[1].range;
            expect(res.errors).to.eql([{ error: "Rejected", args: ["hisDelete", [id], failed] }]);
            // Every request after the failed one was still attempted, and only the failed range remains.
            const [from, to] = failed.replace(/^s:/, "").split(",").map((x) => t(x));
            expect(fake.rows(id)).to.eql(rows.filter((r) => r >= from && r < to));
            expect(fake.rows(id).length).to.be.greaterThan(0);
        });

        it("runs requests in parallel without losing any", async () => {
            const { ws, fake } = client({ [id]: { rows: every("2026-09-01T00:00:00Z", 3 * 1440, MIN) } });
            const res = await ws.batch.hisDelete([id], RANGE, { parallel: 3 });
            expect(res.errors).to.eql([]);
            expect(fake.rows(id)).to.eql([]);
        });
    });

    describe("option-source logging", () => {
        const optionsLine = (ws) => ws.logger.debug.getCalls()
            .map((c) => require("util").format(...c.args))
            .find((s) => s.includes("batch.hisDelete options"));

        it("logs each resolved option with where it came from", async () => {
            const { ws } = client({ [PT.chwFlowTemp]: { rows: [] } }, {}, { batch: { hisDelete: { retryDelay: 5000 } } });
            await ws.batch.hisDelete([PT.chwFlowTemp], RANGE, { retryDelay: 0 });
            const line = optionsLine(ws);
            expect(line).to.include("retryDelay=0 (call)");
            expect(line).to.include("batchSize=500 (default)");
        });

        it("uses the client configuration when the call leaves an option out", async () => {
            const { ws } = client({ [PT.chwFlowTemp]: { rows: [] } }, {}, { batch: { hisDelete: { batchSize: 250 } } });
            await ws.batch.hisDelete([PT.chwFlowTemp], RANGE);
            expect(optionsLine(ws)).to.include("batchSize=250 (client config)");
        });

        it("treats a null call option as not supplied", async () => {
            const { ws } = client({ [PT.chwFlowTemp]: { rows: [] } }, {}, { batch: { hisDelete: { batchSize: 250 } } });
            await ws.batch.hisDelete([PT.chwFlowTemp], RANGE, { batchSize: null });
            expect(optionsLine(ws)).to.include("batchSize=250 (client config)");
        });
    });
});
