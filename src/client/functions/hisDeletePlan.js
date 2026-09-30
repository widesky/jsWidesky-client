"use strict";

const lodash = require("lodash");
const moment = require("moment-timezone");
const Ref = require("../../dataTypes/ref");

const UNIT_MS = Object.freeze({
    WEEK: 604800000, DAY: 86400000, HOUR: 3600000, MINUTE: 60000, SECOND: 1000
});

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
// A Zinc datetime as the API server reads it: offset "Z" or "+hh:mm" (colon required), then an
// optional " TzName". The server requires the name after "+hh:mm"; "Z" alone means UTC.
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})(?: (\S+))?$/;
const ZONED_FORMAT = "YYYY-MM-DDTHH:mm:ss.SSSZ";

const toIso = (ms) => new Date(ms).toISOString();

// The bare uuid of an id in any form client.hisDelete accepts ("uuid", "r:uuid Dis", "@uuid").
const bareId = (id) => new Ref(id).id;

/**
 * Map a Haystack timezone name to an IANA zone. Haystack names are the city part of the IANA
 * name ("Brisbane" -> "Australia/Brisbane"); an IANA name or "UTC" passes through.
 */
function ianaZone(hsTz) {
    if (!hsTz) return null;
    const name = String(hsTz).replace(/^s:/, "");
    if (moment.tz.zone(name)) return name;
    return moment.tz.names().find((n) => n.split("/").pop() === name) || null;
}

// A boundary written in `iana` with the Haystack name the server needs after the offset.
const zonedFormat = (iana, hsName) => (ms) => `${moment(ms).tz(iana).format(ZONED_FORMAT)} ${hsName}`;

function parseEnd(token) {
    const tok = token.trim();
    if (DATE_ONLY_RE.test(tok)) {
        return moment.utc(tok, "YYYY-MM-DD", true).isValid() ? { kind: "date", iso: tok } : null;
    }
    const m = tok.match(DATETIME_RE);
    if (!m) return null;
    const [, local, offset, name] = m;
    const parsed = moment.parseZone(local + offset, moment.ISO_8601, true);
    if (!parsed.isValid()) return null;
    if (offset === "Z" && (!name || name === "UTC")) return { kind: "zulu", tok, ms: parsed.valueOf(), tzName: "UTC" };
    return name ? { kind: "named", tok, ms: parsed.valueOf(), tzName: name } : null;
}

/**
 * Classify a Haystack range for planning. Every request of a split plan must use ONE range form
 * the API server accepts (HDateTimeRange.make: two dates, or two datetimes with the same tz name):
 *   "utc"   both ends "...Z": interior boundaries are ISO "Z" instants;
 *   "named" both ends "<offset> <TzName>" with the same, mappable name: interior boundaries are
 *           written in that zone with that name;
 *   "date"  both ends dates: per timezone sub-group, both ends become local-midnight datetimes
 *           (the end is the day after the end date) with the point's tz name (see windowFor).
 * Anything else (relative keywords, one value, mixed forms, an offset without a name, a datetime
 * without an offset, two different names, an empty or inverted range) is not plannable: the
 * caller's range is sent verbatim, one request per group, and the server decides.
 */
function parseRange(range) {
    const raw = range.startsWith("s:") ? range.slice(2) : range;
    const parts = raw.split(",");
    if (parts.length !== 2) return { plannable: false, raw };
    const start = parseEnd(parts[0]);
    const end = parseEnd(parts[1]);
    if (!start || !end) return { plannable: false, raw };
    if (start.kind === "date" && end.kind === "date") {
        return start.iso <= end.iso ? { plannable: true, raw, form: "date", start, end } : { plannable: false, raw };
    }
    if (start.kind === "date" || end.kind === "date" || start.tzName !== end.tzName || !(start.ms < end.ms)) {
        return { plannable: false, raw };
    }
    if (start.kind === "zulu" && end.kind === "zulu") {
        return { plannable: true, raw, form: "utc", start, end };
    }
    const iana = ianaZone(start.tzName);
    return iana ? { plannable: true, raw, form: "named", start, end, iana } : { plannable: false, raw };
}

