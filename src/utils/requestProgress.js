/*
 * vim: set tw=100 et ts=4 sw=4 si fileencoding=utf-8:
 * © 2026 WideSky.Cloud Pty Ltd
 * SPDX-License-Identifier: MIT
 */
"use strict";

/**
 * Write a message with `console.log`.
 *
 * The published bundles are minified by Terser with `drop_console: true` (see
 * webpack.node.config.js / webpack.browser.config.js), which strips any
 * statically visible `console.log(...)` call. Resolving the method off an
 * aliased object with a computed key keeps the default writer working in
 * `dist/` as well as against the source tree.
 *
 * @param {String} message Message to be written.
 */
function consoleWrite(message) {
    const target = (typeof console === "undefined") ? null : console;
    const method = "log";
    if (target && typeof target[method] === "function") {
        target[method](message);
    }
}

/**
 * A single counter created by RequestProgress. Implements the subset of the
 * cli-progress SingleBar interface used by the WideSkyClient batch functions.
 */
class RequestProgressBar {
    #parent
    #name
    #total
    #value
    #payload
    #stopped
    #lastLine

    /**
     * Construct a RequestProgressBar instance. Created by RequestProgress.create(),
     * not intended to be constructed directly.
     * @param {RequestProgress} parent Owning RequestProgress instance.
     * @param {String} name Name used to identify this counter in the reported lines.
     * @param {Number} total Highest value for the counter.
     * @param {Number} value Initial value for the counter.
     * @param {Object} payload Initial payload: details the reporter's writer can show.
     */
    constructor(parent, name, total, value=0, payload={}) {
        this.#parent = parent;
        this.#name = name;
        this.#total = Number(total) || 0;
        this.#value = Number(value) || 0;
        this.#payload = { ...payload };
        this.#stopped = false;
        this.#lastLine = null;
    }

    /**
     * Name identifying this counter in the reported lines.
     * @returns {String}
     */
    get name() {
        return this.#name;
    }

