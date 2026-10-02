"use strict";

// Progress reporting and request logging for batch operations, driven through the public
// ws.batch.<op> entry points with only the raw HTTP seam (_wsRawSubmit) replaced by an in-memory
// API server, and observed through a RequestProgress reporter and the client's logger.

const expect = require("chai").expect;
const sinon = require("sinon");
const stubs = require("../../../stubs");
const { RequestProgress } = require("../../../../index");
const { FakeHistoryServer, haystackError } = require("./fakeHistoryServer");

// Realistic point ids for a chiller plant.
const CHILLER = {
    chwSupplyTemp: "3e9b7c21-5a4d-4f8e-b1c6-7d2a9e0f4b01",
    chwReturnTemp: "3e9b7c21-5a4d-4f8e-b1c6-7d2a9e0f4b02",
    condenserFlow: "3e9b7c21-5a4d-4f8e-b1c6-7d2a9e0f4b03",
};
const MIN = 60000;
const every = (fromIso, count, stepMs) => Array.from({ length: count }, (_, i) => Date.parse(fromIso) + i * stepMs);

/**
 * A client whose hisWrite requests land on an in-memory server that can fail chosen requests.
 * @returns {{ws: Object, logger: Object, sent: Array, failNext: function(function, Error): void}} failNext's
 *     matcher gets the 1-based number of the request (attempts included).
 */
function hisWriteClient() {
    const logger = new stubs.StubLogger();
    const ws = stubs.getInstance(new stubs.StubHTTPClient(), logger, {});
    const sent = [];
    const faults = [];
    ws._wsRawSubmit = sinon.stub().callsFake(async (method, uri, body) => {
        if (uri === "/oauth2/token") {
            return { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: Date.now() + 3600000 };
        }
        sent.push(body.rows);
        const fault = faults.find((f) => f.times > 0 && f.match(sent.length));
        if (fault) {
            fault.times -= 1;
            throw fault.error;
        }
        return { meta: { ver: "2.0" }, cols: [{ name: "empty" }], rows: [] };
    });
    return {
        ws,
        logger,
        sent,
        failNext: (match, error, times = 1) => faults.push({ match, error, times })
    };
}

/**
 * hisWrite data: `count` one-minute samples for each point.
 * @param {string[]} ids Point ids.
 * @param {number} count Samples per point.
 * @returns {Object} { ts: { id: value } }.
 */
function chillerSamples(ids, count) {
    const data = {};
    every("2026-09-01T00:00:00Z", count, MIN).forEach((ms, i) => {
        data[`t:${new Date(ms).toISOString()}`] = Object.fromEntries(ids.map((id) => [id, `n:${(6.5 + i / 10).toFixed(1)}`]));
    });
    return data;
}

/**
 * A RequestProgress that keeps every line and the counter state it was written with.
 * @param {string} label Counter label.
 * @returns {{progress: RequestProgress, lines: Array<{line: string, value: number, total: number, payload: Object}>}}
 */
function recordedProgress(label) {
    const lines = [];
    const progress = new RequestProgress({
        label,
        write: (line, bar) => lines.push({ line, value: bar.value, total: bar.getTotal(), payload: bar.payload })
    });
    return { progress, lines };
}

const debugLines = (logger) => logger.debug.args.map((a) => a[0]);
const infoCalls = (logger) => logger.info.args.filter((a) => /^batch\./.test(a[0]));

