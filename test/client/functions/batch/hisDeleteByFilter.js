/*
 * vim: set tw=78 et ts=4 sw=4 si fileencoding=utf-8:
 *
 * Behavioural tests for client.batch.hisDeleteByFilter. The entity lookup (findAsId) is stubbed;
 * history is an in-memory fake server, so tests assert on the rows left behind.
 */
"use strict";

const stubs = require("../../../stubs");
const sinon = require("sinon");
const {RequestError} = require("../../../../src/errors");
const expect = require("chai").expect;
const {FakeHistoryServer, haystackError} = require("./fakeHistoryServer");
const getInstance = stubs.getInstance;

const MIN = 60000;
const START = Date.parse("2026-09-01T00:00:00Z");
const END = Date.parse("2026-09-02T00:00:00Z");
const TIME_START = new Date(START);
const TIME_END = new Date(END);
const RANGE = "s:2026-09-01T00:00:00.000Z,2026-09-02T00:00:00.000Z";

const every = (count, stepMs) => Array.from({length: count}, (_, i) => START + i * stepMs);
const deletes = (fake) => fake.requests.filter((r) => r.uri === "/api/hisDelete");

// Realistic point ids for a chiller plant.
function genEntities(num) {
    return Array.from({length: num}, (_, i) => `c0ffee00-1111-4a5b-8c9d-${String(i).padStart(12, "0")}`);
}

function pointsFor(ids, rowsPerPoint) {
    return Object.fromEntries(ids.map((id) => [id, {rows: every(rowsPerPoint, MIN)}]));
}

