"use strict";

const sinon = require("sinon");
const moment = require("moment-timezone");

const UNIT_MS = { WEEK: 604800000, DAY: 86400000, HOUR: 3600000, MINUTE: 60000, SECOND: 1000 };
const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Haystack timezone names are the city part of the IANA name.
const iana = (hsTz) => (moment.tz.zone(hsTz) ? hsTz : moment.tz.names().find((n) => n.split("/").pop() === hsTz));

// Shaped like an axios error so the client's submitRequest wraps it exactly as it wraps a real
// server response (RequestError.make -> HaystackError carrying the status).
function haystackError(status, dis) {
    const err = new Error(dis);
    err.isAxiosError = true;
    err.status = status;
    err.response = { status, data: { meta: { ver: "2.0", dis: `s:${dis}` }, cols: [{ name: "empty" }], rows: [] } };
    return err;
}

function networkError(code) {
    const err = new Error(`connect ${code}`);
    err.isAxiosError = true;
    err.code = code;
    return err;
}

/**
 * In-memory WideSky history server installed at the client's raw HTTP seam (_wsRawSubmit).
 * It stores rows per point, answers the planner's GraphQL COUNT histograms from them and applies
 * hisDelete requests to them, so tests assert on what was deleted rather than on how.
 *
 * Range semantics, as far as the unit suite needs: an ISO datetime with an offset is absolute;
 * one without is resolved in the point's timezone; a date-only end includes that whole day;
 * `today` / `yesterday` resolve in the point's timezone against `now`; start inclusive, end
 * exclusive. test/integration/hisDelete-e2e.js checks the real server against a plain hisDelete.
 */
class FakeHistoryServer {
    constructor({ points, recordLimit = 1500, now = Date.parse("2026-09-30T02:00:00Z") }) {
        this.points = new Map(Object.entries(points).map(([id, p]) =>
            [id, { tz: p.tz === undefined ? "UTC" : p.tz, rows: [...p.rows].sort((a, b) => a - b) }]));
        this.recordLimit = recordLimit;
        this.now = now;
        this.requests = [];
        this.faults = [];
        this.firstDeleteHook = null;
    }

    install(ws) {
        ws._wsRawSubmit = sinon.stub().callsFake((method, uri, body, config) => this.handle(uri, body, config));
        return this;
    }

    rows(id) {
        return [...this.points.get(id).rows];
    }

    failNext(match, makeError, times = 1) {
        this.faults.push({ match, makeError, times });
    }

    beforeFirstDelete(fn) {
        this.firstDeleteHook = fn;
    }

    async handle(uri, body, config) {
        if (uri === "/oauth2/token") {
            return { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: Date.now() + 3600000 };
        }
        let req;
        if (uri === "/api/read") {
            // Single id: GET with params.id "@<uuid>"; several: POST grid rows [{id: "r:<uuid>"}].
            const raw = body && Array.isArray(body.rows) ? body.rows.map((r) => r.id) : [config.params.id];
            req = { uri, ids: raw.map((id) => String(id).replace(/^(r:|@)/, "").split(" ")[0]) };
            this.requests.push(req);
            const rows = req.ids.filter((id) => this.points.has(id)).map((id) => {
                const tz = this.points.get(id).tz;
                return tz === null ? { id: `r:${id}`, kind: "s:Number" } : { id: `r:${id}`, kind: "s:Number", tz: `s:${tz}` };
            });
            return { meta: { ver: "2.0" }, cols: [{ name: "id" }, { name: "kind" }, { name: "tz" }], rows };
        }
        if (uri === "/graphql") {
            req = this.parseCount(body.query);
        } else if (uri === "/api/hisDelete") {
            req = this.parseDelete(body);
            if (this.firstDeleteHook) {
                const hook = this.firstDeleteHook;
                this.firstDeleteHook = null;
                hook(this);
            }
        } else {
            throw new Error(`FakeHistoryServer: unexpected request to ${uri}`);
        }
        this.requests.push(req);
        const fault = this.faults.find((f) => f.times > 0 && f.match(req));
        if (fault) {
            fault.times -= 1;
            throw fault.makeError(req);
        }
        return uri === "/graphql" ? this.count(req) : this.delete(req);
    }