describe("client batch operations: progress and request logging", () => {
    describe("batch.hisWrite", () => {
        it("counts the requests sent and reports each as it completes", async () => {
            const { ws, sent } = hisWriteClient();
            const { progress, lines } = recordedProgress("hisWrite");

            await ws.batch.hisWrite(chillerSamples([CHILLER.chwSupplyTemp, CHILLER.chwReturnTemp], 25), {
                batchSize: 10,
                progress
            });

            expect(sent.length).to.be.above(1);
            expect(lines.map((l) => l.value)).to.eql(Array.from({ length: sent.length + 1 }, (_, i) => i));
            expect(lines.every((l) => l.total === sent.length)).to.equal(true);
            expect(lines[lines.length - 1].line).to.equal(`[hisWrite #1] 100% | ${sent.length}/${sent.length} | done`);
            expect(lines[lines.length - 1].payload).to.include({ ok: true, sizeDone: 50, failed: 0 });
        });

        it("knows the exact request count for any payload shape and entity cap", async () => {
            const shapes = [
                { ids: [CHILLER.chwSupplyTemp], samples: 7, batchSize: 3 },
                { ids: Object.values(CHILLER), samples: 4, batchSize: 5 },
                { ids: Object.values(CHILLER), samples: 9, batchSize: 4, batchSizeEntity: 2 },
                { ids: Object.values(CHILLER), samples: 12, batchSize: 100, batchSizeEntity: 1 },
            ];
            for (const shape of shapes) {
                const { ws, sent } = hisWriteClient();
                const { progress, lines } = recordedProgress("hisWrite");
                await ws.batch.hisWrite(chillerSamples(shape.ids, shape.samples), {
                    batchSize: shape.batchSize,
                    batchSizeEntity: shape.batchSizeEntity,
                    progress
                });
                expect(lines[0].total, JSON.stringify(shape)).to.equal(sent.length);
                expect(lines[lines.length - 1].value, JSON.stringify(shape)).to.equal(sent.length);
            }
        });

        it("logs a completion line per request and a summary per operation", async () => {
            const { ws, logger, sent } = hisWriteClient();

            await ws.batch.hisWrite(chillerSamples([CHILLER.chwSupplyTemp], 30), { batchSize: 10 });

            const requestLogs = logger.debug.args.filter((a) => a[0] === "batch.%s: request %d/%d ok in %d ms, %s, %d %s");
            expect(requestLogs.map((a) => [a[1], a[2], a[3], a[5], a[6], a[7]])).to.eql([
                ["hisWrite", 1, 3, "0 retries", 10, "items"],
                ["hisWrite", 2, 3, "0 retries", 10, "items"],
                ["hisWrite", 3, 3, "0 retries", 10, "items"],
            ]);
            expect(requestLogs.every((a) => Number.isInteger(a[4]) && a[4] >= 0)).to.equal(true);
            expect(sent).to.have.length(3);
            const [summary] = infoCalls(logger);
            expect(summary.slice(0, 7)).to.eql([
                "batch.%s: %d/%d requests done (%d failed), %d %s in %d ms", "hisWrite", 3, 3, 0, 30, "items"
            ]);
        });

        it("reports a failed request, and the retries a request needed", async () => {
            const { ws, logger, failNext } = hisWriteClient();
            const { progress, lines } = recordedProgress("hisWrite");
            // First request: a 503 then success on its retry. Second request: a 400, not retried.
            failNext((n) => n === 1, haystackError(503, "Service Unavailable"));
            failNext((n) => n === 3, haystackError(400, "Invalid timestamp"));

            const res = await ws.batch.hisWrite(chillerSamples([CHILLER.chwSupplyTemp], 20), {
                batchSize: 10, retries: 1, retryDelay: 0, progress
            });

            expect(res.errors).to.have.length(1);
            const updates = lines.slice(1).map((l) => l.payload);
            expect(updates.map((p) => [p.ok, p.retries, p.failed])).to.eql([[true, 1, 0], [false, 0, 1]]);
            expect(updates[1].error).to.contain("Invalid timestamp");
            expect(debugLines(logger)).to.include("batch.%s: request %d/%d failed in %d ms, %s: %s");
            expect(infoCalls(logger)[0].slice(1, 5)).to.eql(["hisWrite", 2, 2, 1]);
        });

        it("removes its counter when the operation ends, so one reporter serves many calls", async () => {
            const { ws } = hisWriteClient();
            const { progress, lines } = recordedProgress("hisWrite");

            await ws.batch.hisWrite(chillerSamples([CHILLER.chwSupplyTemp], 20), { batchSize: 10, progress });
            await ws.batch.hisWrite(chillerSamples([CHILLER.chwReturnTemp], 20), { batchSize: 10, progress });

            expect(progress.bars).to.eql([]);
            expect(lines.map((l) => l.line.split(" ")[0] + " " + l.line.split(" ")[1])).to.include.members([
                "[hisWrite #1]", "[hisWrite #2]"
            ]);
        });

        it("keeps concurrent operations on one client apart when each has its own reporter", async () => {
            const { ws } = hisWriteClient();
            const supply = recordedProgress("supply");
            const condenser = recordedProgress("condenser");

            await Promise.all([
                ws.batch.hisWrite(chillerSamples([CHILLER.chwSupplyTemp], 30), { batchSize: 10, progress: supply.progress }),
                ws.batch.hisWrite(chillerSamples([CHILLER.condenserFlow], 50), { batchSize: 10, progress: condenser.progress })
            ]);

            expect(supply.lines.every((l) => l.line.startsWith("[supply #1]") && l.total === 3)).to.equal(true);
            expect(condenser.lines.every((l) => l.line.startsWith("[condenser #1]") && l.total === 5)).to.equal(true);
            expect(supply.lines[supply.lines.length - 1].payload.sizeDone).to.equal(30);
            expect(condenser.lines[condenser.lines.length - 1].payload.sizeDone).to.equal(50);
        });
    });

    describe("batch.hisDelete", () => {
        const RANGE = "s:2026-09-01T00:00:00Z,2026-09-04T00:00:00Z";

        /**
         * A client deleting from an in-memory history server.
         * @param {Object} points Rows per point.
         * @param {Object} [fakeOpts] FakeHistoryServer options.
         * @returns {{ws: Object, fake: FakeHistoryServer, logger: Object}}
         */
        function hisDeleteClient(points, fakeOpts = {}) {
            const logger = new stubs.StubLogger();
            const ws = stubs.getInstance(new stubs.StubHTTPClient(), logger, {});
            const fake = new FakeHistoryServer({ points, ...fakeOpts }).install(ws);
            return { ws, fake, logger };
        }
        const deletes = (fake) => fake.requests.filter((r) => r.uri === "/api/hisDelete");

        it("counts the planned delete requests and the rows they hold", async () => {
            const { ws, fake } = hisDeleteClient({
                [CHILLER.chwSupplyTemp]: { rows: every("2026-09-01T00:00:00Z", 3 * 1440, MIN) },
                [CHILLER.chwReturnTemp]: { rows: every("2026-09-01T00:00:00Z", 3 * 1440, 5 * MIN) },
            });
            const { progress, lines } = recordedProgress("hisDelete");

            const res = await ws.batch.hisDelete([CHILLER.chwSupplyTemp, CHILLER.chwReturnTemp], RANGE, { progress });

            expect(res.errors).to.eql([]);
            const sent = deletes(fake).length;
            const rows = 3 * 1440 + (3 * 1440) / 5;
            expect(lines[0]).to.include({ value: 0, total: sent });
            expect(lines[0].payload).to.eql({ rowsTotal: rows });
            const last = lines[lines.length - 1];
            expect(last).to.include({ value: sent, total: sent });
            expect(last.payload).to.include({ rowsTotal: rows, sizeDone: rows, failed: 0 });
            expect(progress.bars).to.eql([]);
        });

        it("counts a request the server halves for its record limit once, with all its rows", async () => {
            // The server's limit is below the planner's budget, so every planned request is halved.
            const { ws, fake } = hisDeleteClient({
                [CHILLER.chwSupplyTemp]: { rows: every("2026-09-01T00:00:00Z", 1440, MIN) },
            }, { recordLimit: 300 });
            const { progress, lines } = recordedProgress("hisDelete");

            const res = await ws.batch.hisDelete([CHILLER.chwSupplyTemp], RANGE, { batchSize: 500, progress });

            expect(res.errors).to.eql([]);
            const planned = lines[0].total;
            expect(deletes(fake).length).to.be.above(planned);
            expect(lines[lines.length - 1]).to.include({ value: planned, total: planned });
            expect(lines[lines.length - 1].payload).to.include({ sizeDone: 1440, failed: 0 });
        });

        it("reports a delete request that fails as failed, with its error, and logs it", async () => {
            const { ws, fake, logger } = hisDeleteClient({
                [CHILLER.chwSupplyTemp]: { rows: every("2026-09-01T00:00:00Z", 3 * 1440, MIN) },
            });
            fake.failNext((r) => r.uri === "/api/hisDelete", () => haystackError(500, "Internal Server Error"));
            const { progress, lines } = recordedProgress("hisDelete");

            const res = await ws.batch.hisDelete([CHILLER.chwSupplyTemp], RANGE, { progress });

            expect(res.errors).to.have.length(1);
            const outcomes = lines.slice(1).map((l) => l.payload.ok);
            expect(outcomes.filter((ok) => ok === false)).to.have.length(1);
            expect(lines[lines.length - 1].payload.failed).to.equal(1);
            const failedLog = logger.debug.args.find((a) => a[0] === "batch.%s: request %d/%d failed in %d ms, %s: %s");
            expect(failedLog[1]).to.equal("hisDelete");
            expect(failedLog[6]).to.contain("Internal Server Error");
            const summary = infoCalls(logger).find((a) => a[1] === "hisDelete");
            expect(summary[4]).to.equal(1);
            expect(summary[6]).to.equal("rows");
        });
    });
});
