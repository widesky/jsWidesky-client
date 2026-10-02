"use strict";

const lodash = require("lodash");
const moment = require("moment-timezone");
const Ref = require("../../dataTypes/ref");

const UNIT_MS = Object.freeze({
    WEEK: 604800000, DAY: 86400000, HOUR: 3600000, MINUTE: 60000, SECOND: 1000
});

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
// A Zinc datetime as the API server reads it: seconds are mandatory ("Expected ':' for time
// value"), then offset "Z" or "+hh:mm" (colon required), then an optional " TzName". The server
// requires the name after "+hh:mm"; "Z" alone means UTC.
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:\d{2})(?: (\S+))?$/;
const ZERO_OFFSET_RE = /^(Z|[+-]00:00)$/;
const ZONED_FORMAT = "YYYY-MM-DDTHH:mm:ss.SSSZ";
const WALL_FORMAT = "YYYY-MM-DDTHH:mm:ss.SSS";
const HOUR_MS = 3600000;
const MIN_MS = 60000;

/**
 * How a window's range ends are written. Every request of one split plan uses one form.
 * @typedef {Object} BoundaryForm
 * @property {function(number): string} format Writes an epoch-ms instant as a range end token.
 * @property {function(number): boolean} cuttable Whether the server reads format(ms) back as ms.
 */

/**
 * One end of a caller's range, as parseEnd reads it.
 * @typedef {Object} RangeEnd
 * @property {"date"|"zulu"|"named"} kind Date only, "...Z", or "<offset> <TzName>".
 * @property {string} [iso] The "YYYY-MM-DD" date (kind "date").
 * @property {string} [tok] The token as written (kind "zulu" or "named").
 * @property {number} [ms] The instant in epoch ms (kind "zulu" or "named").
 * @property {string} [tzName] The Haystack tz name ("UTC" for kind "zulu").
 */

/**
 * A caller's range classified for planning (see parseRange).
 * @typedef {Object} ParsedRange
 * @property {boolean} plannable false when the range cannot be split, so it is not sent.
 * @property {string} raw The range without its "s:" prefix.
 * @property {"utc"|"named"|"date"} [form] How the range is planned (plannable only).
 * @property {RangeEnd} [start] The first end (plannable only).
 * @property {RangeEnd} [end] The second end (plannable only).
 * @property {string} [iana] The IANA zone of a "named" range.
 * @property {"today"|"yesterday"} [relative] Set for a relative "date" range; its dates are
 *     resolved per point timezone against "now" (see windowFor) and always sent as datetimes.
 */

/**
 * Ids that share one Haystack `tz` tag.
 * @typedef {Object} ZoneGroup
 * @property {string|null} hsTz The raw tz tag, or null when the points have none.
 * @property {string|null} iana Its IANA zone, or null when it does not map to one.
 * @property {string[]} ids The point ids, in the caller's order.
 */

/**
 * The window a (sub-)group is planned over (see windowFor), or why it cannot be cut.
 * @typedef {Object} PlanWindow
 * @property {string} [unsplittable] Set instead of every other field when the window cannot be
 *     cut; the reason is reported and nothing is sent.
 * @property {number} [startMs] Start instant in epoch ms.
 * @property {number} [endMs] End instant in epoch ms.
 * @property {string} [startTok] The first request's start token.
 * @property {string} [endTok] The last request's end token.
 * @property {function(number): string} [format] See BoundaryForm.
 * @property {function(number): boolean} [cuttable] See BoundaryForm.
 */

/**
 * One COUNT histogram bucket, counted as the rows of all the group's entities in it.
 * @typedef {Object} Bucket
 * @property {number} start Bucket start in epoch ms (inclusive).
 * @property {number} end Bucket end in epoch ms (exclusive).
 * @property {number} count Rows in the bucket, summed over the group's entities.
 */

