"use strict";

// Retries for every batched operation, driven through the public ws.batch.<op> / ws.performOpInBatch
// entry points with only the raw HTTP seam (_wsRawSubmit) replaced by an in-memory API server.

const expect = require("chai").expect;
const sinon = require("sinon");
const stubs = require("../../../stubs");
const { FakeHistoryServer, haystackError, networkError } = require("./fakeHistoryServer");

// Realistic point and equipment ids for an air-handling unit. AHU_EQUIP is a factory: performOpInBatch
// splices the payload array it is given.
const AHU = {
    supplyAirTemp: "8c1d4f2a-6b7e-4a39-9f10-2e5d7c3b9a01",
    returnAirTemp: "8c1d4f2a-6b7e-4a39-9f10-2e5d7c3b9a02",
};
const AHU_EQUIP = () => [
    { id: "r:1a7e3c90-4d2b-4f6e-8a51-0c9b2d4e6f11", dis: "s:AHU-01 Level 3", equip: "m:" },
    { id: "r:1a7e3c90-4d2b-4f6e-8a51-0c9b2d4e6f12", dis: "s:AHU-02 Level 4", equip: "m:" },
];

/**
 * Minimal WideSky API server at the raw HTTP seam: it records each request and can fail chosen
 * ones, so tests assert on what reached the server and what the caller got back.
 */
class FakeApiServer {
    constructor() {
        this.requests = [];
        this.faults = [];
        this.written = [];
    }

    install(ws) {
        ws._wsRawSubmit = sinon.stub().callsFake(async (method, uri, body) => this.handle(uri, body));
        return this;
    }

    failNext(match, makeError, times = 1) {
        this.faults.push({ match, makeError, times });
    }

    sent(uri) {
        return this.requests.filter((r) => r.uri === uri);
    }

    async handle(uri, body) {
        if (uri === "/oauth2/token") {
            return { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: Date.now() + 3600000 };
        }
        const req = { uri, rows: (body && body.rows) || [] };
        this.requests.push(req);
        const fault = this.faults.find((f) => f.times > 0 && f.match(req));
        if (fault) {
            fault.times -= 1;
            throw fault.makeError(req);
        }
        if (uri === "/api/hisWrite") {
            this.written.push(...req.rows);
            return { meta: { ver: "2.0" }, cols: [{ name: "empty" }], rows: [] };
        }
        if (uri === "/api/createRec" || uri === "/api/updateRec") {
            return { meta: { ver: "2.0" }, cols: [{ name: "id" }], rows: req.rows };
        }
        throw new Error(`FakeApiServer: unexpected request to ${uri}`);
    }
}

function client(clientOptions) {
    const ws = stubs.getInstance(new stubs.StubHTTPClient(), new stubs.StubLogger(),
        clientOptions ? { clientOptions } : {});
    const server = new FakeApiServer().install(ws);
    return { ws, server };
}

// Two timestamps of two points: batchSize 2 sends them as two hisWrite requests.
const HIS_WRITE_DATA = () => ({
    "t:2026-09-01T00:00:00.000Z": { [AHU.supplyAirTemp]: "n:14.2", [AHU.returnAirTemp]: "n:22.9" },
    "t:2026-09-01T00:05:00.000Z": { [AHU.supplyAirTemp]: "n:14.4", [AHU.returnAirTemp]: "n:23.1" },
});

