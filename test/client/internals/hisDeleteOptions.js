"use strict";

const expect = require("chai").expect;
const stubs = require("../../stubs");

const make = (hisDelete) => stubs.getInstance(
    new stubs.StubHTTPClient(),
    new stubs.StubLogger(),
    hisDelete === undefined ? {} : { clientOptions: { batch: { hisDelete } } }
);

describe("client batch.hisDelete options", () => {
    it("defaults to gentler request sizes and the planner settings", () => {
        const opts = make().clientOptions.batch.hisDelete;
        expect(opts.batchSize).to.equal(500);
        expect(opts.batchSizeEntity).to.equal(10);
        expect(opts.maxBisectDepth).to.equal(5);
        expect(opts.countBucketUnits).to.eql(["DAY", "HOUR", "MINUTE"]);
        expect(opts.retries).to.equal(0);
        expect(opts.retryDelay).to.equal(2000);
    });

    it("advertises the planner so callers can detect support", () => {
        expect(make().features).to.eql({ hisDeletePlanner: true });
        expect(Object.isFrozen(make().features)).to.be.true;
    });

    it("accepts explicit zeros and a custom coarse-to-fine unit list", () => {
        const opts = make({
            maxBisectDepth: 0, retries: 0, retryDelay: 0, batchDelay: 0,
            countBucketUnits: ["WEEK", "HOUR", "SECOND"]
        }).clientOptions.batch.hisDelete;
        expect(opts.maxBisectDepth).to.equal(0);
        expect(opts.retryDelay).to.equal(0);
        expect(opts.countBucketUnits).to.eql(["WEEK", "HOUR", "SECOND"]);
    });

    const invalid = [
        ["units out of order", { countBucketUnits: ["HOUR", "DAY"] }],
        ["duplicate units", { countBucketUnits: ["DAY", "DAY"] }],
        ["unknown unit", { countBucketUnits: ["FORTNIGHT"] }],
        ["empty unit list", { countBucketUnits: [] }],
        ["null unit list", { countBucketUnits: null }],
        ["bisect depth above 10", { maxBisectDepth: 11 }],
        ["negative bisect depth", { maxBisectDepth: -1 }],
        ["fractional bisect depth", { maxBisectDepth: 1.5 }],
        ["retries above 10", { retries: 11 }],
        ["negative retry delay", { retryDelay: -1 }],
        ["batch size above 3000", { batchSize: 3001 }],
    ];
    for (const [label, hisDelete] of invalid) {
        it(`rejects ${label} at construction`, () => {
            expect(() => make(hisDelete)).to.throw();
        });
    }
});