/**
 * One planned hisDelete request.
 * @typedef {Object} DeleteRequest
 * @property {string[]} ids Point ids, at most batchSizeEntity of them.
 * @property {string} startTok Start token in the window's form.
 * @property {string} endTok End token in the window's form.
 * @property {number} startMs Start in epoch ms.
 * @property {number} endMs End in epoch ms.
 * @property {number} depth Times this request has been bisected.
 * @property {function(number): string} format Boundary writer, see BoundaryForm.
 * @property {function(number): boolean} cuttable Boundary check, see BoundaryForm.
 * @property {string} range The "s:start,end" range that is sent.
 */

/**
 * Counts a group's rows between two instants, one bucket per `unit`.
 * @callback CountFn
 * @param {number} fromMs Start in epoch ms.
 * @param {number} toMs End in epoch ms.
 * @param {string} unit A GraphQL duration unit ("DAY", "HOUR", ...).
 * @returns {Promise<Bucket[]>} Non-empty buckets, oldest first.
 */

/**
 * Write an epoch-ms instant as an ISO 8601 UTC string.
 * @param {number} ms Epoch milliseconds.
 * @returns {string} e.g. "2026-09-01T00:00:00.000Z".
 */
const toIso = (ms) => new Date(ms).toISOString();

/**
 * The bare uuid of an id in any form client.hisDelete accepts ("uuid", "r:uuid Dis", "@uuid").
 * @param {string} id A point id.
 * @returns {string} The uuid alone.
 */
const bareId = (id) => new Ref(id).id;

/**
 * Map a Haystack timezone name to an IANA zone. Haystack names are the city part of the IANA
 * name ("Brisbane" -> "Australia/Brisbane"); an IANA name or "UTC" passes through.
 * @param {string|null|undefined} hsTz A Haystack tz name, with or without "s:".
 * @returns {string|null} The IANA zone, or null when there is none.
 */
function ianaZone(hsTz) {
    if (!hsTz) return null;
    const name = String(hsTz).replace(/^s:/, "");
    if (moment.tz.zone(name)) return name;
    return moment.tz.names().find((n) => n.split("/").pop() === name) || null;
}

/**
 * True when the wall time of `ms` in `zone` (a moment-timezone Zone) names more than one instant,
 * i.e. `ms` falls in the hour a DST change repeats. The server reads a zero-offset token as wall
 * time, so such an instant cannot be written in that form without guessing which one it picks.
 * @param {moment.MomentZone} zone The zone to test in.
 * @param {number} ms Epoch milliseconds.
 * @returns {boolean} true inside a repeated DST hour.
 */
function isAmbiguousWall(zone, ms) {
    const own = zone.utcOffset(ms);             // minutes, UTC = local + offset
    const wall = ms - own * 60000;
    for (const other of [zone.utcOffset(ms - 3 * HOUR_MS), zone.utcOffset(ms + 3 * HOUR_MS)]) {
        if (other !== own && zone.utcOffset(wall + other * 60000) === other) return true;
    }
    return false;
}

/**
 * A boundary form: `format(ms)` writes an instant as a range end, and `cuttable(ms)` says whether
 * the server reads that token back as exactly `ms`.
 *
 * realOffset: `iana`'s real offset then the Haystack name ("...+10:00 Brisbane"). A token whose
 *     offset is zero is read as wall time (see wallTime), so it is cuttable only when unambiguous.
 * @param {string} iana IANA zone the instants are written in.
 * @param {string} hsName Haystack tz name written after the offset.
 * @returns {BoundaryForm}
 */
function realOffsetForm(iana, hsName) {
    const zone = moment.tz.zone(iana);
    return {
        format: (ms) => `${moment(ms).tz(iana).format(ZONED_FORMAT)} ${hsName}`,
        cuttable: (ms) => zone.utcOffset(ms) !== 0 || !isAmbiguousWall(zone, ms)
    };
}