describe("client batch operations: retries", () => {
    it("batch.hisWrite retries a 503 and a reset connection on one request, then succeeds", async () => {
        const { ws, server } = client();
        let seen = 0;
        // Only the first sub-request fails: a 503, then a reset connection on its retry.
        server.failNext((r) => r.uri === "/api/hisWrite" && ++seen <= 2, (r) => seen === 1
            ? haystackError(503, "Service Unavailable") : networkError("ECONNRESET"), 2);
        const res = await ws.batch.hisWrite(HIS_WRITE_DATA(), { batchSize: 2, retries: 2, retryDelay: 0 });
        expect(res.errors).to.eql([]);
        // First request: 3 attempts; second request: 1 attempt, never repeated.
        expect(server.sent("/api/hisWrite")).to.have.length(4);
        expect(server.written.map((row) => row.ts)).to.eql([
            "t:2026-09-01T00:00:00.000Z", "t:2026-09-01T00:05:00.000Z"
        ]);
    });

    it("reports a request that still fails once its retries run out, as without retries", async () => {
        const { ws, server } = client();
        server.failNext((r) => r.uri === "/api/updateRec", () => haystackError(503, "Service Unavailable"), 5);
        const res = await ws.performOpInBatch("update", [AHU_EQUIP()], { batchSize: 2, retries: 2, retryDelay: 0 });
        expect(server.sent("/api/updateRec")).to.have.length(3);
        expect(res.errors).to.have.length(1);
        expect(res.errors[0].args).to.eql(["update", AHU_EQUIP()]);
    });

    it("does not retry by default", async () => {
        const { ws, server } = client();
        server.failNext((r) => r.uri === "/api/createRec", () => haystackError(503, "Service Unavailable"));
        const res = await ws.batch.create(AHU_EQUIP());
        expect(server.sent("/api/createRec")).to.have.length(1);
        expect(res.errors).to.have.length(1);
        expect(res.errors[0].args[0]).to.equal("create");
    });

    it("does not retry a 400", async () => {
        const { ws, server } = client();
        server.failNext((r) => r.uri === "/api/createRec", () => haystackError(400, "Invalid tag value"), 5);
        const res = await ws.batch.create(AHU_EQUIP(), { retries: 3, retryDelay: 0 });
        expect(server.sent("/api/createRec")).to.have.length(1);
        expect(res.errors).to.have.length(1);
    });

    it("honours batch.create.retries from client config without call options", async () => {
        const { ws, server } = client({ batch: { create: { retries: 1, retryDelay: 0 } } });
        server.failNext((r) => r.uri === "/api/createRec", () => haystackError(502, "Bad Gateway"));
        const res = await ws.batch.create(AHU_EQUIP(), { returnResult: true });
        expect(res.errors).to.eql([]);
        expect(server.sent("/api/createRec")).to.have.length(2);
        expect(res.success).to.have.length(1);
    });

    it("accepts retries in client config for every batch operation", () => {
        const ops = ["hisRead", "hisWrite", "hisDelete", "create", "update", "deleteById", "deleteByFilter",
            "hisReadByFilter", "addChildrenByFilter", "updateByFilter", "migrateHistory", "hisDeleteByFilter",
            "updateOrCreate", "multiFind"];
        const batch = Object.fromEntries(ops.map((op) => [op, { retries: 2, retryDelay: 500 }]));
        const { ws } = client({ batch, performOpInBatch: { retries: 1, retryDelay: 100 } });
        expect(ws.clientOptions.batch.update.retries).to.equal(2);
        expect(ws.clientOptions.performOpInBatch.retryDelay).to.equal(100);
    });

    it("rejects batch.update.retries above 10 when the client is constructed", () => {
        let thrown;
        try {
            client({ batch: { update: { retries: 11 } } });
        } catch (error) {
            thrown = error;
        }
        expect(thrown && thrown.message).to.match(/retries must be less than or equal to 10/);
    });

    it("batch.hisDelete makes only its own retries when performOpInBatch.retries is configured", async () => {
        const ws = stubs.getInstance(new stubs.StubHTTPClient(), new stubs.StubLogger(),
            { clientOptions: { performOpInBatch: { retries: 3, retryDelay: 0 } } });
        const minute = Date.parse("2026-09-01T00:00:00Z");
        const fake = new FakeHistoryServer({
            points: { [AHU.supplyAirTemp]: { rows: Array.from({ length: 10 }, (_, i) => minute + i * 60000) } }
        }).install(ws);
        fake.failNext((r) => r.uri === "/api/hisDelete", () => haystackError(503, "Service Unavailable"), 10);
        const res = await ws.batch.hisDelete([AHU.supplyAirTemp], "s:2026-09-01T00:00:00Z,2026-09-02T00:00:00Z",
            { retries: 1, retryDelay: 0 });
        // One planned request: the first attempt plus its own single retry, nothing on top.
        expect(fake.requests.filter((r) => r.uri === "/api/hisDelete")).to.have.length(2);
        expect(res.errors).to.have.length(1);
        expect(res.errors[0].args[0]).to.equal("hisDelete");
    });
});
