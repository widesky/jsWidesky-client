/*
 * vim: set tw=78 et ts=4 sw=4 si fileencoding=utf-8:
 *
 * Unit tests for client CRUD methods
 */
"use strict";

const stubs = require('../../../stubs');
const sinon = require('sinon');
const expect = require('chai').expect;
const getInstance = stubs.getInstance;

const QUERY_1_FILTER_LIMIT =
    "\n{\n  " +
        "haystack {\n    " +
            "\n    " +
            "filter0:search(filter: \"point\", limit: 10) {\n      " +
                "entity {\n        " +
                    "tags {\n          " +
                        "name\n          " +
                        "value\n          " +
                        "kindValue { __typename }\n        " +
                    "}\n      " +
                "}\n    " +
            "}\n    " +
        "\n  " +
    "}\n}\n            ";
const QUERY_1_FILTER_LIMIT_NO_TRANSFORMATION =
    "\n    " +
        "filter0:search(filter: \"point\", limit: 10) {\n      " +
            "entity {\n        " +
                "tags {\n          " +
                    "name\n          " +
                    "value\n          " +
                    "kindValue { __typename }\n        " +
                "}\n      " +
            "}\n    " +
        "}\n    ";
const QUERY_1_FILTER_NO_LIMIT =
    "\n{\n  " +
        "haystack {\n    " +
            "\n    " +
                "filter0:search(filter: \"point\", limit: 0) {\n      " +
                    "entity {\n        " +
                        "tags {\n          " +
                        "name\n          " +
                        "value\n          " +
                        "kindValue { __typename }\n        " +
                    "}\n      " +
                "}\n    " +
            "}\n    " +
        "\n  " +
    "}\n}\n            ";
const QUERY_2_FILTER_LIMIT =
    "\n{\n  " +
        "haystack {\n    " +
            "\n    " +
            "filter0:search(filter: \"point\", limit: 10) {\n      " +
                "entity {\n        " +
                    "tags {\n          " +
                        "name\n          " +
                        "value\n          " +
                        "kindValue { __typename }\n        " +
                    "}\n      " +
                "}\n    " +
            "}\n    " +
            "\n\n    " +
            "filter1:search(filter: \"equip\", limit: 0) {\n      " +
                "entity {\n        " +
                    "tags {\n          " +
                        "name\n          " +
                        "value\n          " +
                        "kindValue { __typename }\n        " +
                    "}\n      " +
                "}\n    " +
            "}\n    " +
        "\n  " +
    "}\n}\n            ";
const QUERY_1_RESPONSE = require("./files/multiFind_1query_response.json");
const QUERY_1_HS_RESPONSE = require("./files/multiFind_1query_hsResponse.json");
const QUERY_2_RESPONSE = require("./files/multiFind_2query_response.json");
const QUERY_2_HS_RESPONSE = require("./files/multiFind_2query_hsResponse.json");

