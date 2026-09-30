/*
 * © 2026 WideSky.Cloud Pty Ltd
 * SPDX-License-Identifier: MIT
 */
"use strict";

// Offline proof of the pure helpers behind test/integration/hisDelete-e2e.js.

const { expect } = require("chai");
const moment = require("moment-timezone");
const H = require("../integration/hisDelete-e2e-helpers");

const iso = (r) => [new Date(r.fromMs).toISOString(), new Date(r.toMs).toISOString()];
const NOW = Date.parse("2026-09-30T02:00:00Z");

describe("hisDelete e2e helpers", () => {
    describe("resolveRange", () => {
        it("treats date-only tokens as local midnight, END covering the whole local day (Brisbane)", () => {
            const r = H.resolveRange("2026-06-01,2026-06-03", "Brisbane");
            expect(iso(r)).to.eql(["2026-05-31T14:00:00.000Z", "2026-06-03T14:00:00.000Z"]);
            expect(r.toMs - r.fromMs).to.equal(72 * H.HOUR);
        });

        it("treats date-only tokens as local midnight (New_York)", () => {
            const r = H.resolveRange("2026-06-01,2026-06-03", "New_York");
            expect(iso(r)).to.eql(["2026-06-01T04:00:00.000Z", "2026-06-04T04:00:00.000Z"]);
        });

        it("accepts the s: prefix", () => {
            expect(iso(H.resolveRange("s:2026-06-01,2026-06-03", "Brisbane"))[0]).to.equal("2026-05-31T14:00:00.000Z");
        });

        for (const zone of ["Brisbane", "New_York"]) {
            it(`resolves the absolute UTC range identically in ${zone}`, () => {
                expect(iso(H.resolveRange("2026-06-01T00:00:00Z,2026-06-04T00:00:00Z", zone)))
                    .to.eql(["2026-06-01T00:00:00.000Z", "2026-06-04T00:00:00.000Z"]);
            });

            it(`resolves the offset range identically in ${zone}`, () => {
                const range = "2026-06-01T00:00:00+10:00 Brisbane,2026-06-04T00:00:00+10:00 Brisbane";
                expect(iso(H.resolveRange(range, zone))).to.eql(["2026-05-31T14:00:00.000Z", "2026-06-03T14:00:00.000Z"]);
            });
        }

        it("resolves the zone-named form the planner writes for a split date-only range", () => {
            const range = "s:2026-06-01T00:00:00.000-04:00 New_York,2026-06-02T12:30:00.000-04:00 New_York";
            expect(iso(H.resolveRange(range, "New_York"))).to.eql(["2026-06-01T04:00:00.000Z", "2026-06-02T16:30:00.000Z"]);
        });

        it("resolves yesterday and today from nowMs in Brisbane", () => {
            expect(iso(H.resolveRange("yesterday", "Brisbane", NOW))).to.eql(["2026-09-28T14:00:00.000Z", "2026-09-29T14:00:00.000Z"]);
            expect(iso(H.resolveRange("today", "Brisbane", NOW))).to.eql(["2026-09-29T14:00:00.000Z", "2026-09-30T14:00:00.000Z"]);
        });

        it("resolves yesterday in New_York (local time is 2026-09-29 22:00 EDT)", () => {
            expect(iso(H.resolveRange("yesterday", "New_York", NOW))).to.eql(["2026-09-28T04:00:00.000Z", "2026-09-29T04:00:00.000Z"]);
            expect(iso(H.resolveRange("today", "New_York", NOW))).to.eql(["2026-09-29T04:00:00.000Z", "2026-09-30T04:00:00.000Z"]);
        });

        it("resolves a datetime without offset in the point's zone", () => {
            expect(iso(H.resolveRange("2026-06-01T06:30:00,2026-06-01T18:00:00", "Brisbane")))
                .to.eql(["2026-05-31T20:30:00.000Z", "2026-06-01T08:00:00.000Z"]);
            expect(iso(H.resolveRange("2026-06-01T06:30:00,2026-06-01T18:00:00", "New_York")))
                .to.eql(["2026-06-01T10:30:00.000Z", "2026-06-01T22:00:00.000Z"]);
        });

        it("throws on an unresolvable token", () => {
            expect(() => H.resolveRange("banana,2026-06-01", "Brisbane")).to.throw(/Unhandled range token/);
        });

        it("flags only today/yesterday as now-dependent", () => {
            expect(H.isNowDependent("yesterday")).to.equal(true);
            expect(H.isNowDependent("s:today")).to.equal(true);
            expect(H.isNowDependent("2026-06-01,2026-06-03")).to.equal(false);
        });
    });

    const checkPoint = (data, range, zone, what) => {
        const { fromMs, toMs } = H.resolveRange(range, zone, NOW);
        expect(new Set(data).size, `${what}: no duplicate timestamps`).to.equal(data.length);
        expect(H.countIn(data, fromMs, toMs), `${what}: in-range count`).to.be.at.most(1500);
        return { fromMs, toMs };
    };

    describe("fixture builders", () => {
        for (const range of ["2026-06-01T00:00:00Z,2026-06-04T00:00:00Z",
            "2026-06-01T00:00:00+10:00 Brisbane,2026-06-04T00:00:00+10:00 Brisbane"]) {
            it(`regular shapes stay within 1500 rows for ${range}`, () => {
                const { fromMs, toMs } = H.resolveRange(range, "Brisbane", NOW);
                const shapes = H.shapesRegular(fromMs, toMs);
                expect(Object.keys(shapes)).to.have.length(12);
                for (const [name, data] of Object.entries(shapes)) {
                    checkPoint(data, range, "Brisbane", name);
                    for (const edge of [fromMs - 1, fromMs, toMs, toMs + 1]) expect(data, name).to.include(edge);
                }
            });
        }

        for (const zone of ["Brisbane", "New_York"]) {
            it(`tz-less data for ${zone}: bounded, and bursts fill the first and last local hour`, () => {
                const data = H.buildTzlessData(zone);
                const { fromMs, toMs } = checkPoint(data, "2026-06-01,2026-06-03", zone, zone);
                const first = data.filter((ts) => ts >= fromMs && ts < fromMs + H.HOUR);
                const last = data.filter((ts) => ts > toMs - H.HOUR && ts < toMs);
                expect(first.length).to.be.at.least(600);
                expect(last.length).to.be.at.least(600);
                const middle = data.filter((ts) => ts >= fromMs + H.HOUR && ts <= toMs - H.HOUR);
                expect(middle.length).to.equal(250);
                for (const edge of [fromMs - 1, fromMs, toMs, toMs + 1]) expect(data).to.include(edge);
            });
        }

        it("yesterday data is bounded and holds the edges and neighbouring days", () => {
            const data = H.buildYesterdayData("Brisbane", NOW);
            const { fromMs, toMs } = checkPoint(data, "yesterday", "Brisbane", "yesterday");
            for (const edge of [fromMs - 1, fromMs, toMs, toMs + 1]) expect(data).to.include(edge);
            expect(data.some((ts) => ts < fromMs - 1)).to.equal(true);
            expect(data.some((ts) => ts > toMs + 1)).to.equal(true);
            expect(moment.tz(fromMs, "Australia/Brisbane").format("YYYY-MM-DD HH:mm")).to.equal("2026-09-29 00:00");
        });
    });

    describe("maxRowsPerRequest", () => {
        const T0 = Date.parse("2026-06-01T00:00:00Z");
        const snapshots = {
            pA: [T0, T0 + 1000, T0 + 2000, T0 + 3000, T0 + 4000],
            pB: [T0 + 1000, T0 + 5000],
        };
        const tzOf = { pA: "Brisbane", pB: "New_York" };
        const body = (range, ...ids) => ({ rows: [{ ...Object.fromEntries(ids.map((id, i) => [i === 0 ? "id" : `id${i}`, `r:${id} Some point`])), range: `s:${range}` }] });

        it("returns the largest per-id in-range count across requests", () => {
            const bodies = [
                body("2026-06-01T00:00:00Z,2026-06-01T00:00:01Z", "pA", "pB"),          // pA 2, pB 1
                body("2026-06-01T00:00:00Z,2026-06-01T00:00:04Z", "pA"),                // pA 5
            ];
            expect(H.maxRowsPerRequest(bodies, snapshots, tzOf, NOW)).to.equal(5);
        });

        it("resolves each id's range in its own zone", () => {
            // Date-only range: Brisbane midnight 05-31T14Z, New_York 06-01T04Z; pB rows fall before New_York's start.
            const r = "2026-06-01,2026-06-01";
            expect(H.maxRowsPerRequest([body(r, "pB")], snapshots, tzOf, NOW)).to.equal(0);
            expect(H.maxRowsPerRequest([body(r, "pA")], snapshots, {pA: "New_York"}, NOW)).to.equal(0);
            expect(H.maxRowsPerRequest([body(r, "pA")], snapshots, tzOf, NOW)).to.equal(5);
        });

        it("throws on an unknown id", () => {
            expect(() => H.maxRowsPerRequest([body("2026-06-01T00:00:00Z,2026-06-02T00:00:00Z", "pZ")], snapshots, tzOf, NOW))
                .to.throw(/unknown id pZ/);
        });
    });
});
