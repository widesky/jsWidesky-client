const stubs = require("../../../stubs");
const sinon = require("sinon");
const { getInstance } = require("../../../stubs");
const { expect } = require("chai");

const TEST_ENTITIES = require("./files/multiFind_2query_hsResponse.json").slice(0, 4);
const DEFAULT_OPTIONS = {
    "batchDelay": 0,
    "batchSize": 2000,
    "parallel": 1,
    "parallelDelay": 0,
    "retries": 0,
    "retryDelay": 2000,
    "returnResult": true
};

describe("client.batch.updateOrCreate", () => {
    let ws, http, log;
    beforeEach(() => {
        http = new stubs.StubHTTPClient();
        log = new stubs.StubLogger();
        ws = getInstance(http, log);
        ws.batch.multiFind = sinon.stub().callsFake((filterAndLimits) => {
            return {
                success: TEST_ENTITIES.map((entity) => [entity]),
                errors: []
            };
        });
        ws.batch.create = sinon.stub().callsFake((entities) => {
            return {
                success: {
                    rows: entities
                },
                errors: []
            };
        });
        ws.batch.update = sinon.stub().callsFake((entities) => {
            return {
                success: {
                    rows: entities
                },
                errors: []
            };
        });
    });

    describe("parameter entities", () => {
        it("should reject if not an Array", async () => {
            try {
                await ws.batch.updateOrCreate(1);
                throw new Error("Should not have worked");
            } catch (error) {
                expect(error.message).to.equal("parameter entities is not an Array");
            }
        });

        it("should not do anything if empty Array given", async () => {
            const { success, errors } = await ws.batch.updateOrCreate([]);
            expect(success.length).to.equal(0);
            expect(errors.length).to.equal(0);
            expect(ws.batch.multiFind.notCalled).to.be.true;
            expect(ws.batch.create.notCalled).to.be.true;
            expect(ws.batch.update.notCalled).to.be.true;
        });
    });

    describe("find behaviour", () => {
        it("should create a filter per entity", async () => {
            await ws.batch.updateOrCreate(TEST_ENTITIES);
            expect(ws.batch.multiFind.calledOnce).to.be.true;
            expect(ws.batch.multiFind.args[0]).to.eql([[
                ["id==@fbf5ace2-b706-11ec-a270-0242ac120002", 1],
                ["id==@fbf64a12-b706-11ec-a271-0242ac120002", 1],
                ["id==@fbf6b916-b706-11ec-a272-0242ac120002", 1],
                ["id==@fbf72e14-b706-11ec-a273-0242ac120002", 1]
            ]]);
        });

        describe("error handling", () => {
            beforeEach(() => {
                ws.batch.multiFind = sinon.stub().callsFake(() => {
                    return {
                        success: [TEST_ENTITIES[0]],
                        errors: [{
                            error: "Bad search",
                            args: ["query", "very large query"]
                        }]
                    };
                });
            });

            it("should not create/update if multiFind includes errors", async () => {
                const { success, errors } = await ws.batch.updateOrCreate(TEST_ENTITIES);
                expect(ws.batch.multiFind.calledOnce).to.be.true;
                expect(ws.batch.create.notCalled).to.be.true;
                expect(ws.batch.update.notCalled).to.be.true;
            });

            it("should return any errors encountered", async () => {
                const { success, errors } = await ws.batch.updateOrCreate(TEST_ENTITIES);
                expect(success.length).to.equal(0);
                expect(errors.length).to.equal(1);
                expect(errors[0]).to.eql({
                    error: "Bad search",
                    args: ["query", "very large query"]
                });
            });
        });
    });

    describe("create behaviour", () => {
        it("should create if entity in given parameter entities does not have an id", async () => {
            const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
            delete testEntities[0].id;
            await ws.batch.updateOrCreate(testEntities);
            expect(ws.batch.update.notCalled).to.be.true;
            expect(ws.batch.create.calledOnce).to.be.true;
            expect(ws.batch.create.args[0]).to.eql([[testEntities[0]], DEFAULT_OPTIONS]);
        });

        it("should create if entity does not exist", async () => {
            ws.batch.multiFind = sinon.stub().callsFake(() => {
                const foundEntities = TEST_ENTITIES.map((entity) => [entity]);
                foundEntities[0] = [];

                return {
                    success: foundEntities,
                    errors: []
                };
            })
            await ws.batch.updateOrCreate(TEST_ENTITIES);
            expect(ws.batch.update.notCalled).to.be.true;
            expect(ws.batch.create.calledOnce).to.be.true;
            expect(ws.batch.create.args[0]).to.eql([[TEST_ENTITIES[0]], DEFAULT_OPTIONS]);
        });

        it("should not call client.batch.create if nothing to create", async () => {
            await ws.batch.updateOrCreate(TEST_ENTITIES);
            expect(ws.batch.update.notCalled).to.be.true;
            expect(ws.batch.create.notCalled).to.be.true;
        });

        it("should return any errors encountered", async () => {
            ws.batch.create = sinon.stub().callsFake((entities, options) => {
                return {
                    success: [],
                    errors: [
                        {
                            error: "Bad tag",
                            args: ["create", entities]
                        }
                    ]
                }
            })

            const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
            delete testEntities[0].id;
            const { success, errors } = await ws.batch.updateOrCreate(testEntities);
            expect(ws.batch.update.notCalled).to.be.true;
            expect(ws.batch.create.calledOnce).to.be.true;
            expect(ws.batch.create.args[0]).to.eql([[testEntities[0]], DEFAULT_OPTIONS]);
            expect(success.length).to.equal(3);     // everything but the one that was to be created
            expect(errors.length).to.equal(1);
            expect(errors[0]).to.eql({
                error: "Bad tag",
                args: ["create", [testEntities[0]]]
            });
        });

        describe("options", () => {
            it("should pass to client.batch.create", async () => {
                const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
                delete testEntities[0].id;
                await ws.batch.updateOrCreate(testEntities, {
                    batchSize: 10,
                    returnResult: false
                });
                expect(ws.batch.create.calledOnce).to.be.true;
                expect(ws.batch.update.notCalled).to.be.true;
                expect(ws.batch.create.args[0]).to.eql([[testEntities[0]], {
                    ...DEFAULT_OPTIONS,
                    batchSize: 10,
                    returnResult: false
                }]);
            });
        });
    });

    describe("update behaviour", () => {
        it("should update entity if a tag has been added", async () => {
            const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
            testEntities[0].testTag = "s:test value";
            await ws.batch.updateOrCreate(testEntities);
            expect(ws.batch.create.notCalled).to.be.true;
            expect(ws.batch.update.calledOnce).to.be.true;
            expect(ws.batch.update.args[0]).to.eql([[{
                id: testEntities[0].id,
                testTag: "s:test value"
            }], DEFAULT_OPTIONS]);
        });

        it("should update entity if a tag has been changed", async () => {
            const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
            testEntities[0].equip = "s:not a marker anymore";
            await ws.batch.updateOrCreate(testEntities);
            expect(ws.batch.create.notCalled).to.be.true;
            expect(ws.batch.update.calledOnce).to.be.true;
            expect(ws.batch.update.args[0]).to.eql([[{
                id: testEntities[0].id,
                equip: "s:not a marker anymore"
            }], DEFAULT_OPTIONS]);
        });

        it("should update entity if a tag has been removed", async () => {
            const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
            delete testEntities[0].equip
            await ws.batch.updateOrCreate(testEntities);
            expect(ws.batch.create.notCalled).to.be.true;
            expect(ws.batch.update.calledOnce).to.be.true;
            expect(ws.batch.update.args[0]).to.eql([[{
                id: testEntities[0].id,
                equip: "x:"
            }], DEFAULT_OPTIONS]);
        });

        it("should return any errors encountered", async () => {
            ws.batch.update = sinon.stub().callsFake((entities, options) => {
                return {
                    success: [],
                    errors: [
                        {
                            error: "Bad tag",
                            args: ["update", entities]
                        }
                    ]
                }
            })

            const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
            delete testEntities[0].equip
            const { success, errors } = await ws.batch.updateOrCreate(testEntities);
            expect(ws.batch.create.notCalled).to.be.true;
            expect(ws.batch.update.calledOnce).to.be.true;
            expect(ws.batch.update.args[0]).to.eql([[{
                id: testEntities[0].id,
                equip: "x:"
            }], DEFAULT_OPTIONS]);
            expect(success.length).to.equal(3);     // everything but the one that was to be created
            expect(errors.length).to.equal(1);
            expect(errors[0]).to.eql({
                error: "Bad tag",
                args: ["update", [{
                    id: testEntities[0].id,
                    equip: "x:"
                }]]
            });
        });

        describe("tag types", () => {
            describe("list tag", () => {
                beforeEach(() => {
                    const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
                    testEntities[0].roleRefs = ["r:id1", "r:id2", "r:id3"];
                    ws.batch.multiFind = sinon.stub().callsFake((filterAndLimits) => {
                        return {
                            success: testEntities.map((entity) => [entity]),
                            errors: []
                        };
                    });
                });

                it("should not update if the list is the same", async () => {
                    const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
                    testEntities[0].roleRefs = ["r:id1", "r:id2", "r:id3"];
                    await ws.batch.updateOrCreate(testEntities);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should not update if the list is the same but different order", async () => {
                    const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
                    testEntities[0].roleRefs = ["r:id3", "r:id2", "r:id1"];
                    await ws.batch.updateOrCreate(testEntities);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should update if list different sizes", async () => {
                    const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
                    testEntities[0].roleRefs = ["r:id2", "r:id1"];
                    await ws.batch.updateOrCreate(testEntities);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.calledOnce).to.be.true;
                    expect(ws.batch.update.getCall(0).args[0]).to.eql([{
                        "id": "r:fbf5ace2-b706-11ec-a270-0242ac120002",
                        "roleRefs": [
                            "r:id2",
                            "r:id1"
                        ]
                    }]);
                });

                it("should update if list has 1 item that is different", async () => {
                    const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
                    testEntities[0].roleRefs = ["r:id2", "r:id1", "r:id4"];
                    await ws.batch.updateOrCreate(testEntities);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.calledOnce).to.be.true;
                    expect(ws.batch.update.getCall(0).args[0]).to.eql([{
                        "id": "r:fbf5ace2-b706-11ec-a270-0242ac120002",
                        "roleRefs": [
                            "r:id2",
                            "r:id1",
                            "r:id4"
                        ]
                    }]);
                });
            });
        });

        describe("options", () => {
            it("should pass to client.batch.update", async () => {
                const testEntities = JSON.parse(JSON.stringify(TEST_ENTITIES));
                delete testEntities[0].equip
                await ws.batch.updateOrCreate(testEntities, {
                    batchSize: 10,
                    returnResult: false
                });
                expect(ws.batch.create.notCalled).to.be.true;
                expect(ws.batch.update.calledOnce).to.be.true;
                expect(ws.batch.update.args[0]).to.eql([[{
                    id: testEntities[0].id,
                    equip: "x:"
                }], {
                    ...DEFAULT_OPTIONS,
                    batchSize: 10,
                    returnResult: false
                }]);
            });
        });

        describe("ignored tags", () => {
            let testEntity;
            const setMultiFindStub = (entity) => {
                entity = JSON.stringify(entity);
                ws.batch.multiFind = sinon.stub().callsFake(() => {
                    return {
                        success: [[JSON.parse(entity)]],
                        errors: []
                    };
                });
            };

            beforeEach(() => {
                testEntity = {
                    id: "r:1231",
                    test: "s:123"
                };
                setMultiFindStub(testEntity);
            });

            describe("'id'", () => {
                it("should disregard modification of tag", async () => {
                    testEntity.id = "r:anotherId";
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });
            });

            describe("'lastHisTime'", () => {
                it("should disregard addition of tag", async () => {
                    testEntity.lastHisTime = "r:anotherId";
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should disregard modification of tag", async () => {
                    testEntity.lastHisTime = "t:123";
                    setMultiFindStub(testEntity);
                    testEntity.lastHisTime = "t:321";
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should disregard removal of tag", async () => {
                    testEntity.lastHisTime = "t:123";
                    setMultiFindStub(testEntity);
                    delete testEntity.lastHisTime;
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });
            });

            describe("'lastHisVal'", () => {
                it("should disregard addition of tag", async () => {
                    testEntity.lastHisVal = "n:123";
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should disregard modification of tag", async () => {
                    testEntity.lastHisVal = "t:123";
                    setMultiFindStub(testEntity);
                    testEntity.lastHisVal = "t:321";
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should disregard removal of tag", async () => {
                    testEntity.lastHisVal = "t:123";
                    setMultiFindStub(testEntity);
                    delete testEntity.lastHisTime;
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });
            });

            describe("'curVal'", () => {
                it("should disregard addition of tag", async () => {
                    testEntity.curVal = "n:123";
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should disregard modification of tag", async () => {
                    testEntity.curVal = "t:123";
                    setMultiFindStub(testEntity);
                    testEntity.curVal = "t:321";
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should disregard removal of tag", async () => {
                    testEntity.curVal = "t:123";
                    setMultiFindStub(testEntity);
                    delete testEntity.lastHisTime;
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });
            });

            describe("'curStatus'", () => {
                it("should disregard addition of tag", async () => {
                    testEntity.curStatus = "n:123";
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should disregard modification of tag", async () => {
                    testEntity.curStatus = "t:123";
                    setMultiFindStub(testEntity);
                    testEntity.curStatus = "t:321";
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should disregard removal of tag", async () => {
                    testEntity.curStatus = "t:123";
                    setMultiFindStub(testEntity);
                    delete testEntity.lastHisTime;
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });
            });

            describe("'curErr'", () => {
                it("should disregard addition of tag", async () => {
                    testEntity.curErr = "n:123";
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should disregard modification of tag", async () => {
                    testEntity.curErr = "t:123";
                    setMultiFindStub(testEntity);
                    testEntity.curErr = "t:321";
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });

                it("should disregard removal of tag", async () => {
                    testEntity.curErr = "t:123";
                    setMultiFindStub(testEntity);
                    delete testEntity.lastHisTime;
                    await ws.batch.updateOrCreate([testEntity]);
                    expect(ws.batch.create.notCalled).to.be.true;
                    expect(ws.batch.update.notCalled).to.be.true;
                });
            });
        });
    });
});
