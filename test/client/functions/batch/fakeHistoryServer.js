"use strict";

const sinon = require("sinon");
const moment = require("moment-timezone");

const MIN_MS = 60000;
const UNIT_MS = { WEEK: 604800000, DAY: 86400000, HOUR: 3600000, MINUTE: 60000, SECOND: 1000 };
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
// Zinc datetime: hh:mm then seconds (mandatory), optional fraction, offset "Z" or "+hh:mm"
// (colon required), then an optional " TzName".
const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d*))?)?(Z|[+-]\d{2}:\d{2})?(?: (\S+))?$/;
const UUID_RE = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const escapeRe = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
 * Parse one end of a hisDelete range the way the API server's HZincReader does
 * (widesky-api-server widesky/externals/haystack/io/HZincReader.js): a date, or a datetime with
 * seconds whose offset is "Z" (tz UTC unless a name follows) or "+hh:mm" that MUST be followed by
 * a tz name. Throws the server's message for anything else.
 *
 * The instant is resolved as the server resolves it (read.js -> timezoneSvc.timezoneEpoch), not
 * as ISO 8601 would:
 *   - a non-zero offset is applied as tzHours*60 + tzMins*60 MINUTES (HZincReader's arithmetic),
 *     so "+10:00" is right but "+09:30" is read as +39:00;
 *   - a zero offset ("Z" or "+00:00") is not applied at all: the wall time is read in the named
 *     zone ("Z" alone and "... UTC" are UTC).
 *
 * KNOWN DIVERGENCE: a zero-offset wall time that is ambiguous (a repeated DST hour) or missing
 * (a DST gap) is resolved here by client moment-timezone, which picks the earlier instant. The
 * real server picks the later instant and depends on "now". The planner never emits such tokens
 * (cuttable() refuses them), so the fake does not model that behaviour.
 */
function parseEnd(token) {
    const tok = token.trim();
    if (DATE_ONLY_RE.test(tok)) return { kind: "date", iso: tok };
    const m = tok.match(DATETIME_RE);
    if (!m) throw haystackError(400, `Invalid HDateTimeRange: ${tok}`);
    const [, y, mo, d, h, mi, sec, frac, offset, name] = m;
    if (sec === undefined) {
        const next = tok.charAt(16);
        throw haystackError(400, next
            ? `Expected ':' for time value (char=0x${next.charCodeAt(0).toString(16)} '${next}')`
            : "Expected ':' for time value (end of stream)");
    }
    if (!offset) throw haystackError(400, "Expected -/+ for timezone offset");
    if (offset !== "Z" && !name) throw haystackError(400, "Expected space between timezone offset and name");
    const tz = name || "UTC";
    const ms = frac ? Math.round(Number(`0.${frac}`) * 1000) : 0;
    const wall = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(sec), ms);
    let offsetMin = 0;
    if (offset !== "Z") {
        const [hh, mm] = offset.slice(1).split(":").map(Number);
        offsetMin = (hh * 60 + mm * 60) * (offset[0] === "-" ? -1 : 1);
    }
    if (offsetMin !== 0) return { kind: "datetime", ms: wall - offsetMin * MIN_MS, tz };
    const zone = iana(tz);
    if (!zone) throw haystackError(400, `Unknown timezone: ${tz}`);
    const local = new Date(wall).toISOString().slice(0, 23);
    return { kind: "datetime", ms: moment.tz(local, "YYYY-MM-DDTHH:mm:ss.SSS", zone).valueOf(), tz };
}

/**
 * Validate a range as HDateTimeRange.make does (widesky-api-server
 * widesky/externals/haystack/HDateTimeRange.js): keywords, one value, two dates, or two datetimes
 * in the same named timezone. Everything else is a 400.
 */
function parseRange(range) {
    const raw = range.replace(/^s:/, "").trim();
    if (["first", "last", "today", "yesterday"].includes(raw)) return { keyword: raw };
    const parts = raw.split(",");
    if (parts.length > 2) throw haystackError(400, `Invalid HDateTimeRange: ${raw}`);
    const start = parseEnd(parts[0]);
    const end = parts.length === 2 ? parseEnd(parts[1]) : null;
    if (end && start.kind !== end.kind) throw haystackError(400, `Invalid HDateTimeRange: ${raw}`);
    if (end && start.kind === "datetime" && start.tz !== end.tz) throw haystackError(400, "arg1.tz != arg2.tz");
    return { start, end };
}

// Entities the API server's GraphQL search returns when the query gives no limit.
const SEARCH_DEFAULT_LIMIT = 30;

