/*
 * vim: set tw=100 et ts=4 sw=4 si fileencoding=utf-8:
 * © 2026 WideSky.Cloud Pty Ltd
 * SPDX-License-Identifier: MIT
 */
"use strict";

/**
 * Pure helpers for the batch.hisDelete stack harness (hisDelete-e2e.js). Nothing here touches the
 * network, so test/utils/hisDeleteE2eHelpers.js can prove them offline.
 */

const moment = require("moment-timezone");

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
// The server rejects a hisDelete that would remove more than this per entity.
const SERVER_ROW_LIMIT = 1500;

/** Haystack tz name ("Brisbane") to IANA ("Australia/Brisbane"), by city suffix. */
function hsTzToIana(hsTz) {
    return moment.tz.zone(hsTz) ? hsTz : moment.tz.names().find((n) => n.split("/").pop() === hsTz);
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ABSOLUTE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:\d{2})$/;

/** Ranges whose meaning depends on the wall clock; only these need the midnight guard. */
function isNowDependent(range) {
    const s = range.startsWith("s:") ? range.substring(2) : range;
    return s === "today" || s === "yesterday";
}

/**
 * One range end, as the API server resolves it (widesky-api-server HZincReader + read.js ->
 * timezoneSvc.timezoneEpoch), which is NOT ISO 8601 for two cases:
 *   - a non-zero offset is applied as tzHours*60 + tzMins*60 minutes, so "+09:30" reads as +39:00;
 *   - a zero offset ("Z" / "+00:00") followed by a zone name other than UTC is not applied: the
 *     wall time is read in that named zone.
 * A datetime with no offset is read in the point's zone (`iana`).
 */
function resolveToken(rawToken, isEnd, iana, range) {
    const [token, name] = rawToken.trim().split(" ");
    if (DATE_ONLY.test(token)) {
        // Date-only: local midnight in the point's zone; an END covers that whole local day.
        const m = moment.tz(token, "YYYY-MM-DD", iana);
        return (isEnd ? m.add(1, "day") : m).valueOf();
    }
    const abs = token.match(ABSOLUTE);
    if (abs) {
        const [, wall, offset] = abs;
        const wallUtc = moment.utc(wall, moment.ISO_8601, true);
        if (!wallUtc.isValid()) throw new Error(`Unhandled range token "${token}" in "${range}"`);
        if (offset === "Z" || /^[+-]00:00$/.test(offset)) {
            if (!name || name === "UTC") return wallUtc.valueOf();
            const zone = hsTzToIana(name);
            if (!zone) throw new Error(`Unknown Haystack timezone "${name}" in "${range}"`);
            return moment.tz(wall, moment.ISO_8601, true, zone).valueOf();
        }
        const [hh, mm] = offset.slice(1).split(":").map(Number);
        const minutes = (hh * 60 + mm * 60) * (offset[0] === "-" ? -1 : 1);
        return wallUtc.valueOf() - minutes * MIN;
    }
    const local = moment.tz(token, moment.ISO_8601, true, iana);
    if (!local.isValid()) throw new Error(`Unhandled range token "${token}" in "${range}"`);
    return local.valueOf();
}

/**
 * Resolve a Haystack range string to {fromMs, toMs} (UTC epoch ms) as the server would for a
 * point in zone hsTz. nowMs is captured once by the caller; this never reads the clock.
 */
function resolveRange(range, hsTz, nowMs) {
    const iana = hsTzToIana(hsTz);
    if (!iana) throw new Error(`Unknown Haystack timezone "${hsTz}"`);
    const s = (range.startsWith("s:") ? range.substring(2) : range).trim();

    if (s === "today" || s === "yesterday") {
        const day = moment.tz(nowMs, iana);
        if (s === "yesterday") day.subtract(1, "day");
        const start = day.startOf("day");
        return { fromMs: start.valueOf(), toMs: start.clone().add(1, "day").valueOf() };
    }
    const parts = s.split(",");
    if (parts.length !== 2) throw new Error(`Unhandled range "${range}"`);
    return {
        fromMs: resolveToken(parts[0], false, iana, range),
        toMs: resolveToken(parts[1], true, iana, range),
    };
}

const every = (fromMs, count, stepMs) => Array.from({ length: count }, (_, i) => fromMs + i * stepMs);
const uniqSorted = (arr) => [...new Set(arr)].sort((a, b) => a - b);
const countIn = (data, fromMs, toMs) => data.filter((ts) => ts >= fromMs && ts <= toMs).length;

