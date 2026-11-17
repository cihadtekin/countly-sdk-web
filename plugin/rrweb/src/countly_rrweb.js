// Countly Session Replay: the rrweb recorder. Include this file next to countly.js and
// countly_recording.js, and choose the "rrweb" recorder (init option recording.recorder or
// the dashboard setting). rrweb is bundled inside: there is no window.rrweb, and nothing of
// its API is exposed, so a page that runs its own rrweb is not affected.
//
// The recording stays visual-only: everything rrweb records passes through filter() before
// it is buffered. What Countly analyses (clicks, inputs, views) comes from the SDK's own
// events, never from this recording.
import { record } from "@rrweb/record";

var VERSION = "2.2.2";

// rrweb event types
var CUSTOM = 5;
var PLUGIN = 6;
var META = 4;

/**
 * @param {string} href - page address
 * @returns {string} the address without its query and fragment
 */
function stripUrl(href) {
    return String(href || "").split(/[?#]/)[0];
}

/**
 * Keep the recording visual-only (session-replays PLAN.md 10.2).
 * @param {Object} event - rrweb event
 * @returns {Object|null} the event to keep, or null to drop it
 */
function filter(event) {
    if (event.type === CUSTOM || event.type === PLUGIN) {
        return null;
    }
    if (event.type === META && event.data) {
        event.data.href = stripUrl(event.data.href);
    }
    return event;
}

/**
 * The rrweb recorder adapter for the Countly recording module.
 * @param {Object} options - {privacy: {maskAllText}}
 * @returns {Object} adapter: start, keyframe, stop, nodeId, packChunk
 */
function createRrwebRecorder(options) {
    var privacy = (options && options.privacy) || {};
    var stopRecording = null;

    return {
        name: "rrweb",
        version: VERSION,
        format: "rrweb/2",

        /**
         * @param {Object} sink - {keyframe(t, event), delta(t, event)}; a Meta event starts a chunk
         */
        start: function(sink) {
            stopRecording = record({
                emit: function(event) {
                    var kept = filter(event);
                    if (!kept) {
                        return;
                    }
                    if (kept.type === META) {
                        sink.keyframe(kept.timestamp, kept);
                    }
                    else {
                        sink.delta(kept.timestamp, kept);
                    }
                },
                maskAllInputs: true,
                blockClass: "cly-block",
                maskTextClass: "cly-mask",
                maskTextSelector: privacy.maskAllText ? "*" : null,
                ignoreClass: "cly-ignore",
                recordCanvas: false,
                inlineStylesheet: true,
                collectFonts: false,
                plugins: []
            });
        },

        /** A full snapshot now: rrweb emits Meta (a new chunk) then FullSnapshot. */
        keyframe: function() {
            record.takeFullSnapshot(true);
        },

        stop: function() {
            if (stopRecording) {
                stopRecording();
                stopRecording = null;
            }
        },

        /**
         * @param {Element} el - element
         * @returns {number|undefined} rrweb's node id, which the player resolves with its mirror
         */
        nodeId: function(el) {
            var id = record.mirror.getId(el);
            return id > 0 ? id : undefined;
        },

        /**
         * @param {Array} events - the chunk's rrweb events, Meta + FullSnapshot first
         * @returns {Object} chunk data
         */
        packChunk: function(events) {
            return { events: events };
        }
    };
}

// Registers with the recording module, whether it loaded before or after this file.
(window.__countlyRecorders = window.__countlyRecorders || []).push(["rrweb", createRrwebRecorder]);
