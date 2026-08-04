"use strict";

/* global rrweb, Promise, Uint8Array */
/*
Countly Session Replay plugin (rrweb based).

Records the page DOM + interactions with rrweb entirely on the device, keeps a
rolling in-memory window of the most recent activity (30s by default), and ships
that window to the Countly server only when the integration asks for it.

Usage (opt-in — load rrweb, then this file, alongside countly.js):

    <script src="countly.js"></script>
    <script src="plugin/session-replay/rrweb.min.js"></script>
    <script src="plugin/session-replay/countly_session_replay.js"></script>

    Countly.init({ app_key: "...", url: "..." });
    Countly.startSessionRecording();          // start capturing (rolling window)
    // ...later, on a crash / rage-click / manual trigger...
    Countly.sendSessionRecording();           // ship the current window
    Countly.stopSessionRecording();           // stop + clear the buffer

Or via the async queue:

    Countly.q.push(["startSessionRecording", { rollingWindowMs: 60000 }]);

Privacy is applied at capture time (before anything is buffered):
  - all inputs/text masked by default (no raw values / passwords leave the page),
  - [data-countly-mask]  → layout kept, text content replaced,
  - [data-countly-block] → element stored as an opaque placeholder,
  - [data-countly-ignore]→ interactions inside are not recorded,
  - video / iframe / canvas are blocked,
  - query strings / hashes are stripped from captured URLs (tokens never stored).
*/
(function cly_session_replay() {
    if (typeof window === "undefined") {
        return; // needs a DOM; cannot run in web workers
    }
    var Countly = window.Countly || {};
    Countly.onload = Countly.onload || [];

    // Wait for the core SDK to define CountlyClass, then attach + expose.
    if (typeof Countly.CountlyClass === "undefined") {
        return Countly.onload.push(function() {
            cly_session_replay();
            // Re-expose on the global namespace in case this plugin loaded AFTER
            // Countly.init() already copied the instance methods onto Countly.
            if (Countly.i && Countly.app_key && Countly.i[Countly.app_key]) {
                var inst = Countly.i[Countly.app_key];
                Countly.startSessionRecording = inst.startSessionRecording;
                Countly.sendSessionRecording = inst.sendSessionRecording;
                Countly.stopSessionRecording = inst.stopSessionRecording;
                Countly.isSessionRecording = inst.isSessionRecording;
            }
        });
    }

    var SESSION_REPLAY_FEATURE = "session-replay";
    var RRWEB_VERSION = "2.1.1";

    // rrweb EventType numeric values (avoid depending on the enum being exported
    // on the UMD global): FullSnapshot = 2, Meta = 4.
    var RRWEB_FULL_SNAPSHOT = 2;
    var RRWEB_META = 4;

    var DEFAULTS = {
        // Rolling window length in ms. Configurable per call and the only thing
        // most integrations will tune.
        rollingWindowMs: 30000,
        // Hard safety cap so a runaway page cannot grow the buffer without bound.
        maxEvents: 10000,
        // rrweb capture options (privacy-first defaults).
        maskAllInputs: true,
        blockSelector: "[data-countly-block], video, iframe, canvas",
        maskTextSelector: "[data-countly-mask]",
        ignoreSelector: "[data-countly-ignore]",
        sampling: { mousemove: 50 },
        // Automatically ship the current rolling window when a crash/error is
        // recorded (no explicit sendSessionRecording call needed). The recording
        // and the crash are tagged with the same correlation id so they can be
        // matched later. On by default.
        autoSendOnCrash: true
    };

    // Recorder state is keyed by app_key at module scope (not stored on `this`)
    // so it stays consistent whether methods are called on the instance
    // (Countly.i[key].x()) or on the copied global namespace (Countly.x()).
    var recorders = {};

    /* ─────────────────────────── helpers ─────────────────────────── */

    /**
     *  Shallow-merge source over a copy of defaults (ES5, no spread).
     *  @param {Object} defaults - default option values
     *  @param {Object} source - user provided overrides
     *  @returns {Object} merged options object
     */
    function mergeOptions(defaults, source) {
        var out = {};
        var k;
        for (k in defaults) {
            if (Object.prototype.hasOwnProperty.call(defaults, k)) {
                out[k] = defaults[k];
            }
        }
        if (source) {
            for (k in source) {
                if (Object.prototype.hasOwnProperty.call(source, k) && typeof source[k] !== "undefined") {
                    out[k] = source[k];
                }
            }
        }
        return out;
    }

    /**
     *  Strip query string + hash from a URL so tokens never reach storage.
     *  @param {String} url - URL to sanitize
     *  @returns {String} URL without query/hash
     */
    function sanitizeUrl(url) {
        try {
            var u = new URL(url, window.location.origin);
            return u.origin + u.pathname;
        }
        catch (e) {
            return String(url).split("?")[0].split("#")[0];
        }
    }

    /**
     *  Remove query params from Meta events (page navigations) before buffering.
     *  @param {Object} event - rrweb event
     *  @returns {Object} sanitized event (shallow clone when modified)
     */
    function sanitizeEvent(event) {
        if (event && event.type === RRWEB_META && event.data && typeof event.data.href === "string") {
            var data = {};
            var k;
            for (k in event.data) {
                if (Object.prototype.hasOwnProperty.call(event.data, k)) {
                    data[k] = event.data[k];
                }
            }
            data.href = sanitizeUrl(data.href);
            var clone = {};
            for (k in event) {
                if (Object.prototype.hasOwnProperty.call(event, k)) {
                    clone[k] = event[k];
                }
            }
            clone.data = data;
            return clone;
        }
        return event;
    }

    /**
     *  Distinct page URLs seen during the session (from Meta events).
     *  @param {Array} events - rrweb events
     *  @returns {Array} distinct hrefs
     */
    function collectPages(events) {
        var seen = {};
        var pages = [];
        for (var i = 0; i < events.length; i++) {
            var e = events[i];
            if (e.type === RRWEB_META && e.data && typeof e.data.href === "string") {
                if (!seen[e.data.href]) {
                    seen[e.data.href] = true;
                    pages.push(e.data.href);
                }
            }
        }
        return pages;
    }

    /**
     *  Trim the buffer to the rolling window: keep the most recent full snapshot
     *  at/before the cutoff (so replay can reconstruct the DOM) plus everything
     *  after it; Meta events are always kept so navigation context survives.
     *  @param {Object} state - recorder state
     *  @param {Number} now - current ms timestamp
     *  @returns {void}
     */
    function trimRollingBuffer(state, now) {
        var windowMs = state.config.rollingWindowMs;
        if (!windowMs) {
            return;
        }
        var cutoff = now - windowMs;
        var events = state.buffer;
        var firstSnapshot = 0;
        for (var i = events.length - 1; i >= 0; i--) {
            if (events[i].type === RRWEB_FULL_SNAPSHOT && events[i].timestamp <= cutoff) {
                firstSnapshot = i;
                break;
            }
        }
        var kept = [];
        for (var j = firstSnapshot; j < events.length; j++) {
            var ev = events[j];
            if (j === firstSnapshot || ev.timestamp >= cutoff || ev.type === RRWEB_META) {
                kept.push(ev);
            }
        }
        // Safety backstop against unbounded growth.
        if (kept.length > state.config.maxEvents) {
            kept = kept.slice(kept.length - state.config.maxEvents);
        }
        state.buffer = kept;
    }

    /* ───────────────────────── gzip packing ───────────────────────── */

    /**
     *  Base64-encode a byte array in chunks (avoids call-stack limits).
     *  @param {Uint8Array} bytes - bytes to encode
     *  @returns {String} base64 string
     */
    function bytesToBase64(bytes) {
        var binary = "";
        var chunk = 0x8000;
        for (var i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    /**
     *  Serialize a value to JSON and gzip+base64 it when CompressionStream is
     *  available, falling back to plain base64 otherwise.
     *  @param {*} value - value to pack
     *  @returns {Promise} resolves with {data, compressed, rawBytes}
     */
    function packToBase64(value) {
        var json = JSON.stringify(value);
        var raw = new TextEncoder().encode(json);
        var hasCompressionStream = typeof CompressionStream === "function";
        if (!hasCompressionStream) {
            return Promise.resolve({ data: bytesToBase64(raw), compressed: false, rawBytes: raw.length });
        }
        try {
            // Copy into a fresh (non-shared) ArrayBuffer — the DOM stream APIs
            // reject SharedArrayBuffer-backed views.
            var copy = new Uint8Array(raw.length);
            copy.set(raw);
            var transform = new CompressionStream("gzip");
            var stream = new Blob([copy]).stream().pipeThrough(transform);
            return new Response(stream).arrayBuffer().then(function(buffer) {
                return { data: bytesToBase64(new Uint8Array(buffer)), compressed: true, rawBytes: raw.length };
            }).catch(function() {
                return { data: bytesToBase64(raw), compressed: false, rawBytes: raw.length };
            });
        }
        catch (e) {
            return Promise.resolve({ data: bytesToBase64(raw), compressed: false, rawBytes: raw.length });
        }
    }

    /* ─────────────────────── delivery + crash hook ─────────────────────── */

    /**
     *  Package the current rolling window and enqueue it for delivery. Shared by
     *  the manual sendSessionRecording() and the automatic on-crash flush.
     *  @param {Object} self - the Countly instance/namespace
     *  @param {Object} state - recorder state for this app_key
     *  @param {String} trigger - "manual" or "crash"
     *  @param {String=} crashId - correlation id when triggered by a crash
     *  @returns {void}
     */
    function flushRecording(self, state, trigger, crashId) {
        var log = self._internals.log;
        if (!state || !state.buffer.length) {
            log("[WARNING]", "sendSessionRecording, nothing recorded yet.");
            return;
        }
        var events = state.buffer.slice();
        if (events.length < 2) {
            log("[WARNING]", "sendSessionRecording, recording too short to send.");
            return;
        }
        packToBase64(events).then(function(packed) {
            var payload = {
                rrweb_version: RRWEB_VERSION,
                recorded_at: self._internals.getMsTimestamp(),
                window_ms: state.config.rollingWindowMs,
                compressed: packed.compressed,
                data: packed.data,
                // Searchable metadata so the server needn't decompress to list.
                event_count: events.length,
                duration_ms: events[events.length - 1].timestamp - events[0].timestamp,
                pages: collectPages(events),
                raw_bytes: packed.rawBytes,
                trigger: trigger || "manual"
            };
            if (crashId) {
                payload.crash_id = crashId;
            }
            self._internals.toRequestQueue({ session_recording: JSON.stringify(payload) });
            log("[INFO]", "sendSessionRecording, queued " + events.length + " events (" + (packed.compressed ? "gzip" : "raw") + ", trigger " + payload.trigger + ").");
        });
    }

    /**
     *  Build a correlation id shared by a crash and its auto-sent recording.
     *  @param {Object} self - the Countly instance
     *  @returns {String} correlation id
     */
    function newCrashCorrelationId(self) {
        try {
            if (self._internals && typeof self._internals.generateUUID === "function") {
                return "srcr_" + self._internals.generateUUID();
            }
        }
        catch (e) {
            // fall through to timestamp-based id
        }
        return "srcr_" + String(self._internals.getMsTimestamp());
    }

    /**
     *  Wrap the instance's recordError so any crash/error auto-flushes the
     *  current rolling window, tagging both the crash (custom segment
     *  `cly_sr_crash_id`) and the recording (`crash_id`) with one id so they can
     *  be matched. Automatic crashes call Countly.i[app_key].recordError, so we
     *  wrap that; the copied namespace method is patched too when it matches.
     *  @param {Object} self - the Countly instance/namespace
     *  @param {Object} state - recorder state for this app_key
     *  @returns {void}
     */
    function installCrashHook(self, state) {
        if (state.crashHookInstalled) {
            return;
        }
        var inst = (typeof Countly !== "undefined" && Countly.i && Countly.i[self.app_key]) ? Countly.i[self.app_key] : self;
        var original = inst.recordError;
        if (typeof original !== "function") {
            self._internals.log("[WARNING]", "startSessionRecording, autoSendOnCrash on but recordError is unavailable; crash auto-send disabled.");
            return;
        }
        var wrapper = function(err, nonfatal, segments) {
            var crashId = newCrashCorrelationId(self);
            var seg = segments || {};
            try {
                seg.cly_sr_crash_id = crashId;
            }
            catch (e) {
                // segments may be frozen — skip tagging the crash, still flush
            }
            var ret = original.call(this, err, nonfatal, seg);
            try {
                var current = recorders[self.app_key];
                if (current && current.recording) {
                    flushRecording(self, current, "crash", crashId);
                }
            }
            catch (e2) {
                // never let replay flushing interfere with crash reporting
            }
            return ret;
        };
        inst.recordError = wrapper;
        if (typeof Countly !== "undefined" && Countly.recordError === original) {
            Countly.recordError = wrapper;
        }
        state.crashHookInstalled = true;
        state.crashHookInstance = inst;
        state.crashHookOriginal = original;
        state.crashHookWrapper = wrapper;
    }

    /**
     *  Restore the original recordError wrapped by {@link installCrashHook}.
     *  @param {Object} state - recorder state for this app_key
     *  @returns {void}
     */
    function removeCrashHook(state) {
        if (!state.crashHookInstalled) {
            return;
        }
        var inst = state.crashHookInstance;
        if (inst && inst.recordError === state.crashHookWrapper) {
            inst.recordError = state.crashHookOriginal;
        }
        if (typeof Countly !== "undefined" && Countly.recordError === state.crashHookWrapper) {
            Countly.recordError = state.crashHookOriginal;
        }
        state.crashHookInstalled = false;
        state.crashHookInstance = null;
        state.crashHookOriginal = null;
        state.crashHookWrapper = null;
    }

    /* ─────────────────────── public API ─────────────────────── */

    /**
     *  Start recording the page with rrweb and keep a rolling in-memory window.
     *  Idempotent — a no-op if recording is already running.
     *  @memberof Countly
     *  @param {Object=} options - overrides for DEFAULTS (e.g. {rollingWindowMs})
     *  @returns {void}
     */
    Countly.CountlyClass.prototype.startSessionRecording = function(options) {
        var self = this;
        var log = self._internals.log;

        if (typeof rrweb === "undefined" || !rrweb || typeof rrweb.record !== "function") {
            log("[ERROR]", "startSessionRecording, rrweb is not loaded. Include plugin/session-replay/rrweb.min.js before this plugin.");
            return;
        }
        if (!self.check_consent(SESSION_REPLAY_FEATURE)) {
            log("[WARNING]", "startSessionRecording, no consent for session-replay, not recording.");
            return;
        }

        var appKey = self.app_key;
        var state = recorders[appKey];
        if (state && state.recording) {
            log("[WARNING]", "startSessionRecording, already recording, ignoring.");
            return;
        }

        var config = mergeOptions(DEFAULTS, options);
        state = {
            recording: true,
            config: config,
            buffer: [],
            stopFn: null
        };
        recorders[appKey] = state;

        var stop = rrweb.record({
            emit: function(event) {
                var sanitized = sanitizeEvent(event);
                state.buffer.push(sanitized);
                trimRollingBuffer(state, self._internals.getMsTimestamp());
            },
            maskAllInputs: config.maskAllInputs,
            maskTextSelector: config.maskTextSelector,
            blockSelector: config.blockSelector,
            ignoreSelector: config.ignoreSelector,
            recordCanvas: false,
            // Inline styles so the replay renders correctly in the isolated player.
            inlineStylesheet: true,
            sampling: config.sampling,
            // Checkpoint a fresh full snapshot periodically so the rolling buffer
            // always has a snapshot to reconstruct from.
            checkoutEveryNms: Math.min(config.rollingWindowMs, 30000)
        });

        state.stopFn = stop || null;

        if (config.autoSendOnCrash) {
            installCrashHook(self, state);
        }

        log("[INFO]", "startSessionRecording, recording started, rolling window " + config.rollingWindowMs + "ms" + (config.autoSendOnCrash ? ", auto-send on crash" : "") + ".");
    };

    /**
     *  Package the current rolling window and enqueue it for delivery to the
     *  server. Does NOT stop recording.
     *  @memberof Countly
     *  @returns {void}
     */
    Countly.CountlyClass.prototype.sendSessionRecording = function() {
        var self = this;

        if (!self.check_consent(SESSION_REPLAY_FEATURE)) {
            self._internals.log("[WARNING]", "sendSessionRecording, no consent for session-replay, not sending.");
            return;
        }

        flushRecording(self, recorders[self.app_key], "manual", null);
    };

    /**
     *  Stop recording and clear the buffer.
     *  @memberof Countly
     *  @returns {void}
     */
    Countly.CountlyClass.prototype.stopSessionRecording = function() {
        var self = this;
        var log = self._internals.log;
        var state = recorders[self.app_key];
        if (!state || !state.recording) {
            log("[WARNING]", "stopSessionRecording, not recording.");
            return;
        }
        if (typeof state.stopFn === "function") {
            try {
                state.stopFn();
            }
            catch (e) {
                log("[ERROR]", "stopSessionRecording, error stopping rrweb: " + e);
            }
        }
        removeCrashHook(state);
        state.recording = false;
        state.stopFn = null;
        state.buffer = [];
        log("[INFO]", "stopSessionRecording, recording stopped.");
    };

    /**
     *  Whether a recording is currently running for this instance.
     *  @memberof Countly
     *  @returns {Boolean} true if recording
     */
    Countly.CountlyClass.prototype.isSessionRecording = function() {
        var state = recorders[this.app_key];
        return !!(state && state.recording);
    };
}());