function checkBudget(data, fromMs, toMs, what) {
    const n = countIn(data, fromMs, toMs);
    if (n > SERVER_ROW_LIMIT) throw new Error(`${what}: ${n} in-range rows exceeds ${SERVER_ROW_LIMIT}`);
    return data;
}

/** Regular shapes for an absolute [startMs, endMs] range: 12 targets, all with edge rows. */
function shapesRegular(startMs, endMs) {
    const edges = [startMs - 1, startMs, endMs, endMs + 1];
    const shapes = {
        a_minute_1d: [...every(startMs, 1440, MIN), ...edges],
        b_sparse_gap: [...every(startMs, 12, HOUR), ...every(endMs - 12 * HOUR, 12, HOUR), ...edges],
        c_burst: [...every(startMs + 5 * HOUR, 1200, 250), ...edges],
    };
    for (let i = 0; i < 9; i++) shapes[`uniform_${i}`] = [...every(startMs, 72, HOUR), ...edges];
    const out = {};
    for (const [name, data] of Object.entries(shapes)) {
        out[name] = checkBudget(uniqSorted(data), startMs, endMs, name);
    }
    return out;
}

/** Tz-less scenario data for one point, built from its OWN zone's local range 06-01..06-04. */
function buildTzlessData(hsTz) {
    const iana = hsTzToIana(hsTz);
    const localStart = moment.tz("2026-06-01", "YYYY-MM-DD", iana).valueOf();
    const localEnd = moment.tz("2026-06-04", "YYYY-MM-DD", iana).valueOf();
    const burst1 = every(localStart, 600, 250);                 // first local hour
    const burst2 = every(localEnd - 600 * 250, 600, 250);       // last local hour, ends before localEnd
    const bgFrom = localStart + HOUR, bgTo = localEnd - HOUR;
    const step = Math.floor((bgTo - bgFrom) / 251);
    const background = every(bgFrom + step, 250, step);         // strictly inside (start+1h, end-1h)
    const edges = [localStart - 1, localStart, localEnd, localEnd + 1];
    return checkBudget(uniqSorted([...burst1, ...burst2, ...background, ...edges]),
        localStart, localEnd, `tz-less ${hsTz}`);
}

/** Yesterday scenario data for a point in hsTz, from a nowMs captured at scenario start. */
function buildYesterdayData(hsTz, nowMs) {
    const { fromMs: start, toMs: end } = resolveRange("yesterday", hsTz, nowMs);
    const before = [start - DAY + 3 * HOUR, start - DAY + 9 * HOUR, start - HOUR];
    const after = [end + HOUR, end + DAY - 3 * HOUR, end + DAY + 3 * HOUR];
    const edges = [start - 1, start, end, end + 1];
    return checkBudget(uniqSorted([...every(start, 1440, MIN), ...edges, ...before, ...after]),
        start, end, `yesterday ${hsTz}`);
}

/** Ids in a recorded /api/hisDelete body: id / idN keys of rows[0], "r:" and " dis" stripped. */
function idsOfBody(body) {
    const row = (body && body.rows && body.rows[0]) || {};
    return Object.keys(row).filter((k) => /^id\d*$/.test(k))
        .map((k) => row[k].substring(2).split(" ")[0]);
}

/**
 * For each recorded delete request body: its range, its ids, and the pre-delete SNAPSHOT rows
 * inside that range summed over those ids (each id's range resolved in its own zone). An id
 * absent from snapshots or tzOf throws.
 */
function rowsPerRequest(bodies, snapshots, tzOf, nowMs) {
    return bodies.map((body) => {
        const row = (body && body.rows && body.rows[0]) || {};
        const ids = idsOfBody(body);
        let rows = 0;
        for (const id of ids) {
            if (!snapshots[id] || !tzOf[id]) throw new Error(`delete request names unknown id ${id}`);
            const { fromMs, toMs } = resolveRange(row.range, tzOf[id], nowMs);
            rows += countIn(snapshots[id], fromMs, toMs);
        }
        return { range: row.range, ids, rows };
    });
}

module.exports = {
    MIN, HOUR, DAY, SERVER_ROW_LIMIT, hsTzToIana, isNowDependent, resolveRange, every, uniqSorted,
    countIn, shapesRegular, buildTzlessData, buildYesterdayData, idsOfBody, rowsPerRequest,
};