/**
 * wallTime: local wall time in `iana`, then "+00:00 " and the Haystack name
 * ("2026-09-01T00:00:00.000+00:00 Adelaide").
 *
 * DELIBERATE COUPLING to two API server behaviours (widesky-api-server):
 *   1. HZincReader computes a datetime offset as tzHours*60 + tzMins*60 minutes, so a real
 *      "+09:30 Adelaide" token is read as +39:00, about 29.5 h early;
 *   2. timezoneSvc.timezoneEpoch applies the parsed offset only when it is non-zero, so a zero
 *      offset with a zone name is read as local wall time in that zone.
 * Date-only ranges in zones whose offset has non-zero minutes are therefore written in this form,
 * which the server reads as the intended instant. A server fix to EITHER behaviour changes what
 * these tokens mean; the live-stack check (test/integration/hisDelete-e2e.js, Adelaide points)
 * pins it.
 * @param {string} iana IANA zone whose wall time is written.
 * @param {string} hsName Haystack tz name written after "+00:00".
 * @returns {BoundaryForm}
 */
function wallTimeForm(iana, hsName) {
    const zone = moment.tz.zone(iana);
    return {
        format: (ms) => `${moment(ms).tz(iana).format(WALL_FORMAT)}+00:00 ${hsName}`,
        cuttable: (ms) => !isAmbiguousWall(zone, ms)
    };
}

const UTC_FORM = Object.freeze({ format: toIso, cuttable: () => true });

/**
 * True when `zone`'s UTC offset has non-zero minutes at either end of [startMs, endMs] or in any
 * period that starts inside it.
 * @param {moment.MomentZone} zone The zone to test.
 * @param {number} startMs Window start in epoch ms.
 * @param {number} endMs Window end in epoch ms.
 * @returns {boolean}
 */
function hasPartHourOffset(zone, startMs, endMs) {
    const at = [startMs, endMs, ...zone.untils.filter((u) => u > startMs && u < endMs)];
    return at.some((ms) => zone.utcOffset(ms) % 60 !== 0);
}

/**
 * True when a UTC-offset change inside (startMs, endMs) is not a whole number of hours (Lord_Howe's
 * 30-minute DST). The server's wall-time and offset arithmetic cannot place a cut around one.
 * @param {moment.MomentZone} zone The zone to test.
 * @param {number} startMs Window start in epoch ms.
 * @param {number} endMs Window end in epoch ms.
 * @returns {boolean}
 */
function hasSubHourTransition(zone, startMs, endMs) {
    return zone.untils
        .filter((u) => u > startMs && u < endMs)
        .some((u) => (zone.utcOffset(u) - zone.utcOffset(u - 1)) % 60 !== 0);
}

/**
 * Why a window in `iana` cannot be cut (so it is not sent), or null.
 * `named` callers write real offsets, which the server misreads whenever they carry minutes.
 * @param {string} iana IANA zone of the window.
 * @param {number} startMs Window start in epoch ms.
 * @param {number} endMs Window end in epoch ms.
 * @param {boolean} named true when the caller wrote "<offset> <TzName>" ends.
 * @returns {string|null} The reason, or null when the window can be cut.
 */
function unsplittableReason(iana, startMs, endMs, named) {
    const zone = moment.tz.zone(iana);
    if (hasSubHourTransition(zone, startMs, endMs)) {
        return `${iana} has a UTC-offset change that is not a whole number of hours in the range`;
    }
    if (named && hasPartHourOffset(zone, startMs, endMs)) {
        return `${iana} has a part-hour UTC offset in the range, which the server misreads in a cut`;
    }
    return null;
}

/**
 * Read one end of a Haystack range.
 * @param {string} token A date or datetime token.
 * @returns {RangeEnd|null} The end, or null when it is not a form the planner can cut around.
 */
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
    if (!name) return null;
    // The server applies no zero offset, reading the wall time in the named zone
    // (timezoneSvc.timezoneEpoch). "Z <Name>" is left to the server; "+00:00 <Name>" is planned
    // only where that wall time is exactly the ISO instant (the zone is at UTC+0 then, outside a
    // repeated DST hour).
    if (ZERO_OFFSET_RE.test(offset) && name !== "UTC") {
        const iana = offset === "Z" ? null : ianaZone(name);
        const zone = iana && moment.tz.zone(iana);
        if (!zone || zone.utcOffset(parsed.valueOf()) !== 0 || isAmbiguousWall(zone, parsed.valueOf())) return null;
    }
    return { kind: "named", tok, ms: parsed.valueOf(), tzName: name };
}