describe("client.batch.multiFind", () => {
    let ws, http, log;
    beforeEach(() => {
        http = new stubs.StubHTTPClient();
        log = new stubs.StubLogger();
        ws = getInstance(http, log);
        ws.query = sinon.stub().callsFake((query) =>  {
            return {
                data: {
                    haystack: {
                        search: {
                            entity: []
                        }
                    }
                }
            }
        });
    });

    describe("parameter filterAndLimits", () => {
        it("should reject if not a Array", async () => {
            try {
                await ws.batch.multiFind("a");
                throw new Error("Should not have worked");
            } catch (error) {
                expect(error.message).to.equal("parameter filterAndLimits is not a 2D Array as specified");
            }
        });

        it("should reject if not a 2D Array", async () => {
            try {
                await ws.batch.multiFind(["a"]);
                throw new Error("Should not have worked");
            } catch (error) {
                expect(error.message).to.equal("parameter filterAndLimits is not a 2D Array as specified");
            }
        });

        it("should reject if element of 2D array is empty", async () => {
            try {
                await ws.batch.multiFind([["a", 1], "b"]);
                throw new Error("Should not have worked");
            } catch (error) {
                expect(error.message).to.equal("parameter filterAndLimits is not a 2D Array as specified");
            }
        });
    });

    describe("query creation", () => {
        it("should create query for one filter and limit", async () => {
            await ws.batch.multiFind([["point", 10]]);
            expect(ws.query.calledOnce).to.be.true;
            expect(ws.query.args[0]).to.eql([QUERY_1_FILTER_LIMIT]);
        });

        it("should set limit as 0 when not specified", async () => {
            await ws.batch.multiFind([["point"]]);
            expect(ws.query.calledOnce).to.be.true;
            expect(ws.query.args[0]).to.eql([QUERY_1_FILTER_NO_LIMIT]);
        });

        it("should create more than 1 query for more than 1 filter and limit", async () => {
            await ws.batch.multiFind([
                ["point", 10],
                ["equip"]
            ]);
            expect(ws.query.calledOnce).to.be.true;
            expect(ws.query.args[0]).to.eql([QUERY_2_FILTER_LIMIT]);
        });
    });

    describe("parsing to Haystack response", () => {
        it("should handle 1 query response", async () => {
            ws.query = sinon.stub().callsFake(() => QUERY_1_RESPONSE);
            const { success, errors} = await ws.batch.multiFind([["point", 1]]);
            expect(ws.query.calledOnce).to.be.true;
            expect(success.length).to.equal(1);
            expect(success).to.eql([QUERY_1_HS_RESPONSE]);
            expect(errors.length).to.equal(0);
        });

        it("should handle 1 query response with multiple filter responses", async () => {
            ws.query = sinon.stub().callsFake(() => QUERY_2_RESPONSE);
            const { success, errors} = await ws.batch.multiFind([
                ["point", 1],
                ["equip", 5]
            ]);
            expect(ws.query.calledOnce).to.be.true;
            expect(success.length).to.equal(2);
            expect(success).to.eql([QUERY_1_HS_RESPONSE, QUERY_2_HS_RESPONSE]);
            expect(errors.length).to.equal(0);
        });

        it("should handle multiple query responses, each with 1 filter response", async () => {
            const responses = [QUERY_1_RESPONSE, QUERY_1_RESPONSE];
            let i = 0;
            ws.query = sinon.stub().callsFake(() => responses[i++]);
            const { success, errors} = await ws.batch.multiFind([
                ["point", 1],
                ["point", 1]
            ], {
                batchSize: 1
            });
            expect(ws.query.calledTwice).to.be.true;
            expect(success.length).to.equal(2);
            expect(success).to.eql([QUERY_1_HS_RESPONSE, QUERY_1_HS_RESPONSE]);
            expect(errors.length).to.equal(0);
        });

        it("should handle multiple query responses, each with multiple filter responses", async () => {
            const responses = [QUERY_2_RESPONSE, QUERY_2_RESPONSE];
            let i = 0;
            ws.query = sinon.stub().callsFake(() => responses[i++]);
            const { success, errors} = await ws.batch.multiFind([
                ["point", 1],
                ["equip", 5],
                ["point", 1],
                ["equip", 5]
            ], {
                batchSize: 2
            });
            expect(ws.query.calledTwice).to.be.true;
            expect(success.length).to.equal(4);
            expect(success).to.eql([
                QUERY_1_HS_RESPONSE, QUERY_2_HS_RESPONSE, QUERY_1_HS_RESPONSE, QUERY_2_HS_RESPONSE
            ]);
            expect(errors.length).to.equal(0);
        });
    });

    describe("options.batchSize", () => {
        beforeEach(() => {
            ws.performOpInBatch = sinon.stub().callsFake((...args) =>  {
                return {
                    success: [{
                        data: {
                            haystack: {
                                search: {
                                    entity: []
                                }
                            }
                        }
                    }],
                    errors: []
                }
            });
        })

        it("should batch using default size", async () => {
            await ws.batch.multiFind([["point", 10]]);
            expect(ws.performOpInBatch.calledOnce).to.be.true;
            const [op, args, options] = ws.performOpInBatch.args[0];
            const { transformer } = options;
            delete options.transformer;
            expect(op).to.equal("query");
            expect(args).to.eql([
                [
                    QUERY_1_FILTER_LIMIT_NO_TRANSFORMATION
                ]
            ]);
            expect(options).to.eql({
                "batchDelay": 0,
                "batchSize": 10,
                "limit": 0,
                "parallel": 1,
                "parallelDelay": 0,
                "retries": 0,
                "retryDelay": 2000,
                "returnResult": true
            });
            expect(transformer).to.be.instanceof(Function);
        });

        it("should batch requests as specified", async () => {
            await ws.batch.multiFind([["point", 10]], {
                batchSize: 50
            });
            expect(ws.performOpInBatch.calledOnce).to.be.true;
            const [op, args, options] = ws.performOpInBatch.args[0];
            const { transformer } = options;
            delete options.transformer;
            expect(op).to.equal("query");
            expect(args).to.eql([
                [
                    QUERY_1_FILTER_LIMIT_NO_TRANSFORMATION
                ]
            ]);
            expect(options).to.eql({
                "batchDelay": 0,
                "batchSize": 50,
                "limit": 0,
                "parallel": 1,
                "parallelDelay": 0,
                "retries": 0,
                "retryDelay": 2000,
                "returnResult": true
            });
            expect(transformer).to.be.instanceof(Function);
        });
    });
});