/**
 * In-memory WideSky history server installed at the client's raw HTTP seam (_wsRawSubmit).
 * It stores rows per point, answers the planner's GraphQL COUNT histograms from them and applies
 * hisDelete requests to them, so tests assert on what was deleted rather than on how.
 *
 * Range grammar is the API server's: two dates, or two datetimes with seconds, an offset and
 * the same tz name ("Z" alone means UTC); mixed forms, differing names, an offset without a
 * name, a datetime without an offset and a datetime without seconds are rejected with a 400, so
 * tests cannot pin forms the server refuses. Datetime ends resolve to the instant the server
 * reads (see parseEnd), including its misreading of offsets with non-zero minutes. A date-only end includes that whole day in the point's timezone; `today` /
 * `yesterday` resolve in the point's timezone against `now`; start inclusive, end exclusive.
 * The count query's filter must be `id==@<uuid or fqname>` terms joined by " or ", or the response is a
 * GraphQL error. test/integration/hisDelete-e2e.js checks the real server against a plain
 * hisDelete.
 */
class FakeHistoryServer {
    constructor({ points, recordLimit = 1500, now = Date.parse("2026-09-30T02:00:00Z") }) {
        this.points = new Map(Object.entries(points).map(([id, p]) =>
            [id, { tz: p.tz === undefined ? "UTC" : p.tz, fqname: p.fqname || null, rows: [...p.rows].sort((a, b) => a - b) }]));
        // The server also accepts a point's fqname wherever it accepts its id.
        this.byFqname = new Map([...this.points.entries()].filter(([, p]) => p.fqname).map(([id, p]) => [p.fqname, id]));
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

    // The point's uuid for an id given as a uuid or as an fqname, else null.
    lookup(id) {
        if (this.points.has(id)) return id;
        return this.byFqname.get(id) || null;
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
            const readFault = this.faults.find((f) => f.times > 0 && f.match(req));
            if (readFault) {
                readFault.times -= 1;
                throw readFault.makeError(req);
            }
            // Rows carry the uuid id (never the fqname asked for) plus the fqname tag when the point has one.
            const rows = req.ids.map((id) => this.lookup(id)).filter((id) => id !== null).map((id) => {
                const { tz, fqname } = this.points.get(id);
                const row = { id: `r:${id}`, kind: "s:Number" };
                if (tz !== null) row.tz = `s:${tz}`;
                if (fqname) row.fqname = `s:${fqname}`;
                return row;
            });
            return { meta: { ver: "2.0" }, cols: [{ name: "id" }, { name: "kind" }, { name: "tz" }, { name: "fqname" }], rows };
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
        const [, filter, limit] = query.match(/search\(filter: "([^"]*)"(?:, limit: (\d+))?\)/);
        const term = [UUID_RE, ...this.byFqname.keys()].map((x) => (x === UUID_RE ? x : escapeRe(x))).join("|");
        const filterRe = new RegExp(`^id==@(?:${term})(?: or id==@(?:${term}))*$`);
        const ids = filterRe.test(filter) ? [...filter.matchAll(/id==@([^\s]+)/g)].map((m) => m[1]) : null;
        const [, start, end] = query.match(/start: "([^"]+)", end: "([^"]+)"/);
        const [, unit] = query.match(/groupByUnits: (\w+)/);
        return {
            uri: "/graphql", ids: ids || [], badFilter: ids ? null : filter, fromMs: Date.parse(start), toMs: Date.parse(end), unit,
            limit: limit === undefined ? undefined : Number(limit)
        };
    }

    count({ ids, badFilter, fromMs, toMs, unit, limit }) {
        if (badFilter !== null) {
            return { errors: [{ message: `Invalid filter: ${badFilter}` }] };
        }
        // The planner must never ask for an empty or inverted range; fail loudly if it does.
        if (!(fromMs < toMs)) {
            return { errors: [{ message: `COUNT range start ${new Date(fromMs).toISOString()} is not before end ${new Date(toMs).toISOString()}` }] };
        }
        const size = UNIT_MS[unit];
        // Like the API server's GraphQL search: 30 entities unless a limit is given; 0 means all.
        const found = ids.map((id) => this.lookup(id)).filter((id) => id !== null);
        const cap = limit === undefined ? SEARCH_DEFAULT_LIMIT : limit === 0 ? Infinity : limit;
        const entity = found.slice(0, cap).map((id) => {
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
        const { keyword, start, end } = parseRange(range);
        if (keyword === "today" || keyword === "yesterday") {
            const day = moment.tz(this.now, tz).startOf("day");
            if (keyword === "yesterday") day.subtract(1, "day");
            return [day.valueOf(), day.clone().add(1, "day").valueOf()];
        }
        if (keyword || !end) throw new Error(`FakeHistoryServer: range ${range} is valid but not modelled`);
        const at = (e, isEnd) => {
            if (e.kind === "datetime") return e.ms;
            const d = moment.tz(e.iso, "YYYY-MM-DD", tz);
            return (isEnd ? d.add(1, "day") : d).valueOf();
        };
        return [at(start, false), at(end, true)];
    }

    delete(req) {
        parseRange(req.range);   // grammar errors first, as the server parses before touching data
        const plan = req.ids.map((id) => this.lookup(id)).filter((id) => id !== null).map((id) => {
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

module.exports = { FakeHistoryServer, haystackError, networkError, UNIT_MS, parseRange };