/**
 * Classify a Haystack range for planning. Every request of a split plan must use ONE range form
 * the API server accepts (HDateTimeRange.make: two dates, or two datetimes with the same tz name):
 *   "utc"   both ends "...Z": interior boundaries are ISO "Z" instants;
 *   "named" both ends "<offset> <TzName>" with the same, mappable name: interior boundaries are
 *           written in that zone with that name;
 *   "date"  both ends dates, one date (that day), or "today" / "yesterday" (that day in each
 *           point's timezone): per timezone sub-group, both ends become local-midnight datetimes
 *           (the end is the day after the end date) with the point's tz name (see windowFor).
 * Anything else (other keywords, one datetime, mixed forms, an offset without a name, a datetime
 * without an offset or without seconds, "Z <Name>" for a zone other than UTC, "+00:00 <Name>"
 * where that zone is not at UTC+0, two different names, an empty or inverted range) is not
 * plannable, and batch.hisDelete does not send it.
 * @param {string} range Haystack range, with or without "s:".
 * @returns {ParsedRange}
 */
function parseRange(range) {
    const raw = range.startsWith("s:") ? range.slice(2) : range;
    if (raw === "today" || raw === "yesterday") {
        return { plannable: true, raw, form: "date", relative: raw };
    }
    const parts = raw.split(",");
    if (parts.length === 1) {
        const day = parseEnd(parts[0]);
        return day && day.kind === "date"
            ? { plannable: true, raw, form: "date", start: day, end: day }
            : { plannable: false, raw };
    }
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
 * sub-group's {iana, hsTz} for a "date" range, ignored otherwise. A window that cannot be cut at
 * all (including a "date" range whose sub-group has no mappable timezone) returns
 * `{ unsplittable: <reason> }`, and batch.hisDelete does not send it. A relative range's day is
 * the day of `nowMs` in the point's timezone ("yesterday": the day before).
 *   startMs/endMs      the true instants of the range, used for the COUNT histogram and to place
 *                      boundaries (for a "date" range, the local midnights the server gives the
 *                      dates in the point's timezone);
 *   startTok/endTok    the first request's start and the last request's end in a split plan;
 *   format(ms)         an interior boundary (and a bisection midpoint) in the same form;
 *   cuttable(ms)       whether format(ms) is read back by the server as exactly ms (false only
 *                      for a zero-offset token in the hour a DST change repeats).
 * A "date" window is written with the real offset in a whole-hour zone (realOffsetForm), or as
 * local wall time + "+00:00 <Name>" in a zone with a part-hour offset anywhere in the window
 * (wallTimeForm), because the server misreads "+09:30". A "date" window whose own ends are not
 * cuttable also returns null. A "named" caller range keeps the caller's offset form, but only in
 * a zone with no part-hour offset in the window: cuts written "+09:30 Adelaide" would be misread
 * by the server (~29.5 h), even when the caller wrote a whole-hour offset. Those, and any window
 * containing a sub-hour offset transition (date or named), are left unsplit.
 * @param {ParsedRange} parsed A plannable range.
 * @param {ZoneGroup|{ids: string[]}} zone The sub-group being planned; its iana and hsTz are
 *     used for a "date" range only.
 * @param {number} nowMs "Now" in epoch ms, for a relative range.
 * @returns {PlanWindow}
 */
function windowFor(parsed, zone, nowMs) {
    if (parsed.form === "utc") {
        return { startMs: parsed.start.ms, endMs: parsed.end.ms, startTok: parsed.start.tok, endTok: parsed.end.tok, ...UTC_FORM };
    }
    if (parsed.form === "named") {
        const reason = unsplittableReason(parsed.iana, parsed.start.ms, parsed.end.ms, true);
        if (reason) return { unsplittable: reason };
        return {
            startMs: parsed.start.ms, endMs: parsed.end.ms, startTok: parsed.start.tok, endTok: parsed.end.tok,
            ...realOffsetForm(parsed.iana, parsed.start.tzName)
        };
    }
    if (!zone || !zone.iana) return { unsplittable: `no usable timezone (${zone && zone.hsTz})` };
    // The instants the server gives the dates (HDate.midnight(start) and HDate.midnight(end + 1
    // day), read as local wall time in the point's timezone). Counting and packing use them.
    let [startIso, endIso] = [parsed.start && parsed.start.iso, parsed.end && parsed.end.iso];
    if (parsed.relative) {
        const day = moment.tz(nowMs, zone.iana).startOf("day");
        if (parsed.relative === "yesterday") day.subtract(1, "day");
        startIso = endIso = day.format("YYYY-MM-DD");
    }
    const startMs = moment.tz(startIso, "YYYY-MM-DD", zone.iana).valueOf();
    const endMs = moment.tz(endIso, "YYYY-MM-DD", zone.iana).add(1, "day").valueOf();
    const reason = unsplittableReason(zone.iana, startMs, endMs, false);
    if (reason) return { unsplittable: reason };
    // The tokens must be read back as those instants: whole-hour zones keep the real offset;
    // zones with a part-hour offset anywhere in the window use wall time (see wallTimeForm).
    const form = hasPartHourOffset(moment.tz.zone(zone.iana), startMs, endMs)
        ? wallTimeForm(zone.iana, zone.hsTz) : realOffsetForm(zone.iana, zone.hsTz);
    if (!form.cuttable(startMs) || !form.cuttable(endMs)) {
        return { unsplittable: `a range end falls in a repeated DST hour in ${zone.iana}` };
    }
    return { startMs, endMs, startTok: form.format(startMs), endTok: form.format(endMs), ...form };
}

/**
 * Split ids by the raw Haystack `tz` tag of each point, keeping first-seen order. Each sub-group
 * carries that name (written after the offset of its converted range ends) and its IANA zone;
 * ids with no tz tag, or one that does not map to an IANA zone, get iana null.
 * An id may be a uuid or an fqname (the server accepts both): the rows it returns carry the
 * point's uuid `id` and an `fqname` tag, so each id is matched to its row by either.
 * @param {function(string[]): Promise<{rows: Object[]}>} readFn Reads the points by bare id.
 * @param {string[]} ids Point ids (uuid or fqname, in any form hisDelete accepts).
 * @returns {Promise<ZoneGroup[]>}
 */
async function groupByZone(readFn, ids) {
    const grid = await readFn(ids.map(bareId));
    const tzByKey = new Map();
    for (const row of lodash.get(grid, "rows", []) || []) {
        const tz = row.tz ? String(row.tz).replace(/^s:/, "") : null;
        if (row.id) tzByKey.set(bareId(row.id), tz);
        if (row.fqname) tzByKey.set(String(row.fqname).replace(/^s:/, ""), tz);
    }
    const groups = new Map();
    for (const id of ids) {
        const hsTz = tzByKey.get(bareId(id)) || null;
        if (!groups.has(hsTz)) groups.set(hsTz, []);
        groups.get(hsTz).push(id);
    }
    return [...groups.entries()].map(([hsTz, groupIds]) => ({ hsTz, iana: ianaZone(hsTz), ids: groupIds }));
}

/**
 * The GraphQL COUNT histogram query for a group of points.
 * @param {string[]} ids Point ids.
 * @param {number} fromMs Start in epoch ms.
 * @param {number} toMs End in epoch ms.
 * @param {string} unit GraphQL duration unit of each bucket.
 * @returns {string} The query text.
 */
function buildCountQuery(ids, fromMs, toMs, unit) {
    const filter = ids.map((id) => `id==@${bareId(id)}`).join(" or ");
    return `haystack { search(filter: "${filter}") { entity { id ` +
        `history(rangeAbsolute: {start: "${toIso(fromMs)}", end: "${toIso(toMs)}"}) { ` +
        `aggregate(function: COUNT, allEntities: false, ` +
        `groupBy: {groupByUnits: ${unit}, groupBySize: 1, fill: NONE}) { ` +
        `timeSeries { dataPoints { time value } } } } } } }`;
}

/**
 * Turn a COUNT histogram response into buckets. A bucket's count is the sum across the group's
 * entities, because batchSize bounds the rows of a whole request, not of each entity in it.
 * @param {Object} response The GraphQL response of buildCountQuery.
 * @param {string} unit The query's bucket unit (sets each bucket's end).
 * @returns {Bucket[]} Non-empty buckets, oldest first.
 * @throws {Error} When the response carries GraphQL errors.
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
            byStart.set(start, (byStart.get(start) || 0) + count);
        }
    }
    return [...byStart.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([start, count]) => ({ start, end: start + UNIT_MS[unit], count }));
}

/**
 * Halve an over-budget bucket and count each half exactly, repeating until every piece holds at
 * most `batchSize` rows. The server counts a range as [from, to) to the millisecond whatever the
 * bucket unit, so a COUNT over a piece, summed across its buckets, is its exact row count. Only
 * the left half is counted: the right half holds the rest. A piece of 1 ms cannot be halved; it
 * holds at most one row per entity, which hisDelete keeps within batchSize by capping the
 * entities per request at batchSize.
 * @param {CountFn} countFn Counts the group's rows.
 * @param {Bucket} bucket A bucket with an exact count, clipped to the window.
 * @param {number} batchSize Most rows in one request, summed over its entities.
 * @returns {Promise<Bucket[]>} Non-empty pieces, oldest first.
 */
async function halveBucket(countFn, bucket, batchSize) {
    if (bucket.count <= batchSize || bucket.end - bucket.start < 2) return [bucket];
    const mid = Math.floor((bucket.start + bucket.end) / 2);
    const leftCount = (await countFn(bucket.start, mid, "WEEK")).reduce((n, b) => n + b.count, 0);
    const halves = [
        { start: bucket.start, end: mid, count: leftCount },
        { start: mid, end: bucket.end, count: bucket.count - leftCount }
    ];
    const out = [];
    for (const half of halves.filter((h) => h.count > 0)) {
        out.push(...(await halveBucket(countFn, half, batchSize)));
    }
    return out;
}

/**
 * Re-count an over-budget bucket at the next finer unit, recursively, then halve any bucket
 * still over budget at the finest unit (see halveBucket), until every bucket fits.
 * @param {CountFn} countFn Counts the group's rows.
 * @param {Bucket} bucket The bucket to refine.
 * @param {string[]} units countBucketUnits, coarsest first.
 * @param {number} level Index of `bucket`'s unit in `units`.
 * @param {number} batchSize Most rows in one request, summed over its entities.
 * @returns {Promise<Bucket[]>}
 */
async function refineBucket(countFn, bucket, units, level, batchSize) {
    if (bucket.count <= batchSize) return [bucket];
    if (level >= units.length - 1) return halveBucket(countFn, bucket, batchSize);
    const finer = await countFn(bucket.start, bucket.end, units[level + 1]);
    if (finer.length === 0) return [bucket];
    const out = [];
    for (const b of finer) {
        out.push(...(await refineBucket(countFn, b, units, level + 1, batchSize)));
    }
    return out;
}

/**
 * Before each run of buckets that cannot start a request (a repeated DST hour), make the unit the
 * run is packed with (see interiorBoundaries) as small as a cut allows: find the latest instant
 * before the run that the window's form can write. If it falls in the empty gap after the bucket
 * before the run, a zero-row marker starts there; if it falls inside that bucket, the bucket is
 * split there and its tail counted exactly. Instants are tried 1 ms before the run, then back a
 * minute at a time, for up to 3 hours. A repeated DST hour lasts at most an hour, so 3 hours
 * always reaches a writable instant; this is a property of timezones, not a site preference, so
 * it is not configurable.
 * @param {CountFn} countFn Counts the group's rows.
 * @param {Bucket[]} buckets Buckets oldest first, clipped to the window.
 * @param {PlanWindow} window The window being split.
 * @returns {Promise<Bucket[]>}
 */
async function splitBeforeUncuttable(countFn, buckets, window) {
    const canStart = (ms) => ms > window.startMs && ms < window.endMs && window.cuttable(ms);
    const out = [];
    for (const b of buckets) {
        const prev = out[out.length - 1];
        // prev leads a unit when it can start a request or is the window's first bucket.
        if (prev && !canStart(b.start) && (out.length === 1 || canStart(prev.start))) {
            const candidates = [b.start - 1, ...Array.from({ length: 180 }, (_, k) => b.start - (k + 1) * MIN_MS)];
            const cut = candidates.find((ms) => ms > prev.start && canStart(ms));
            if (cut !== undefined && cut >= prev.end) {
                out.push({ start: cut, end: b.start, count: 0 });
            } else if (cut !== undefined) {
                const tail = (await countFn(cut, prev.end, "WEEK")).reduce((n, x) => n + x.count, 0);
                out.pop();
                if (prev.count - tail > 0) out.push({ start: prev.start, end: cut, count: prev.count - tail });
                out.push({ start: cut, end: prev.end, count: tail });
            }
        }
        out.push(b);
    }
    return out;
}

/**
 * Greedy-pack buckets under the budget. A new request may only start at a bucket edge strictly
 * inside the window that the window's form can write (see BoundaryForm). A bucket that cannot
 * start a request is packed as one unit with the bucket before it, so the packer cuts before the
 * whole run rather than filling a request up to it and then having to add the run as well.
 * @param {Bucket[]} buckets Buckets oldest first.
 * @param {number} batchSize Most rows in one request, summed over its entities.
 * @param {PlanWindow} window The window being split.
 * @returns {number[]} Cut instants in epoch ms, ascending.
 */
function interiorBoundaries(buckets, batchSize, window) {
    const { startMs, endMs } = window;
    const units = [];
    for (const b of buckets) {
        const canCut = b.start > startMs && b.start < endMs && window.cuttable(b.start);
        if (canCut || units.length === 0) {
            units.push({ start: b.start, count: b.count, canCut });
        } else {
            units[units.length - 1].count += b.count;
        }
    }
    const boundaries = [];
    let running = 0;
    for (const u of units) {
        if (running > 0 && running + u.count > batchSize && u.canCut) {
            boundaries.push(u.start);
            running = 0;
        }
        running += u.count;
    }
    return boundaries;
}

/**
 * Build one request. `range` is what is sent. startTok/endTok/format/cuttable are the window's form, used whenever
 * the request is split, so every piece of a split stays in one server-accepted form.
 * @param {string[]} ids Point ids.
 * @param {BoundaryForm} window The form the request is written in.
 * @param {string} startTok Start token.
 * @param {string} endTok End token.
 * @param {number} startMs Start in epoch ms.
 * @param {number} endMs End in epoch ms.
 * @param {number} depth Bisection depth.
 * @param {string} [range] Range to send; defaults to "s:startTok,endTok".
 * @returns {DeleteRequest}
 */
function makeRequest(ids, window, startTok, endTok, startMs, endMs, depth, range) {
    return {
        ids, startTok, endTok, startMs, endMs, depth, format: window.format, cuttable: window.cuttable,
        range: range || `s:${startTok},${endTok}`
    };
}

/**
 * Requests for a window cut at `boundaries`. With no boundary the one request sends the caller's
 * range verbatim (it still carries the window's form, for bisection), except a relative range:
 * that is sent as the planned datetimes, so the server cannot resolve it to another day.
 * @param {string[]} ids Point ids.
 * @param {ParsedRange} parsed The caller's range.
 * @param {PlanWindow} window The window being split.
 * @param {number[]} boundaries Cut instants in epoch ms, ascending.
 * @returns {DeleteRequest[]}
 */
function buildRequests(ids, parsed, window, boundaries) {
    if (boundaries.length === 0) {
        const range = parsed.relative ? undefined : `s:${parsed.raw}`;
        return [makeRequest(ids, window, window.startTok, window.endTok, window.startMs, window.endMs, 0, range)];
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

/**
 * Plan one (sub-)group: count it, refine over-budget buckets and pack them into requests. A
 * bucket that cannot be cut from the one before it (a repeated DST hour, see BoundaryForm) joins
 * that request; if that takes a request over batchSize, the group is not planned.
 * @param {CountFn} countFn Counts the group's rows.
 * @param {string[]} ids Point ids.
 * @param {ParsedRange} parsed The caller's range.
 * @param {PlanWindow} window The window to plan over.
 * @param {Object} options Resolved batch.hisDelete options.
 * @param {number} options.batchSize Most rows in one request, summed over its entities.
 * @param {string[]} options.countBucketUnits Histogram units, coarsest first.
 * @returns {Promise<{requests: DeleteRequest[]}|{overBudget: string}>} The requests, or why the
 *     group cannot be cut into requests of at most batchSize rows.
 */
async function planGroup(countFn, ids, parsed, window, { batchSize, countBucketUnits }) {
    // Buckets are aligned to their unit, so the first and last can reach outside the counted
    // range. Clip them, so a re-count of a bucket never counts rows outside the window.
    const clipped = async (fromMs, toMs, unit) => (await countFn(fromMs, toMs, unit))
        .map((b) => ({ start: Math.max(b.start, fromMs), end: Math.min(b.end, toMs), count: b.count }));
    const coarse = await clipped(window.startMs, window.endMs, countBucketUnits[0]);
    const buckets = [];
    for (const b of coarse) {
        buckets.push(...(await refineBucket(clipped, b, countBucketUnits, 0, batchSize)));
    }
    const packed = await splitBeforeUncuttable(clipped, buckets, window);
    const boundaries = interiorBoundaries(packed, batchSize, window);
    const totals = new Array(boundaries.length + 1).fill(0);
    for (const b of packed) {
        totals[boundaries.filter((cut) => cut <= b.start).length] += b.count;
    }
    const worst = Math.max(...totals);
    if (worst > batchSize) {
        return { overBudget: `a request would hold ${worst} rows, more than batchSize (${batchSize}) rows, ` +
            "because no cut can be placed where they fall (a repeated daylight-saving hour)" };
    }
    const requests = buildRequests(ids, parsed, window, boundaries);
    // Planned rows per request, for progress reporting: requests line up with totals.
    requests.forEach((req, i) => {
        req.rows = totals[i];
    });
    return { requests };
}

/**
 * Halve a request at its midpoint, written in the request's own form. A midpoint the form cannot
 * write unambiguously (a repeated DST hour) moves an hour later or earlier. Returns null when it
 * cannot be split (too short to halve).
 * @param {DeleteRequest} req The request the server rejected.
 * @returns {DeleteRequest[]|null} Two halves one level deeper, or null.
 */
function splitRequest(req) {
    if (!req.format) return null;
    const half = Math.floor((req.startMs + req.endMs) / 2);
    const mid = [half, half + HOUR_MS, half - HOUR_MS]
        .find((ms) => ms > req.startMs && ms < req.endMs && req.cuttable(ms));
    if (mid === undefined) return null;
    const window = { format: req.format, cuttable: req.cuttable };
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
    splitRequest
};