describe("client.batch.hisDeleteByFilter", () => {
    let ws, log;
    beforeEach(() => {
        log = new stubs.StubLogger();
        ws = getInstance(new stubs.StubHTTPClient(), log);
        ws.findAsId = sinon.stub().resolves([]);
    });

    function withPoints(ids, rowsPerPoint) {
        ws.findAsId = sinon.stub().callsFake(() => [...ids]);
        return new FakeHistoryServer({points: pointsFor(ids, rowsPerPoint)}).install(ws);
    }

    describe("options not specified", () => {
        it("deletes history for every entity the filter finds", async () => {
            const ids = genEntities(2);
            const fake = withPoints(ids, 60);
            const res = await ws.batch.hisDeleteByFilter("point and his", TIME_START, TIME_END);
            expect(res.errors).to.eql([]);
            expect(ws.findAsId.calledOnce).to.be.true;
            for (const id of ids) expect(fake.rows(id)).to.eql([]);
        });

        it("splits more entities than the default entity batch across requests", async () => {
            const ids = genEntities(25);
            const fake = withPoints(ids, 30);
            const res = await ws.batch.hisDeleteByFilter("point", TIME_START, TIME_END);
            expect(res.errors).to.eql([]);
            expect(Math.max(...deletes(fake).map((r) => r.ids.length))).to.be.at.most(10);
            expect(deletes(fake).length).to.be.at.least(3);
            for (const id of ids) expect(fake.rows(id)).to.eql([]);
        });
    });

    describe("option batchSize", () => {
        it("keeps each request within the row budget and still deletes everything", async () => {
            const ids = genEntities(1);
            const fake = withPoints(ids, 200);
            const res = await ws.batch.hisDeleteByFilter("point", TIME_START, TIME_END, {batchSize: 50});
            expect(res.errors).to.eql([]);
            const sizes = deletes(fake).map((r) => r.deleted[0]);
            expect(Math.max(...sizes)).to.be.at.most(50);
            expect(sizes.length).to.be.at.least(4);
            expect(fake.rows(ids[0])).to.eql([]);
        });

        it("uses a single request when the data fits the budget", async () => {
            const ids = genEntities(2);
            const fake = withPoints(ids, 12);
            // 2 points x 12 rows: 24 in total, exactly the budget.
            await ws.batch.hisDeleteByFilter("point", TIME_START, TIME_END, {batchSize: 24});
            expect(deletes(fake).map((r) => r.range)).to.eql([RANGE]);
        });
    });

    describe("option batchSizeEntity", () => {
        it("limits how many entities go into one request", async () => {
            const ids = genEntities(5);
            const fake = withPoints(ids, 5);
            const res = await ws.batch.hisDeleteByFilter("points", TIME_START, TIME_END, {batchSizeEntity: 2});
            expect(res.errors).to.eql([]);
            expect(deletes(fake).map((r) => r.ids)).to.eql([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]);
            for (const id of ids) expect(fake.rows(id)).to.eql([]);
        });

        it("uses one request when the entities fit", async () => {
            const ids = genEntities(5);
            const fake = withPoints(ids, 5);
            await ws.batch.hisDeleteByFilter("points", TIME_START, TIME_END, {batchSizeEntity: 10});
            expect(deletes(fake).map((r) => r.ids)).to.eql([ids]);
        });
    });

    describe("option limit", () => {
        it("should pass argument to client.findAsId", async () => {
            withPoints(genEntities(5), 5);
            await ws.batch.hisDeleteByFilter("point", TIME_START, TIME_END, {limit: 30});
            expect(ws.findAsId.calledOnce).to.be.true;
            expect(ws.findAsId.args[0]).to.eql(["point", 30]);
        });
    });

    describe("option returnResult", () => {
        it("returns each delete response if enabled", async () => {
            withPoints(genEntities(5), 20);
            const result = await ws.batch.hisDeleteByFilter("point", TIME_START, TIME_END, {returnResult: true});
            expect(result.errors).to.eql([]);
            expect(result.success.reduce((n, grid) => n + grid.rows.length, 0)).to.equal(5 * 20);
        });

        it("returns no responses if not enabled", async () => {
            const ids = genEntities(5);
            const fake = withPoints(ids, 20);
            const result = await ws.batch.hisDeleteByFilter("point", TIME_START, TIME_END, {returnResult: false});
            expect(result).to.eql({success: [], errors: []});
            for (const id of ids) expect(fake.rows(id)).to.eql([]);
        });
    });

    describe("arguments", () => {
        it("accepts only Date start and end, as before the planner", async () => {
            const fake = withPoints(genEntities(1), 5);
            for (const [start, end] of [[RANGE, TIME_END], [TIME_START, "2026-09-02"], ["2026-09-01", "2026-09-02"]]) {
                let thrown;
                try {
                    await ws.batch.hisDeleteByFilter("point", start, end);
                } catch (error) {
                    thrown = error;
                }
                expect(thrown && thrown.message, String(start)).to.equal("parameter timeStart or timeEnd is not of type Date");
            }
            expect(fake.requests).to.eql([]);
            expect(fake.rows(genEntities(1)[0])).to.have.length(5);
        });
    });

    describe("error handling", () => {
        it("returns a failed delete with the ids and range that failed", async () => {
            const ids = genEntities(5);
            const fake = withPoints(ids, 20);
            fake.failNext((r) => r.uri === "/api/hisDelete", () => haystackError(400, "Test error"));
            const {success, errors} = await ws.batch.hisDeleteByFilter("bad filter", TIME_START, TIME_END);
            expect(success).to.eql([]);
            expect(errors).to.have.length(1);
            expect(errors[0].args).to.eql(["hisDelete", ids, RANGE]);
            expect(errors[0].error).to.include("Test error");
            // the failed request deleted nothing
            for (const id of ids) expect(fake.rows(id)).to.have.length(20);
        });

        it("returns a failed count and deletes nothing for that group", async () => {
            const ids = genEntities(5);
            const fake = withPoints(ids, 20);
            fake.failNext((r) => r.uri === "/graphql", () => haystackError(400, "Bad count"));
            const {success, errors} = await ws.batch.hisDeleteByFilter("point", TIME_START, TIME_END);
            expect(success).to.eql([]);
            expect(errors).to.have.length(1);
            expect(errors[0].args).to.eql(["countQuery", ids, RANGE]);
            expect(deletes(fake)).to.eql([]);
        });

        it("should handle errors encountered by v2.filter and return them", async () => {
            ws.findAsId = sinon.stub().callsFake(() => {
                const fakeError = new Error("test");
                fakeError.response = {
                    data: {
                        errors: [{
                            "locations": [{"column": 3, "line": 4}],
                            "message": "Invalid name start char (end of stream)"
                        }]
                    }
                };
                throw RequestError.make(fakeError, log);
            });

            const {success, errors} = await ws.batch.hisDeleteByFilter("bad filter", TIME_START, TIME_END);
            expect(success.length).to.equal(0);
            expect(errors).to.eql([{
                error: "Invalid name start char (end of stream)",
                args: ["findAsId", "bad filter", 0]
            }]);
        });

        it("returns a findAsId failure and sends no requests", async () => {
            const fake = new FakeHistoryServer({points: {}}).install(ws);
            ws.findAsId = sinon.stub().callsFake(() => {
                throw new Error("Bad filter");
            });

            const {success, errors} = await ws.batch.hisDeleteByFilter("bad filter", TIME_START, TIME_END);
            expect(success.length).to.equal(0);
            expect(errors).to.eql([{error: "Bad filter", args: ["findAsId", "bad filter", 0]}]);
            expect(fake.requests).to.eql([]);
        });
    });
});