    /**
     * Details passed with the latest create, update or increment, merged over earlier ones.
     * @returns {Object}
     */
    get payload() {
        return { ...this.#payload };
    }

    /**
     * Whether this counter has been stopped.
     * @returns {Boolean}
     */
    get stopped() {
        return this.#stopped;
    }

    /**
     * Get the highest value of this counter.
     * @returns {Number}
     */
    getTotal() {
        return this.#total;
    }

    /**
     * Get the fraction of this counter completed, clamped to the range 0..1.
     * A counter with a total of zero reports as complete.
     * @returns {Number}
     */
    getProgress() {
        if (this.#total <= 0) {
            return 1;
        }

        return Math.max(Math.min(this.#value / this.#total, 1), 0);
    }

    /**
     * Get the current value of this counter.
     * @returns {Number}
     */
    get value() {
        return this.#value;
    }

    /**
     * Change the highest value of this counter, reporting the new state.
     * @param {Number} total New highest value.
     */
    setTotal(total) {
        this.#total = Number(total) || 0;
        this.#report();
    }

    /**
     * Set the counter to an absolute value and report it.
     * @param {Number} value Absolute value of work completed.
     * @param {Object} [payload] Details merged into the counter's payload.
     */
    update(value, payload) {
        this.#value = Number(value) || 0;
        if (payload) {
            Object.assign(this.#payload, payload);
        }
        this.#report();
    }

    /**
     * Advance the counter by the given amount and report it.
     * @param {Number} delta Amount of work completed since the last report. Defaults to 1.
     * @param {Object} [payload] Details merged into the counter's payload.
     */
    increment(delta=1, payload) {
        this.update(this.#value + (Number(delta) || 0), payload);
    }

    /**
     * Stop this counter. Its final state is reported if it has not already
     * been reported as complete, and further updates report nothing.
     */
    stop() {
        if (this.#stopped) {
            return;
        }

        this.#stopped = true;
        if (this.getProgress() < 1) {
            this.#write(`${this.#render()} | stopped`);
        }
    }

    /**
     * Report the current state of this counter.
     */
    #report() {
        if (this.#stopped) {
            return;
        }

        const complete = this.getProgress() >= 1;
        this.#write(complete ? `${this.#render()} | done` : this.#render());
    }

    /**
     * Write a line, suppressing it if identical to the previous one written by
     * this counter, so an unchanged state is not repeated.
     * @param {String} line Line to be written.
     */
    #write(line) {
        if (line === this.#lastLine) {
            return;
        }

        this.#lastLine = line;
        this.#parent.write(line, this);
    }

    /**
     * Render the current state of this counter as a single line.
     * @returns {String}
     */
    #render() {
        const value = Math.max(Math.min(this.#value, this.#total), 0);
        const percent = Math.round(this.getProgress() * 100);
        const parts = [`[${this.#name}]`];
        if (this.#parent.showBar) {
            const width = this.#parent.barWidth;
            const filled = Math.round((percent / 100) * width);
            parts.push(`${"#".repeat(filled)}${"-".repeat(width - filled)}`);
        }

        parts.push(`${percent}%`);
        parts.push(`| ${value}/${this.#total}`);

        return parts.join(" ");
    }
}

/**
 * A progress reporter that writes one plain line per change instead of
 * drawing terminal progress bars.
 *
 * Implements the subset of the cli-progress MultiBar interface used by the
 * WideSkyClient batch functions, so it can be given per call as the batch
 * option `progress`, or client-wide as `options.client.progress.instance`:
 *
 *     const progress = new RequestProgress({ label: "hisWrite" });
 *     await client.batch.hisWrite(payload, { progress });
 *     // [hisWrite #1] 0% | 0/4
 *     // [hisWrite #1] 25% | 1/4
 *     // ...
 *     // [hisWrite #1] 100% | 4/4 | done
 *
 * The writer receives each line and the counter it describes, so a caller can
 * log the line or build its own display from the counter's value, total and
 * payload. One instance can be reused across calls: the batch functions remove
 * their counter when the operation ends.
 */
class RequestProgress {
    #options
    #bars
    #created

    /**
     * Construct a RequestProgress instance.
     * @param {Object} [options] Reporting options.
     * @param {String} [options.label] Prefix used to name each counter. Defaults to "batch".
     * @param {Function} [options.write] Function taking the line to report and the counter it
     *                                   describes. Defaults to `console.log` of the line.
     * @param {Boolean} [options.showBar] Include an ASCII bar in each line. Defaults to false.
     * @param {Number} [options.barWidth] Width of the ASCII bar, in characters. Defaults to 20.
     * @param {Boolean} [options.reportOnCreate] Report a counter when it is created, so the total
     *                                           is known before the first update. Defaults to true.
     */
    constructor(options={}) {
        this.#options = {
            label: "batch",
            write: consoleWrite,
            showBar: false,
            barWidth: 20,
            reportOnCreate: true,
            ...options
        };
        this.#bars = [];
        this.#created = 0;
    }

    /**
     * Counters created by this instance and not yet removed.
     * @returns {Array<RequestProgressBar>}
     */
    get bars() {
        return [...this.#bars];
    }

    /**
     * Whether an ASCII bar is included in each reported line.
     * @returns {Boolean}
     */
    get showBar() {
        return Boolean(this.#options.showBar);
    }

    /**
     * Width of the ASCII bar, in characters.
     * @returns {Number}
     */
    get barWidth() {
        return Number(this.#options.barWidth) || 0;
    }

    /**
     * Create a counter.
     * @param {Number} total Highest value for the counter.
     * @param {Number} value Initial value for the counter.
     * @param {Object} [payload] Initial details for the writer.
     * @returns {RequestProgressBar}
     */
    create(total, value=0, payload={}) {
        this.#created++;
        const bar = new RequestProgressBar(
            this, `${this.#options.label} #${this.#created}`, total, value, payload);
        // Reported before it is kept, so a writer that throws here leaves no counter behind.
        if (this.#options.reportOnCreate) {
            bar.update(value);
        }
        this.#bars.push(bar);

        return bar;
    }

    /**
     * Remove a counter from this instance. The counter is stopped first.
     * @param {RequestProgressBar} bar Counter to be removed.
     * @returns {Boolean} True if the counter belonged to this instance.
     */
    remove(bar) {
        const index = this.#bars.indexOf(bar);
        if (index === -1) {
            return false;
        }

        bar.stop();
        this.#bars.splice(index, 1);

        return true;
    }

    /**
     * Stop every counter created by this instance.
     */
    stop() {
        for (const bar of this.#bars) {
            bar.stop();
        }
    }

    /**
     * Write a line using the configured writer.
     * @param {String} line Line to be written.
     * @param {RequestProgressBar} [bar] Counter the line describes.
     */
    write(line, bar) {
        this.#options.write(line, bar);
    }
}

module.exports = { RequestProgress, RequestProgressBar };
