/*
 * vim: set tw=78 et ts=4 sw=4 si fileencoding=utf-8:
 *
 * Unit tests for client internals
 */
"use strict";

const stubs = require('../../stubs');
const sinon = require('sinon');
const { expect } = require('chai');
const {
    WS_ACCESS_TOKEN,
    WS_REFRESH_TOKEN,
    getInstance
} = stubs

const {
    verifyTokenCall,
    verifyRequestCall,
    sleep
} = require("./../utils");
const { HaystackError, GraphQLError } = require("../../../src/errors");

describe('client', () => {
    describe('performOpInBatch', () => {
        let http;
        let log;
        let ws;
        let targetUser = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

        beforeEach(async () => {
            http = new stubs.StubHTTPClient();
            log = new stubs.StubLogger();
            ws = getInstance(http, log);
            ws.impersonateAs(targetUser);
            ws._wsRawSubmit = sinon.stub().callsFake((method, uri, body, config) => {
                if (uri === "/oauth2/token") {
                    return Promise.resolve({
                        access_token: WS_ACCESS_TOKEN,
                        refresh_token: WS_REFRESH_TOKEN,
                        expires_in: Date.now() + 2000
                    });
                } else {
                    return Promise.resolve("default response");
                }
            });
        });

        describe("'args' parameter", () => {
            beforeEach(() => {
                ws.test = sinon.stub();
            });

            it("rejects if args parameter is not Array", async () => {
                try {
                    await ws.performOpInBatch("test", {});
                    throw new Error("Should not have worked");
                } catch (error) {
                    expect(error.message).to.equal(
                        "args parameter must be an array consisting of at least the payload to be batched");
                } finally {
                    expect(ws.test.notCalled).to.be.true;
                }
            });

            it("reject if args parameter is empty Array", async () => {
                try {
                    await ws.performOpInBatch("test", []);
                    throw new Error("Should not have worked");
                } catch (error) {
                    expect(error.message).to.equal(
                        "args parameter must be an array consisting of at least the payload to be batched");
                } finally {
                    expect(ws.test.notCalled).to.be.true;
                }
            });

            it("rejects if payload in args parameter is not of type Object or Array", async () => {
                try {
                    await ws.performOpInBatch("test", [1, 2, 3]);
                    throw new Error("Should not have worked");
                } catch (error) {
                    expect(error.message).to.equal(
                        "First element of parameter should be of type Array or Object");
                } finally {
                    expect(ws.test.notCalled).to.be.true;
                }
            });

            it("element in array following first index of args parameter are passed as args to client function",
                async () => {
                    await ws.performOpInBatch("test", [[1, 2, 3], "a", "b", "c"]);
                    expect(ws.test.calledOnce).to.be.true;
                    expect(ws.test.args[0]).to.eql([[1, 2, 3], "a", "b", "c"]);
                });

            it("should return immediately if an empty Array payload given", async () => {
                const { success, errors } = await ws.performOpInBatch("test", [[], "a", "b", "c"]);
                expect(ws.test.notCalled).to.be.true;
                expect(success.length).to.equal(0);
                expect(errors.length).to.equal(0);
            });

            it("should return immediately if an empty Object payload given", async () => {
                const { success, errors } = await ws.performOpInBatch("test", [{}, "a", "b", "c"]);
                expect(ws.test.notCalled).to.be.true;
                expect(success.length).to.equal(0);
                expect(errors.length).to.equal(0);
            });
        });

        describe("function call errors", () => {
            it("should return args given to function", async () => {
                ws.test = sinon.stub().callsFake(() => {
                    throw new Error("Failure")
                });
                const {errors, success} = await ws.performOpInBatch("test", [[1, 2, 3], "a", "b", "c"]);
                expect(success.length).to.equal(0);
                expect(errors.length).to.equal(1);
                expect(errors[0]).to.eql({
                    error: "Failure",
                    args: ["test", [1, 2, 3], "a", "b", "c"]
                });
            });

            it("should handle multiple errors encountered", async () => {
                ws.test = sinon.stub().callsFake(() => {
                    throw new Error("Failure")
                });
                const {errors, success} = await ws.performOpInBatch("test", [[1, 2, 3], "a", "b", "c"], {
                    batchSize: 1
                });
                expect(success.length).to.equal(0);
                expect(errors.length).to.equal(3);
                expect(errors[0]).to.eql({
                    error: "Failure",
                    args: ["test", [1], "a", "b", "c"]
                });
                expect(errors[1]).to.eql({
                    error: "Failure",
                    args: ["test", [2], "a", "b", "c"]
                });
                expect(errors[2]).to.eql({
                    error: "Failure",
                    args: ["test", [3], "a", "b", "c"]
                });
            })
        })

        describe("client configuration", () => {
            describe("progress", () => {
                describe("if progress enabled", () => {
                    beforeEach(async () => {
                        ws.options = {
                            client: {
                                progress: {
                                    enable: true
                                }
                            }
                        }
                        await ws.initClientOptions();
                    });

                    /**
                     * A fake cli-progress MultiBar, given client-wide as progress.instance.
                     * @returns {{multiBar: Object, bar: Object}}
                     */
                    function fakeMultiBar() {
                        const bar = {increment: sinon.stub(), stop: sinon.stub()};
                        const multiBar = {create: sinon.stub().returns(bar), remove: sinon.stub()};
                        return {multiBar, bar};
                    }

                    it("creates one counter per operation, counting its requests", async () => {
                        const {multiBar} = fakeMultiBar();
                        ws.clientOptions.progress.instance = multiBar;
                        ws.test = () => {};
                        await ws.performOpInBatch("test", [[1, 2, 3]], {batchSize: 2});
                        expect(multiBar.create.calledOnce).to.be.true;
                        // 3 items in batches of 2: 2 requests.
                        expect(multiBar.create.args[0].slice(0, 2)).to.eql([2, 0]);
                    });

                    it("advances the counter once per completed request, then removes it", async () => {
                        const {multiBar, bar} = fakeMultiBar();
                        ws.clientOptions.progress.instance = multiBar;
                        ws.test = () => {};
                        await ws.performOpInBatch("test", [[1, 2, 3]], {batchSize: 1});
                        expect(bar.increment.callCount).to.equal(3);
                        expect(bar.increment.args.map((a) => a[0])).to.eql([1, 1, 1]);
                        expect(bar.increment.args[2][1]).to.include({ok: true, sizeDone: 3, failed: 0});
                        expect(bar.stop.calledOnce).to.be.true;
                        expect(multiBar.remove.calledOnceWith(bar)).to.be.true;
                    });
                });

                describe("if progress disabled", () => {
                    beforeEach(async () => {
                        ws.options = {
                            client: {
                                progress: {
                                    enable: false       // default but being explicit
                                }
                            }
                        }
                        await ws.initClientOptions();
                    });

                    it("progress instance not created", async () => {
                        const multiBar = {create: sinon.stub(), remove: sinon.stub()};
                        ws.clientOptions.progress.instance = multiBar;
                        ws.test = sinon.stub();
                        await ws.performOpInBatch("test", [[1, 2, 3]]);
                        expect(ws.test.calledOnce).to.be.true;
                        expect(multiBar.create.notCalled).to.be.true;
                    });
                });
            });
        });

        describe("function configuration", () => {
            beforeEach(() => {
                // Stub the client function to be called
                ws.test = sinon.stub().callsFake(() => ["test", "output"]);
            })

            describe("batchSize", () => {
                describe("payload is of type Array", () => {
                    describe("same as payload size", () => {
                        it("should only send 1 request", async () => {
                            const payload = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                            const res = await ws.performOpInBatch("test", [[...payload], "testArg"], {
                                batchSize: payload.length
                            });
                            expect(ws.test.calledOnce).to.be.true;
                            expect(ws.test.args[0]).to.eql([payload, "testArg"]);
                            expect(res.success.length).to.equal(0);
                            expect(res.errors.length).to.equal(0);
                        });
                    });

                    describe("is 1 and a partial batch", () => {
                        it("should send 2 requests", async () => {
                            const payload = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                            const res = await ws.performOpInBatch("test", [[...payload], "testArg"], {
                                batchSize: 7
                            });
                            expect(ws.test.calledTwice).to.be.true;
                            expect(ws.test.args[0]).to.eql([[1, 2, 3, 4, 5, 6, 7], "testArg"]);
                            expect(ws.test.args[1]).to.eql([[8, 9, 10], "testArg"]);
                            expect(res.success.length).to.equal(0);
                            expect(res.errors.length).to.equal(0);
                        });
                    });

                    describe("for 5 batched requests", () => {
                        it("should send 5 requests", async () => {
                            const payload = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                            const res = await ws.performOpInBatch("test", [[...payload], "testArg"], {
                                batchSize: 2
                            });
                            expect(ws.test.callCount).to.be.equal(5);
                            expect(ws.test.args[0]).to.eql([[1, 2], "testArg"]);
                            expect(ws.test.args[1]).to.eql([[3, 4], "testArg"]);
                            expect(ws.test.args[2]).to.eql([[5, 6], "testArg"]);
                            expect(ws.test.args[3]).to.eql([[7, 8], "testArg"]);
                            expect(ws.test.args[4]).to.eql([[9, 10], "testArg"]);
                            expect(res.success.length).to.equal(0);
                            expect(res.errors.length).to.equal(0);
                        });
                    });
                });

                describe("payload is of type Object", () => {
                    it("should reject if payload Object is empty", async () => {
                        const badPayload = {};
                        try {
                            await ws.performOpInBatch("test", [badPayload, "testArg"]);
                        } catch (error) {
                            expect(error.message).to.equal("Empty Object payload given");
                        }
                    });

                    it("should reject if payload Object values are not Objects", async () => {
                        const badPayload = {
                            "a time stamp": 123
                        };
                        try {
                            await ws.performOpInBatch("test", [badPayload, "testArg"]);
                        } catch (error) {
                            expect(error.message).to.equal("Object payload structure for batch operation is malformed");
                        }
                    });

                    describe("same as payload size", () => {
                        it("should only send 1 request", async () => {
                            const payload = {
                                1: {
                                    1: 1,
                                    2: 2,
                                    3: 3,
                                    4: 4,
                                    5: 5
                                },
                                2: {
                                    6: 6,
                                    7: 7,
                                    8: 8,
                                    9: 9,
                                    10: 10
                                },
                                3: {
                                    11: 11,
                                    12: 12,
                                    13: 13,
                                    14: 14,
                                    15: 15
                                }
                            };
                            const res = await ws.performOpInBatch("test", [payload, "testArg"], {
                                batchSize: 15
                            });
                            expect(ws.test.calledOnce).to.be.true;
                            expect(ws.test.args[0]).to.eql([payload, "testArg"]);
                            expect(res.success.length).to.equal(0);
                            expect(res.errors.length).to.equal(0);
                        });
                    });

                    describe("is 1 and a partial batch", () => {
                        it("should send 2 requests", async () => {
                            const payload = {
                                1: {
                                    1: 1,
                                    2: 2,
                                    3: 3,
                                    4: 4,
                                    5: 5
                                },
                                2: {
                                    6: 6,
                                    7: 7,
                                    8: 8,
                                    9: 9,
                                    10: 10
                                },
                                3: {
                                    11: 11,
                                    12: 12,
                                    13: 13,
                                    14: 14,
                                    15: 15
                                }
                            };
                            const res = await ws.performOpInBatch("test", [payload, "testArg"], {
                                batchSize: 10
                            });
                            expect(ws.test.calledTwice).to.be.true;
                            expect(ws.test.args[0]).to.eql([{
                                1: {
                                    1: 1,
                                    2: 2,
                                    3: 3,
                                    4: 4,
                                    5: 5
                                },
                                2: {
                                    6: 6,
                                    7: 7,
                                    8: 8,
                                    9: 9,
                                    10: 10
                                },
                            }, "testArg"]);
                            expect(ws.test.args[1]).to.eql([{
                                3: {
                                    11: 11,
                                    12: 12,
                                    13: 13,
                                    14: 14,
                                    15: 15
                                }
                            }, "testArg"]);
                            expect(res.success.length).to.equal(0);
                            expect(res.errors.length).to.equal(0);
                        });

                        it("should send 2 requests differently", async () => {
                            const payload = {
                                1: {
                                    1: 1,
                                    2: 2,
                                    3: 3,
                                    4: 4,
                                    5: 5
                                },
                                2: {
                                    6: 6,
                                    7: 7,
                                    8: 8,
                                    9: 9,
                                    10: 10
                                },
                                3: {
                                    11: 11,
                                    12: 12,
                                    13: 13,
                                    14: 14,
                                    15: 15
                                }
                            };
                            const res = await ws.performOpInBatch("test", [payload, "testArg"], {
                                batchSize: 8
                            });
                            expect(ws.test.calledTwice).to.be.true;
                            expect(ws.test.args[0]).to.eql([{
                                1: {
                                    1: 1,
                                    2: 2,
                                    3: 3,
                                    4: 4,
                                    5: 5
                                },
                                2: {
                                    6: 6,
                                    7: 7,
                                    8: 8
                                },
                            }, "testArg"]);
                            expect(ws.test.args[1]).to.eql([{
                                2: {
                                    9: 9,
                                    10: 10
                                },
                                3: {
                                    11: 11,
                                    12: 12,
                                    13: 13,
                                    14: 14,
                                    15: 15
                                }
                            }, "testArg"]);
                            expect(res.success.length).to.equal(0);
                            expect(res.errors.length).to.equal(0);
                        });
                    });

                    describe("for 5 batched requests", () => {
                        it("should send 5 requests", async () => {
                            const payload = {
                                1: {
                                    1: 1,
                                    2: 2,
                                    3: 3,
                                    4: 4,
                                    5: 5
                                },
                                2: {
                                    6: 6,
                                    7: 7,
                                    8: 8,
                                    9: 9,
                                    10: 10
                                },
                                3: {
                                    11: 11,
                                    12: 12,
                                    13: 13,
                                    14: 14,
                                    15: 15
                                },
                                4: {
                                    16: 16,
                                    17: 17,
                                    18: 18,
                                    19: 19,
                                    20: 20
                                },
                                5: {
                                    21: 21,
                                    22: 22,
                                    23: 23,
                                    24: 24,
                                    25: 25
                                }
                            };
                            const res = await ws.performOpInBatch("test", [payload, "testArg"], {
                                batchSize: 5
                            });
                            expect(ws.test.callCount).to.equal(5);
                            expect(ws.test.args[0]).to.eql([{
                                1: {
                                    1: 1,
                                    2: 2,
                                    3: 3,
                                    4: 4,
                                    5: 5
                                }
                            }, "testArg"]);
                            expect(ws.test.args[1]).to.eql([{
                                2: {
                                    6: 6,
                                    7: 7,
                                    8: 8,
                                    9: 9,
                                    10: 10
                                },
                            }, "testArg"]);
                            expect(ws.test.args[2]).to.eql([{
                                3: {
                                    11: 11,
                                    12: 12,
                                    13: 13,
                                    14: 14,
                                    15: 15
                                },
                            }, "testArg"]);
                            expect(ws.test.args[3]).to.eql([{
                                4: {
                                    16: 16,
                                    17: 17,
                                    18: 18,
                                    19: 19,
                                    20: 20
                                },
                            }, "testArg"]);
                            expect(ws.test.args[4]).to.eql([{
                                5: {
                                    21: 21,
                                    22: 22,
                                    23: 23,
                                    24: 24,
                                    25: 25
                                }
                            }, "testArg"]);
                            expect(res.success.length).to.equal(0);
                            expect(res.errors.length).to.equal(0);
                        });
                    });
                });

                describe.skip("payload is for op 'hisDelete'", () => {
                    // not to be tested as this is quite a special case for the hisDelete function
                    // see hisDelete test file for related tests
                });
            });

            describe("batchDelay", () => {
                let lastCalled, timeToCall;
                beforeEach(() => {
                    timeToCall = [];
                    ws.test = sinon.stub().callsFake(() => {
                        const now = Date.now();
                        timeToCall.push(now - lastCalled);
                        lastCalled = now;
                    })
                });

                it("should delay the next batch request", async function(){
                    this.timeout(500 * 6);
                    const payload = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                    lastCalled = Date.now();
                    const res = await ws.performOpInBatch("test", [[...payload], "testArg"], {
                        batchDelay: 500,
                        batchSize: 2
                    });
                    expect(timeToCall.length).to.equal(5);
                    expect(timeToCall[0]).to.below(50);     // first call goes out immediately
                    for (let i = 1; i < timeToCall.length; i++) {
                        expect(timeToCall[i]).to.be.approximately(500, 50);
                    }
                });
            });

            describe("parallel", () => {
                let lastCalled, timeToCall;
                beforeEach(() => {
                    timeToCall = [];
                    ws.test = sinon.stub().callsFake(() => {
                        const now = Date.now();
                        timeToCall.push(now - lastCalled);
                        lastCalled = now;
                        return sleep(500)
                    })
                });

                describe("set to 1", () => {
                    it("should run 2 request in parallel", async () => {
                        const payload = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                        lastCalled = Date.now();
                        const res = await ws.performOpInBatch("test", [[...payload], "testArg"], {
                            parallel: 1,
                            batchSize: 5
                        });
                        expect(ws.test.calledTwice).to.be.true;
                        expect(timeToCall.length).to.equal(2);
                        expect(timeToCall[0]).to.be.below(50);
                        expect(timeToCall[1]).to.be.approximately(500, 50);
                    });
                });

                describe("set to 2", () => {
                    it("should run 2 requests in parallel, 5x", async function() {
                        this.timeout(500 * 6);
                        const payload = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                        lastCalled = Date.now();
                        const res = await ws.performOpInBatch("test", [[...payload], "testArg"], {
                            parallel: 2,
                            batchSize: 1
                        });
                        expect(ws.test.callCount).to.equal(10);
                        expect(timeToCall.length).to.equal(10);
                        expect(timeToCall[0]).to.be.below(50);
                        expect(timeToCall[1]).to.be.below(50);
                        expect(timeToCall[2]).to.be.approximately(500, 50);
                        expect(timeToCall[3]).to.be.below(50);
                        expect(timeToCall[4]).to.be.approximately(500, 50);
                        expect(timeToCall[5]).to.be.below(50);
                        expect(timeToCall[6]).to.be.approximately(500, 50);
                        expect(timeToCall[7]).to.be.below(50);
                        expect(timeToCall[8]).to.be.approximately(500, 50);
                        expect(timeToCall[9]).to.be.below(50);
                    });
                });
            });

            describe("parallelDelay", () => {
                let lastCalled, timeToCall;
                beforeEach(() => {
                    timeToCall = [];
                    ws.test = sinon.stub().callsFake(() => {
                        const now = Date.now();
                        timeToCall.push(now - lastCalled);
                        lastCalled = now;
                    })
                });

                it("should delay subsequent parallel batched requests", async function(){
                    this.timeout(500 * 6);
                    const payload = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
                    lastCalled = Date.now();
                    const res = await ws.performOpInBatch("test", [[...payload], "testArg"], {
                        parallel: 2,
                        batchSize: 1,
                        parallelDelay: 500
                    });
                    expect(ws.test.callCount).to.equal(10);
                    expect(timeToCall.length).to.equal(10);
                    expect(timeToCall[0]).to.be.below(50);
                    expect(timeToCall[1]).to.be.below(50);
                    expect(timeToCall[2]).to.be.approximately(500, 50);
                    expect(timeToCall[3]).to.be.below(50);
                    expect(timeToCall[4]).to.be.approximately(500, 50);
                    expect(timeToCall[5]).to.be.below(50);
                    expect(timeToCall[6]).to.be.approximately(500, 50);
                    expect(timeToCall[7]).to.be.below(50);
                    expect(timeToCall[8]).to.be.approximately(500, 50);
                    expect(timeToCall[9]).to.be.below(50);
                });
            });

            describe("returnResult", () => {
                describe("if enabled", () => {
                    it("should return the result of the function call", async () => {
                        const { success, errors} = await ws.performOpInBatch("test", [[1, 2, 3]], {
                            returnResult: true
                        });
                        expect(success.length).to.equal(1);
                        expect(success).to.eql([
                            ["test", "output"]
                        ]);
                        expect(errors.length).to.equal(0);
                    });

                    it("should return the result of multiple function calls", async () => {
                        const { success, errors} = await ws.performOpInBatch("test", [[1, 2, 3]], {
                            returnResult: true,
                            batchSize: 1
                        });
                        expect(success.length).to.equal(3);
                        expect(success).to.eql([
                            ["test", "output"],
                            ["test", "output"],
                            ["test", "output"]
                        ])
                        expect(errors.length).to.equal(0)
                    });
                });

                describe("if disabled", () => {
                    it("should not return the result of the function call", async () => {
                        const { success, errors} = await ws.performOpInBatch("test", [[1, 2, 3]], {
                            returnResult: false
                        });
                        expect(success.length).to.equal(0);
                        expect(errors.length).to.equal(0)
                    });
                });
            });

            describe("transformer", () => {
                it("should transform the payload given to the client", async () => {
                    const { success, errors} = await ws.performOpInBatch("test", [[1, 2, 3], "testArg"], {
                        transformer: (args) => [...args, "hi", "there"]
                    });
                    expect(ws.test.calledOnce).to.be.true;
                    expect(ws.test.args[0]).to.eql([
                        [1, 2, 3, "hi", "there"], "testArg"
                    ]);
                });
            });
        });
    });
});