/**
 * The window a (sub-)group is planned over, and how its request ends are written. `zone` is the
 * sub-group's {iana, hsTz} for a "date" range, ignored otherwise. Returns null for a "date" range
 * whose sub-group has no mappable timezone (rule: send the caller's range verbatim).
 *   startMs/endMs      the absolute range, used for the COUNT histogram and to place boundaries;
 *   startTok/endTok    the first request's start and the last request's end in a split plan;
 *   format(ms)         an interior boundary (and a bisection midpoint) in the same form.
 */
function windowFor(parsed, zone) {
    if (parsed.form === "utc") {
        return { startMs: parsed.start.ms, endMs: parsed.end.ms, startTok: parsed.start.tok, endTok: parsed.end.tok, format: toIso };
    }
    if (parsed.form === "named") {
        return {
            startMs: parsed.start.ms, endMs: parsed.end.ms, startTok: parsed.start.tok, endTok: parsed.end.tok,
            format: zonedFormat(parsed.iana, parsed.start.tzName)
        };
    }
    if (!zone || !zone.iana) return null;
    // Same instants as the server's HDate.midnight(start) and HDate.midnight(end + 1 day) in the
    // point's timezone, so converting the ends does not change what is deleted.
    const startMs = moment.tz(parsed.start.iso, "YYYY-MM-DD", zone.iana).valueOf();
    const endMs = moment.tz(parsed.end.iso, "YYYY-MM-DD", zone.iana).add(1, "day").valueOf();
    const format = zonedFormat(zone.iana, zone.hsTz);
    return { startMs, endMs, startTok: format(startMs), endTok: format(endMs), format };
}

/**
 * Split ids by the raw Haystack `tz` tag of each point, keeping first-seen order. Each sub-group
 * carries that name (written after the offset of its converted range ends) and its IANA zone;
 * ids with no tz tag, or one that does not map to an IANA zone, get iana null.
 */
async function groupByZone(readFn, ids) {
    const grid = await readFn(ids.map(bareId));
    const tzById = new Map();
    for (const row of lodash.get(grid, "rows", []) || []) {
        if (row.id) tzById.set(bareId(row.id), row.tz ? String(row.tz).replace(/^s:/, "") : null);
    }
    const groups = new Map();
    for (const id of ids) {
        const hsTz = tzById.get(bareId(id)) || null;
        if (!groups.has(hsTz)) groups.set(hsTz, []);
        groups.get(hsTz).push(id);
    }
    return [...groups.entries()].map(([hsTz, groupIds]) => ({ hsTz, iana: ianaZone(hsTz), ids: groupIds }));
}

function buildCountQuery(ids, fromMs, toMs, unit) {
    const filter = ids.map((id) => `id==@${bareId(id)}`).join(" or ");
    return `haystack { search(filter: "${filter}") { entity { id ` +
        `history(rangeAbsolute: {start: "${toIso(fromMs)}", end: "${toIso(toMs)}"}) { ` +
        `aggregate(function: COUNT, allEntities: false, ` +
        `groupBy: {groupByUnits: ${unit}, groupBySize: 1, fill: NONE}) { ` +
        `timeSeries { dataPoints { time value } } } } } } }`;
}

/**
 * Turn a COUNT histogram response into buckets. A bucket's count is the maximum across the
 * group's entities, because the API limit applies per entity.
 */
function parseCountResponse(response, unit) {
    const gqlErrors = lodash.get(response, "errors");
    if (Array.isArray(gqlErrors) && gqlErrors.length > 0) {
        throw new Error(gqlErrors.map((e) => e.message).join("; "));
    }
    const byStart = new Map();
    for (const entity of lodash.get(response, "data.haystack.search.entity", []) || []) {
        for (const p of lodash.get(entity, "history.aggregate.timeSeries[0].dataPoints", []) || []) {
            const start = Number(p.time);
            const count = parseInt(p.value, 10);
            if (!Number.isFinite(start) || !(count > 0)) continue;
            byStart.set(start, Math.max(byStart.get(start) || 0, count));
        }
    }
    return [...byStart.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([start, count]) => ({ start, end: start + UNIT_MS[unit], count }));
}

