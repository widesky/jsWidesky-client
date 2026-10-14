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

const HIS_WRITE_BATCH_SIZE  = 10000;
const TEST_ID_FROM = "6100be1a-4187-4180-beaf-d826b2c01b37";
const TEST_ID_TO = "30840ce5-25f9-4adc-a56e-5219d0ea1fbe";
const HIS_READ_SAMPLE = require("./files/hisRead_entities_large.json")[0];
const DEFAULT_OPTIONS = {
    "batchDelay": 0,
    "batchSize": 10000,
    "parallel": 1,
    "parallelDelay": 0,
    "retries": 0,
    "retryDelay": 2000,
    "returnResult": false
};
const HIS_WRITE_PAYLOAD = require("./files/migrateHistory_hisWritePayload.json");
const HisWritePayload = require("../../../../src/utils/hisWritePayload");

describe("client.batch.migrateHistory", () => {
    let ws, http, log;
    beforeEach(() => {
        http = new stubs.StubHTTPClient();
        log = new stubs.StubLogger();
        ws = getInstance(http, log);
        ws.batch.hisRead = sinon.stub().callsFake(() => {
            return {
                success: [HIS_READ_SAMPLE],
                errors: []
            };
        });
        ws.batch.hisWrite = sinon.stub().callsFake((entities) =>  {
            return {
                success: [["test123"]],
                errors: []
            };
        });
    });

    describe("options not specified", () => {
        it("should pass all data to client.batch.hisWrite", async () => {
            await ws.batch.migrateHistory(TEST_ID_FROM, TEST_ID_TO);

            expect(ws.batch.hisRead.calledOnce).to.be.true;
            const [ids, timeStart, timeEnd] = ws.batch.hisRead.args[0];
            expect(ids).to.eql([TEST_ID_FROM]);
            expect(timeStart).to.be.instanceof(Date);
            expect(timeStart.valueOf()).to.equal(0);
            expect(timeEnd).to.be.instanceof(Date);
            expect(timeEnd.valueOf()).to.be.approximately(Date.now(), 10);

            expect(ws.batch.hisWrite.calledOnce).to.be.true;
            const [ hisWritePayload, options ] = ws.batch.hisWrite.args[0];
            expect(hisWritePayload).to.be.instanceof(HisWritePayload);
            expect(hisWritePayload.payload).to.eql(HIS_WRITE_PAYLOAD);
            expect(options).to.eql(DEFAULT_OPTIONS);
        });
    });

    describe("option batchSize", () => {
        it("should pass option to client.batch.hisWrite", async () => {
            await ws.batch.migrateHistory(TEST_ID_FROM, TEST_ID_TO, {
                batchSize: 10
            });

            expect(ws.batch.hisRead.calledOnce).to.be.true;
            const [ids, timeStart, timeEnd] = ws.batch.hisRead.args[0];
            expect(ids).to.eql([TEST_ID_FROM]);
            expect(timeStart).to.be.instanceof(Date);
            expect(timeStart.valueOf()).to.equal(0);
            expect(timeEnd).to.be.instanceof(Date);
            expect(timeEnd.valueOf()).to.be.approximately(Date.now(), 10);

            expect(ws.batch.hisWrite.calledOnce).to.be.true;
            const [ hisWritePayload, options ] = ws.batch.hisWrite.args[0];
            expect(hisWritePayload).to.be.instanceof(HisWritePayload);
            expect(hisWritePayload.payload).to.eql(HIS_WRITE_PAYLOAD);
            expect(options).to.eql({
                ...DEFAULT_OPTIONS,
                batchSize: 10
            });
        });
    });

    describe("option returnResult", () => {
        describe("enabled", () => {
            it("should pass option to ws.batch.hisWrite", async () => {
                await ws.batch.migrateHistory(TEST_ID_FROM, TEST_ID_TO, {
                    returnResult: true
                });
                expect(ws.batch.hisWrite.calledOnce).to.be.true;
                const [ hisWritePayload, options ] = ws.batch.hisWrite.args[0];
                expect(options).to.eql({
                    ...DEFAULT_OPTIONS,
                    returnResult: true
                });
            });
        });

        describe("disabled", () => {
            it("should pass option to ws.batch.hisWrite", async () => {
                await ws.batch.migrateHistory(TEST_ID_FROM, TEST_ID_TO, {
                    returnResult: false
                });
                expect(ws.batch.hisWrite.calledOnce).to.be.true;
                const [ hisWritePayload, options ] = ws.batch.hisWrite.args[0];
                expect(options).to.eql({
                    ...DEFAULT_OPTIONS,
                    returnResult: false
                });
            });
        });
    });
});