    parseCount(query) {
        const ids = [...query.matchAll(/id==@([\w-]+)/g)].map((m) => m[1]);
        const [, start, end] = query.match(/start: "([^"]+)", end: "([^"]+)"/);
        const [, unit] = query.match(/groupByUnits: (\w+)/);
        return { uri: "/graphql", ids, fromMs: Date.parse(start), toMs: Date.parse(end), unit };
    }

    count({ ids, fromMs, toMs, unit }) {
        const size = UNIT_MS[unit];
        const entity = ids.filter((id) => this.points.has(id)).map((id) => {
            const buckets = new Map();
            for (const ts of this.points.get(id).rows) {
                if (ts < fromMs || ts >= toMs) continue;
                const start = Math.floor(ts / size) * size;
                buckets.set(start, (buckets.get(start) || 0) + 1);
            }
            const dataPoints = [...buckets.entries()].sort((a, b) => a[0] - b[0])
                .map(([time, n]) => ({ time, value: String(n) }));
            return { id: `r:${id}`, history: { aggregate: { timeSeries: [{ dataPoints }] } } };
        });
        return { data: { haystack: { search: { entity } } } };
    }

    parseDelete(body) {
        const row = body.rows[0];
        const ids = Object.keys(row)
            .filter((k) => /^id\d*$/.test(k))
            .sort((a, b) => Number(a.slice(2) || 0) - Number(b.slice(2) || 0))
            .map((k) => row[k].replace(/^r:/, "").split(" ")[0]);
        return { uri: "/api/hisDelete", ids, range: row.range };
    }

    resolve(range, tz) {
        const raw = range.replace(/^s:/, "");
        if (raw === "today" || raw === "yesterday") {
            const day = moment.tz(this.now, tz).startOf("day");
            if (raw === "yesterday") day.subtract(1, "day");
            return [day.valueOf(), day.clone().add(1, "day").valueOf()];
        }
        const at = (token, isEnd) => {
            const iso = token.trim().split(" ")[0];
            if (DATE_ONLY_RE.test(iso)) {
                const d = moment.tz(iso, "YYYY-MM-DD", tz);
                return (isEnd ? d.add(1, "day") : d).valueOf();
            }
            return OFFSET_RE.test(iso) ? Date.parse(iso) : moment.tz(iso, moment.ISO_8601, tz).valueOf();
        };
        const [a, b] = raw.split(",");
        return [at(a, false), at(b, true)];
    }

    delete(req) {
        const plan = req.ids.filter((id) => this.points.has(id)).map((id) => {
            const point = this.points.get(id);
            // A point with no tz tag resolves offset-less ends in UTC.
            const [from, to] = this.resolve(req.range, iana(point.tz || "UTC"));
            return { id, point, doomed: point.rows.filter((ts) => ts >= from && ts < to) };
        });
        if (plan.some((p) => p.doomed.length > this.recordLimit)) {
            throw haystackError(400, `data points per entity cannot exceed ${this.recordLimit}`);
        }
        req.deleted = plan.map((p) => p.doomed.length);
        const cols = [{ name: "ts" }];
        const rows = [];
        plan.forEach((p, i) => {
            cols.push({ name: `v${i}`, id: `r:${p.id}` });
            const doomed = new Set(p.doomed);
            p.point.rows = p.point.rows.filter((ts) => !doomed.has(ts));
            for (const ts of p.doomed) {
                rows.push({ ts: `t:${new Date(ts).toISOString()} UTC`, [`v${i}`]: "n:1" });
            }
        });
        return { meta: { ver: "2.0" }, cols, rows };
    }
}

module.exports = { FakeHistoryServer, haystackError, networkError, UNIT_MS };
