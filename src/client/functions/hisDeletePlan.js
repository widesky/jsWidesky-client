"use strict";

const lodash = require("lodash");
const moment = require("moment-timezone");

const UNIT_MS = Object.freeze({
    WEEK: 604800000, DAY: 86400000, HOUR: 3600000, MINUTE: 60000, SECOND: 1000
});

// Largest UTC offset in use (UTC+14). Fallback margin for an offset-less range end on a point
// whose timezone is unknown: every possible resolution lies within this distance of UTC.
const TZ_MARGIN_MS = 14 * 3600000;
const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

const toIso = (ms) => new Date(ms).toISOString();

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

function parseEnd(token, isEnd) {
    const iso = token.trim().split(" ")[0];
    if (DATE_ONLY_RE.test(iso)) {
        return moment.utc(iso, "YYYY-MM-DD", true).isValid() ? { iso, isEnd, dateOnly: true, tzLess: true } : null;
    }
    const hasOffset = OFFSET_RE.test(iso);
    const m = hasOffset ? moment.parseZone(iso, moment.ISO_8601, true) : moment.utc(iso, moment.ISO_8601, true);
    return m.isValid() ? { iso, isEnd, dateOnly: false, tzLess: !hasOffset, ms: hasOffset ? m.valueOf() : undefined } : null;
}

// Resolve one end in `zone` (IANA, or null for unknown). A date-only end includes that whole
// local day. Returns the instant and the margin that still applies to it.
function resolveEnd(end, zone) {
    if (!end.tzLess) return { ms: end.ms, margin: 0 };
    const tz = zone || "UTC";
    const m = end.dateOnly ? moment.tz(end.iso, "YYYY-MM-DD", tz) : moment.tz(end.iso, moment.ISO_8601, tz);
    if (end.dateOnly && end.isEnd) m.add(1, "day");
    return { ms: m.valueOf(), margin: zone ? 0 : TZ_MARGIN_MS };
}

/**
 * Parse a Haystack range for planning. Relative keywords, single values and unparseable input
 * are not plannable; the caller sends them as-is.
 */
function parseRange(range) {
    const raw = range.startsWith("s:") ? range.slice(2) : range;
    const parts = raw.split(",");
    if (parts.length !== 2) return { plannable: false, raw };
    const start = parseEnd(parts[0], false);
    const end = parseEnd(parts[1], true);
    if (!start || !end) return { plannable: false, raw };
    const parsed = {
        plannable: true, raw, start, end,
        startTok: parts[0].trim(), endTok: parts[1].trim(),
        tzLess: start.tzLess || end.tzLess
    };
    const probe = windowFor(parsed, "UTC");
    return probe.safeStart < probe.safeEnd ? parsed : { plannable: false, raw };
}

/**
 * The absolute window a sub-group of points in `zone` is planned over. countStart/countEnd bound
 * the histogram; safeStart/safeEnd bound interior boundaries, so no request can start before or
 * end after any point's resolved range. Equal for a known zone; widened / narrowed by the
 * fallback margin for an unknown zone.
 */
function windowFor(parsed, zone) {
    const s = resolveEnd(parsed.start, zone);
    const e = resolveEnd(parsed.end, zone);
    return { countStart: s.ms - s.margin, countEnd: e.ms + e.margin, safeStart: s.ms + s.margin, safeEnd: e.ms - e.margin };
}

/**
 * Split ids by the IANA zone of their `tz` tag, keeping first-seen order. Ids with no or an
 * unmappable tz are grouped under zone null.
 */
async function groupByZone(readFn, ids) {
    const grid = await readFn(ids);
    const zoneById = new Map();
    for (const row of lodash.get(grid, "rows", []) || []) {
        const id = String(row.id || "").replace(/^r:/, "").split(" ")[0];
        zoneById.set(id, ianaZone(row.tz));
    }
    const groups = new Map();
    for (const id of ids) {
        const zone = zoneById.get(String(id).replace(/^r:/, "")) || null;
        if (!groups.has(zone)) groups.set(zone, []);
        groups.get(zone).push(id);
    }
    return [...groups.entries()].map(([zone, groupIds]) => ({ zone, ids: groupIds }));
}

function buildCountQuery(ids, fromMs, toMs, unit) {
    const filter = ids.map((id) => `id==@${String(id).replace(/^r:/, "")}`).join(" or ");
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
 * inside the safe interior; otherwise the bucket folds into the current request.
 */
function interiorBoundaries(buckets, batchSize, safeStart, safeEnd) {
    const boundaries = [];
    let running = 0;
    for (const b of buckets) {
        const canCut = b.start > safeStart && b.start < safeEnd;
        if (running > 0 && running + b.count > batchSize && canCut) {
            boundaries.push(b.start);
            running = 0;
        }
        running += b.count;
    }
    return boundaries;
}

function makeRequest(ids, startTok, endTok, startMs, endMs, depth) {
    return { ids, startTok, endTok, startMs, endMs, depth, range: `s:${startTok},${endTok}` };
}

function unplannedRequest(ids, raw) {
    return { ids, startTok: null, endTok: null, startMs: NaN, endMs: NaN, depth: 0, range: `s:${raw}` };
}

function buildRequests(ids, parsed, window, boundaries) {
    const edges = [
        { tok: parsed.startTok, ms: window.safeStart },
        ...boundaries.map((ms) => ({ tok: toIso(ms), ms })),
        { tok: parsed.endTok, ms: window.safeEnd }
    ];
    const requests = [];
    for (let i = 0; i < edges.length - 1; i++) {
        requests.push(makeRequest(ids, edges[i].tok, edges[i + 1].tok, edges[i].ms, edges[i + 1].ms, 0));
    }
    return requests;
}

async function planGroup(countFn, ids, parsed, window, { batchSize, countBucketUnits }) {
    const coarse = await countFn(window.countStart, window.countEnd, countBucketUnits[0]);
    const buckets = [];
    for (const b of coarse) {
        buckets.push(...(await refineBucket(countFn, b, countBucketUnits, 0, batchSize)));
    }
    return buildRequests(ids, parsed, window, interiorBoundaries(buckets, batchSize, window.safeStart, window.safeEnd));
}

/**
 * Halve a request at its midpoint. startMs/endMs of an original end token are the safe-interior
 * bounds, so the midpoint always lies inside the safe interior. Returns null when it cannot be
 * split (unplanned, or no safe interior).
 */
function splitRequest(req) {
    const mid = Math.floor((req.startMs + req.endMs) / 2);
    if (!(mid > req.startMs && mid < req.endMs)) return null;
    return [
        makeRequest(req.ids, req.startTok, toIso(mid), req.startMs, mid, req.depth + 1),
        makeRequest(req.ids, toIso(mid), req.endTok, mid, req.endMs, req.depth + 1)
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