// A bucket still over budget at the finest level is uniform enough at that scale to split
// arithmetically (CORE-9414 splitBucketByTime).
function splitBucketByTime(bucket, batchSize) {
    const slices = Math.ceil(bucket.count / batchSize);
    if (slices <= 1) return [bucket];
    const sliceMs = Math.ceil((bucket.end - bucket.start) / slices);
    const perSlice = Math.ceil(bucket.count / slices);
    const out = [];
    for (let i = 0; i < slices; i++) {
        const start = bucket.start + i * sliceMs;
        if (start >= bucket.end) break;
        out.push({ start, end: Math.min(start + sliceMs, bucket.end), count: perSlice });
    }
    return out;
}

async function refineBucket(countFn, bucket, units, level, batchSize) {
    if (bucket.count <= batchSize) return [bucket];
    if (level >= units.length - 1) return splitBucketByTime(bucket, batchSize);
    const finer = await countFn(bucket.start, bucket.end, units[level + 1]);
    if (finer.length === 0) return [bucket];
    const out = [];
    for (const b of finer) {
        out.push(...(await refineBucket(countFn, b, units, level + 1, batchSize)));
    }
    return out;
}

/**
 * Greedy-pack buckets under the budget. A new request may only start at a bucket edge strictly
 * inside the window; otherwise the bucket folds into the current request.
 */
function interiorBoundaries(buckets, batchSize, startMs, endMs) {
    const boundaries = [];
    let running = 0;
    for (const b of buckets) {
        const canCut = b.start > startMs && b.start < endMs;
        if (running > 0 && running + b.count > batchSize && canCut) {
            boundaries.push(b.start);
            running = 0;
        }
        running += b.count;
    }
    return boundaries;
}

// `range` is what is sent. startTok/endTok/format are the window's form, used whenever the
// request is split, so every piece of a split stays in one server-accepted form.
function makeRequest(ids, window, startTok, endTok, startMs, endMs, depth, range) {
    return {
        ids, startTok, endTok, startMs, endMs, depth, format: window.format,
        range: range || `s:${startTok},${endTok}`
    };
}

/** One request with the caller's range verbatim, never bisected (not plannable, or rule d). */
function unplannedRequest(ids, raw) {
    return { ids, startTok: null, endTok: null, startMs: NaN, endMs: NaN, depth: 0, format: null, range: `s:${raw}` };
}

/**
 * Requests for a window cut at `boundaries`. With no boundary the one request sends the caller's
 * range verbatim (it still carries the window's form, for bisection).
 */
function buildRequests(ids, parsed, window, boundaries) {
    if (boundaries.length === 0) {
        return [makeRequest(ids, window, window.startTok, window.endTok, window.startMs, window.endMs, 0, `s:${parsed.raw}`)];
    }
    const edges = [
        { tok: window.startTok, ms: window.startMs },
        ...boundaries.map((ms) => ({ tok: window.format(ms), ms })),
        { tok: window.endTok, ms: window.endMs }
    ];
    const requests = [];
    for (let i = 0; i < edges.length - 1; i++) {
        requests.push(makeRequest(ids, window, edges[i].tok, edges[i + 1].tok, edges[i].ms, edges[i + 1].ms, 0));
    }
    return requests;
}

async function planGroup(countFn, ids, parsed, window, { batchSize, countBucketUnits }) {
    const coarse = await countFn(window.startMs, window.endMs, countBucketUnits[0]);
    const buckets = [];
    for (const b of coarse) {
        buckets.push(...(await refineBucket(countFn, b, countBucketUnits, 0, batchSize)));
    }
    return buildRequests(ids, parsed, window, interiorBoundaries(buckets, batchSize, window.startMs, window.endMs));
}

/**
 * Halve a request at its midpoint, written in the request's own form. Returns null when it
 * cannot be split (unplanned, or too short to halve).
 */
function splitRequest(req) {
    if (!req.format) return null;
    const mid = Math.floor((req.startMs + req.endMs) / 2);
    if (!(mid > req.startMs && mid < req.endMs)) return null;
    const window = { format: req.format };
    const midTok = req.format(mid);
    return [
        makeRequest(req.ids, window, req.startTok, midTok, req.startMs, mid, req.depth + 1),
        makeRequest(req.ids, window, midTok, req.endTok, mid, req.endMs, req.depth + 1)
    ];
}

module.exports = {
    UNIT_MS,
    parseRange,
    ianaZone,
    groupByZone,
    windowFor,
    buildCountQuery,
    parseCountResponse,
    planGroup,
    unplannedRequest,
    splitRequest
};
