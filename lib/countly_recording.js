/** **********
* Countly Web SDK, Session Replay recording module
* https://github.com/Countly/countly-sdk-web
* Load it after countly.js and before Countly.init, so the page's first requests carry its recording stream.
*********** */
var CountlyRecording = (function (exports) {
    'use strict';

    function _typeof(o) {
        "@babel/helpers - typeof";

        return _typeof = "function" == typeof Symbol && "symbol" == typeof Symbol.iterator ? function (o) {
            return typeof o;
        } : function (o) {
            return o && "function" == typeof Symbol && o.constructor === Symbol && o !== Symbol.prototype ? "symbol" : typeof o;
        }, _typeof(o);
    }

    // cly-wire/1 recorder: draws the page as a scene of boxes, colours and (masked) text,
    // not as a copy of its DOM. Based on the Echo experiment's scene model: every frame is
    // a diff of the visible scene against the previous one; a keyframe is the full scene.
    //
    // Chunk data (one per chunk, see packChunk):
    //   { styles: [style...], frames: [[t, full, docW, docH, upserts, removes]] }
    //   upsert = [id, parent, kind, x, y, w, h, style, text, flags]
    //     kind:  0 surface, 1 text, 2 button, 3 field, 4 image, 5 media, 6 blocked, 7 frame
    //     x, y:  page coordinates (fixed elements: viewport coordinates, flag 1)
    //     style: index into styles: [background, color, border, radius, fontSize, fontWeight, fontFamily, textAlign, opacity, shadow]
    //     text:  visible text, masked on the device when the privacy rules say so (null when none)
    //     flags: 1 fixed, 2 text masked, 4 field (value never recorded), 8 checked
    // The format's renderer is in the Countly dashboard (session-replays plugin).

    var VERSION$2 = "0.1.0";
    var MAX_NODES = 1500;
    var MAX_TEXT = 300;
    // How far beyond the viewport the scene reaches, in viewports: enough to scroll without gaps.
    var BAND = 1.5;
    var KIND = {
        SURFACE: 0,
        TEXT: 1,
        BUTTON: 2,
        FIELD: 3,
        IMAGE: 4,
        MEDIA: 5,
        BLOCKED: 6,
        FRAME: 7
    };
    var FLAG = {
        FIXED: 1,
        MASKED: 2,
        FIELD: 4,
        CHECKED: 8
    };
    var TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

    /**
     * @param {string} text - text to mask
     * @returns {string} same length, letters and digits replaced
     */
    function maskText(text) {
        return text.replace(/[^\s]/g, "*");
    }

    /**
     * The element's own text: its direct text nodes, collapsed.
     * @param {Element} el - element
     * @returns {string} text, or ""
     */
    function ownText(el) {
        var text = "";
        for (var child = el.firstChild; child; child = child.nextSibling) {
            if (child.nodeType === 3) {
                text += child.nodeValue;
            }
        }
        return text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
    }

    /**
     * @param {Element} el - element
     * @returns {number} the scene kind
     */
    function kindOf(el) {
        var tag = el.tagName;
        if (tag === "BUTTON" || tag === "INPUT" && /^(button|submit|reset)$/i.test(el.type) || el.getAttribute("role") === "button") {
            return KIND.BUTTON;
        }
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) {
            return KIND.FIELD;
        }
        if (tag === "IMG" || tag === "PICTURE" || tag === "SVG" || tag === "svg") {
            return KIND.IMAGE;
        }
        if (tag === "VIDEO" || tag === "CANVAS" || tag === "AUDIO") {
            return KIND.MEDIA;
        }
        if (tag === "IFRAME") {
            return KIND.FRAME;
        }
        return KIND.SURFACE;
    }

    /**
     * Creates a cly-wire recorder for one document.
     * @param {Object} options - {privacy: {maskAllText, maskAllInputs}, clock}
     * @returns {Object} recorder adapter: start, stop, keyframe, nodeId, packChunk
     */
    function createWireRecorder(options) {
        var privacy = options && options.privacy || {};
        var clock = options && options.clock || Date.now;
        var ids = new WeakMap();
        var nextId = 1;
        var previous = new Map();
        var sink = null;
        var observer = null;
        var pending = null;
        var running = false;
        var listeners = [];

        /**
         * @param {Element} el - element
         * @returns {number} its stable scene id
         */
        function idOf(el) {
            var id = ids.get(el);
            if (!id) {
                id = nextId++;
                ids.set(el, id);
            }
            return id;
        }

        /**
         * Read the visible scene: significant elements in the viewport band, in DOM (paint) order.
         * @returns {Map} id -> upsert tuple without the style index resolved (style is a string key)
         */
        function readScene() {
            var scene = new Map();
            var scrollX = window.scrollX || 0;
            var scrollY = window.scrollY || 0;
            var vh = window.innerHeight;
            var top = -vh * BAND;
            var bottom = vh * (1 + BAND);
            var maskAll = !!privacy.maskAllText;
            var count = 0;

            /**
             * @param {Element} el - element to visit
             * @param {number} parentId - nearest recorded ancestor
             * @param {boolean} masked - inside cly-mask (or all text masked)
             * @param {boolean} fixedAncestor - inside a fixed element
             */
            function visit(el, parentId, masked, fixedAncestor) {
                if (count >= MAX_NODES || el.nodeType !== 1) {
                    return;
                }
                var tag = el.tagName;
                if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT" || tag === "TEMPLATE" || tag === "HEAD" || tag === "META" || tag === "LINK") {
                    return;
                }
                var style = window.getComputedStyle(el);
                if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
                    return;
                }
                var rect = el.getBoundingClientRect();
                var isFixed = fixedAncestor || style.position === "fixed";
                var classList = el.classList;
                var blocked = classList && classList.contains("cly-block");
                var nowMasked = masked || classList && classList.contains("cly-mask");
                var inBand = rect.bottom >= top && rect.top <= bottom && rect.width > 0 && rect.height > 0;
                var kind = blocked ? KIND.BLOCKED : kindOf(el);
                var text = kind === KIND.FIELD || blocked ? "" : ownText(el);
                // an input button's label is its value, which the page sets, not the user
                if (kind === KIND.BUTTON && el.tagName === "INPUT" && !text) {
                    text = String(el.value || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
                }
                var hasPaint = !TRANSPARENT.test(style.backgroundColor) || style.borderTopWidth !== "0px" || style.boxShadow !== "none" || style.backgroundImage !== "none";
                var significant = inBand && (kind !== KIND.SURFACE || hasPaint || text);
                var id = parentId;
                if (significant) {
                    id = idOf(el);
                    var flags = 0;
                    if (isFixed) {
                        flags |= FLAG.FIXED;
                    }
                    var shown = null;
                    if (text) {
                        shown = nowMasked ? maskText(text) : text;
                        if (nowMasked) {
                            flags |= FLAG.MASKED;
                        }
                    }
                    if (kind === KIND.FIELD) {
                        flags |= FLAG.FIELD;
                        // the value is never recorded; a placeholder is the page's text, not the user's
                        if (el.placeholder && !el.value) {
                            shown = nowMasked ? maskText(el.placeholder) : el.placeholder.slice(0, MAX_TEXT);
                        } else if (el.value && el.type !== "checkbox" && el.type !== "radio") {
                            // only the length of what was typed
                            shown = maskText(String(el.value).slice(0, MAX_TEXT));
                        }
                        if ((el.type === "checkbox" || el.type === "radio") && el.checked) {
                            flags |= FLAG.CHECKED;
                        }
                    }
                    var styleKey = [style.backgroundColor, style.color, style.borderTopWidth !== "0px" ? style.borderTopWidth + " " + style.borderTopStyle + " " + style.borderTopColor : "", style.borderTopLeftRadius, style.fontSize, style.fontWeight, style.fontFamily.split(",")[0], style.textAlign, style.opacity, style.boxShadow === "none" ? "" : "1"];
                    scene.set(id, [id, parentId, kind, Math.round(rect.left + (isFixed ? 0 : scrollX)), Math.round(rect.top + (isFixed ? 0 : scrollY)), Math.round(rect.width), Math.round(rect.height), styleKey, shown, flags]);
                    count++;
                }
                if (blocked || kind === KIND.FIELD || kind === KIND.IMAGE || kind === KIND.MEDIA || kind === KIND.FRAME) {
                    return;
                }
                // elements far outside the band can still have visible (e.g. fixed) children
                for (var child = el.firstElementChild; child; child = child.nextElementSibling) {
                    visit(child, id, nowMasked || maskAll, isFixed);
                }
            }
            if (document.body) {
                visit(document.body, 0, maskAll, false);
            }
            return scene;
        }

        /**
         * Capture now and hand the frame to the sink.
         * @param {boolean} full - a keyframe (the whole scene) rather than a diff
         */
        function capture(full) {
            if (!running || !sink) {
                return;
            }
            var started = clock();
            var scene = readScene();
            var upserts = [];
            var removes = [];
            scene.forEach(function (node, id) {
                var before = previous.get(id);
                if (full || !before || JSON.stringify(before) !== JSON.stringify(node)) {
                    upserts.push(node);
                }
            });
            if (!full) {
                previous.forEach(function (_node, id) {
                    if (!scene.has(id)) {
                        removes.push(id);
                    }
                });
            }
            previous = scene;
            if (!full && !upserts.length && !removes.length) {
                return;
            }
            var frame = {
                t: started,
                full: full,
                docW: Math.max(document.documentElement.scrollWidth, window.innerWidth),
                docH: Math.max(document.documentElement.scrollHeight, window.innerHeight),
                upserts: upserts,
                removes: removes,
                captureMs: clock() - started
            };
            if (full) {
                sink.keyframe(started, frame);
            } else {
                sink.delta(started, frame);
            }
        }

        /** Coalesce bursts of changes into one capture. */
        function schedule() {
            if (pending || !running) {
                return;
            }
            pending = setTimeout(function () {
                pending = null;
                capture(false);
            }, 200);
        }

        /**
         * @param {Object} target - event target
         * @param {string} type - event
         * @param {function} fn - listener
         */
        function listen(target, type, fn) {
            target.addEventListener(type, fn, true);
            listeners.push([target, type, fn]);
        }
        return {
            name: "countly-wire",
            version: VERSION$2,
            format: "cly-wire/1",
            /**
             * Begin observing; frames go to sink.keyframe / sink.delta.
             * @param {Object} frameSink - {keyframe(t, frame), delta(t, frame)}
             */
            start: function start(frameSink) {
                sink = frameSink;
                running = true;
                previous = new Map();
                if (typeof MutationObserver !== "undefined") {
                    observer = new MutationObserver(schedule);
                    observer.observe(document.documentElement, {
                        childList: true,
                        subtree: true,
                        attributes: true,
                        characterData: true
                    });
                }
                listen(window, "scroll", schedule);
                listen(window, "resize", schedule);
                listen(document, "input", schedule);
                listen(document, "change", schedule);
                listen(document, "transitionend", schedule);
                capture(true);
            },
            /** A full snapshot now: the start of a new chunk. */
            keyframe: function keyframe() {
                capture(true);
            },
            stop: function stop() {
                running = false;
                if (observer) {
                    observer.disconnect();
                    observer = null;
                }
                clearTimeout(pending);
                pending = null;
                listeners.forEach(function (l) {
                    l[0].removeEventListener(l[1], l[2], true);
                });
                listeners = [];
            },
            /**
             * The scene id of an element (or of its nearest recorded ancestor), for sg.nid on events.
             * @param {Element} el - element
             * @returns {number|undefined} id
             */
            nodeId: function nodeId(el) {
                for (var node = el; node && node.nodeType === 1; node = node.parentElement) {
                    var id = ids.get(node);
                    if (id && previous.has(id)) {
                        return id;
                    }
                }
                return undefined;
            },
            /**
             * One chunk's data from its keyframe and deltas, with the styles deduplicated into a table.
             * @param {Array} frames - frames the sink collected for the chunk, keyframe first
             * @returns {Object} {styles, frames}
             */
            packChunk: function packChunk(frames) {
                var styles = [];
                var index = new Map();
                var styleIndex = function styleIndex(key) {
                    var k = JSON.stringify(key);
                    if (!index.has(k)) {
                        index.set(k, styles.length);
                        styles.push(key);
                    }
                    return index.get(k);
                };
                return {
                    styles: styles,
                    frames: frames.map(function (f) {
                        return [f.t, f.full ? 1 : 0, f.docW, f.docH, f.upserts.map(function (n) {
                            return [n[0], n[1], n[2], n[3], n[4], n[5], n[6], styleIndex(n[7]), n[8], n[9]];
                        }), f.removes];
                    }),
                    captureMs: frames.reduce(function (sum, f) {
                        return sum + (f.captureMs || 0);
                    }, 0)
                };
            }
        };
    }

    // One capture of the page, cut into chunks (PLAN.md 6.1, 8.2): every chunk starts with a
    // keyframe, so it can be replayed on its own. The recorder adapter serializes the screen;
    // this file owns the chunk timer and the format-independent overlay tracks.

    var POINTER_INTERVAL = 50;
    var SCROLL_INTERVAL = 100;

    /**
     * @param {Object} options - {recorder, keyframeInterval (s), clock, onChunk(chunk), screen}
     * @returns {Object} capture: start, stop, seal, isRunning, lastActivity
     */
    function createCapture(options) {
        var recorder = options.recorder;
        var clock = options.clock || Date.now;
        var interval = Math.max(2, options.keyframeInterval || 8) * 1000;
        var current = null;
        var timer = null;
        var running = false;
        var listeners = [];
        var lastPointer = 0;
        var lastScroll = 0;
        var _lastActivity = clock();
        var lastLocation = null;
        // rrweb carries its own cursor and scroll; the overlay keeps only what it lacks
        var ownPointer = recorder.format !== "rrweb/2";

        /** @returns {Object} an empty chunk starting now */
        function newChunk() {
            return {
                t0: clock(),
                t1: clock(),
                frames: [],
                overlay: {
                    pointer: [],
                    scroll: [],
                    viewport: [],
                    visibility: [],
                    location: []
                },
                screen: {
                    w: window.innerWidth,
                    h: window.innerHeight,
                    dpr: window.devicePixelRatio || 1
                }
            };
        }
        var sink = {
            keyframe: function keyframe(t, frame) {
                if (current && current.frames.length) {
                    finish();
                }
                if (!current) {
                    current = newChunk();
                }
                current.t0 = Math.min(current.t0, t);
                current.frames.push(frame);
                current.t1 = Math.max(current.t1, t);
                // every chunk carries its own address, so playback from any chunk shows it
                lastLocation = null;
                noteLocation();
            },
            delta: function delta(t, frame) {
                if (!current) {
                    return;
                }
                current.frames.push(frame);
                current.t1 = Math.max(current.t1, t);
            }
        };

        /** Close the current chunk and hand it over. */
        function finish() {
            if (!current || !current.frames.length) {
                return;
            }
            current.t1 = Math.max(current.t1, clock());
            var chunk = current;
            current = null;
            chunk.data = recorder.packChunk(chunk.frames);
            delete chunk.frames;
            chunk.format = recorder.format;
            chunk.recorder = {
                name: recorder.name,
                version: recorder.version
            };
            options.onChunk(chunk);
        }

        /** Seal the chunk now and start the next one with a keyframe. */
        function seal() {
            if (!running) {
                return;
            }
            finish();
            current = newChunk();
            recorder.keyframe();
        }

        /** @param {string} kind - pointer kind for the track */
        function activity() {
            _lastActivity = clock();
        }

        /** Address-bar track; also catches SPA navigations between captures. */
        function noteLocation() {
            var href = window.location.pathname + window.location.hash;
            if (current && href !== lastLocation) {
                lastLocation = href;
                current.overlay.location.push([clock(), href]);
            }
        }

        /**
         * @param {Object} target - event target
         * @param {string} type - event
         * @param {function} fn - listener
         */
        function listen(target, type, fn) {
            target.addEventListener(type, fn, {
                capture: true,
                passive: true
            });
            listeners.push([target, type, fn]);
        }

        /**
         * @param {number} kind - 0 move, 1 down, 2 up, 3 touch start, 4 touch move, 5 touch end
         * @returns {function} listener recording the pointer
         */
        function pointer(kind) {
            return function (event) {
                activity();
                if (!current || !ownPointer) {
                    return;
                }
                var t = clock();
                if (kind === 0 || kind === 4) {
                    if (t - lastPointer < POINTER_INTERVAL) {
                        return;
                    }
                    lastPointer = t;
                }
                var point = event.touches && event.touches[0] ? event.touches[0] : event.changedTouches && event.changedTouches[0] || event;
                current.overlay.pointer.push([t, Math.round(point.clientX || 0), Math.round(point.clientY || 0), kind]);
            };
        }
        return {
            start: function start() {
                if (running) {
                    return;
                }
                running = true;
                current = newChunk();
                listen(document, "mousemove", pointer(0));
                listen(document, "mousedown", pointer(1));
                listen(document, "mouseup", pointer(2));
                listen(document, "touchstart", pointer(3));
                listen(document, "touchmove", pointer(4));
                listen(document, "touchend", pointer(5));
                listen(document, "keydown", activity);
                // the address as soon as it changes; history.pushState is caught by the timer below
                listen(window, "hashchange", noteLocation);
                listen(window, "popstate", noteLocation);
                listen(window, "scroll", function () {
                    activity();
                    var t = clock();
                    if (!current || !ownPointer || t - lastScroll < SCROLL_INTERVAL) {
                        return;
                    }
                    lastScroll = t;
                    current.overlay.scroll.push([t, Math.round(window.scrollX || 0), Math.round(window.scrollY || 0)]);
                });
                listen(window, "resize", function () {
                    if (current) {
                        current.overlay.viewport.push([clock(), window.innerWidth, window.innerHeight]);
                    }
                });
                listen(document, "visibilitychange", function () {
                    if (current) {
                        current.overlay.visibility.push([clock(), document.visibilityState === "hidden" ? 0 : 1]);
                    }
                });
                recorder.start(sink, {});
                if (current) {
                    current.overlay.scroll.push([clock(), Math.round(window.scrollX || 0), Math.round(window.scrollY || 0)]);
                }
                timer = setInterval(function () {
                    noteLocation();
                    // a hidden tab draws nothing new: no empty chunks every few seconds
                    if (document.visibilityState !== "hidden") {
                        seal();
                    }
                }, interval);
            },
            stop: function stop() {
                if (!running) {
                    return;
                }
                finish();
                running = false;
                clearInterval(timer);
                recorder.stop();
                listeners.forEach(function (l) {
                    l[0].removeEventListener(l[1], l[2], true);
                });
                listeners = [];
                current = null;
            },
            seal: seal,
            isRunning: function isRunning() {
                return running;
            },
            lastActivity: function lastActivity() {
                return _lastActivity;
            }
        };
    }

    // The recording module's IndexedDB database: the upload outbox and the rolling buffer's mirror.

    var DB_NAME = "countly_recordings";
    var VERSION$1 = 2;
    var STORES = {
        OUTBOX: "outbox",
        BUFFER: "buffer"
    };
    var opened = null;

    /**
     * @returns {Promise<IDBDatabase|null>} the database, or null where IndexedDB is unavailable
     */
    function openDb() {
        if (opened) {
            return opened;
        }
        opened = new Promise(function (resolve) {
            try {
                if (typeof indexedDB === "undefined") {
                    resolve(null);
                    return;
                }
                var req = indexedDB.open(DB_NAME, VERSION$1);
                req.onupgradeneeded = function () {
                    var db = req.result;
                    if (!db.objectStoreNames.contains(STORES.OUTBOX)) {
                        db.createObjectStore(STORES.OUTBOX, {
                            keyPath: "id"
                        });
                    }
                    if (!db.objectStoreNames.contains(STORES.BUFFER)) {
                        db.createObjectStore(STORES.BUFFER, {
                            keyPath: "id"
                        }).createIndex("tab", "tab");
                    }
                };
                req.onsuccess = function () {
                    resolve(req.result);
                };
                req.onerror = function () {
                    resolve(null);
                };
                req.onblocked = function () {
                    // another tab still has the old version open: run without storage this time
                    resolve(null);
                };
            } catch (e) {
                resolve(null);
            }
        });
        return opened;
    }

    /**
     * Run `fn` on a store; storage failures (full, closed, private mode) are swallowed.
     * @param {string} name - store name
     * @param {string} mode - "readwrite" or "readonly"
     * @param {function} fn - (store) => void
     */
    function withStore(name, mode, fn) {
        openDb().then(function (db) {
            if (!db) {
                return;
            }
            try {
                fn(db.transaction(name, mode).objectStore(name));
            } catch (e) {
                // kept in memory only
            }
        });
    }

    // Chunk uploads (PLAN.md 8.5): one request per chunk to /v2/session-replays/chunk, in order,
    // with retries. Kept apart from the SDK's request queue so a large chunk never holds back
    // events. Jobs are mirrored to IndexedDB, so chunks a closed tab could not send go up on
    // the next page load of the site.

    var STORE = STORES.OUTBOX;
    var KEEPALIVE_LIMIT = 60 * 1024;
    var MAX_JOBS = 400;

    /**
     * @param {Object} options - {endpoint(), log(level, message), clock}
     * @returns {Object} outbox: add, flushOnHide, size
     */
    function createOutbox(options) {
        var jobs = [];
        var busy = false;
        var retryTimer = null;
        var dbPromise = openDb();
        var restored = false;

        /**
         * @param {string} mode - "readwrite" or "readonly"
         * @param {function} fn - (store) => void
         */
        function withStore(mode, fn) {
            dbPromise.then(function (db) {
                if (!db) {
                    return;
                }
                try {
                    fn(db.transaction(STORE, mode).objectStore(STORE));
                } catch (e) {
                    // storage full or closed: the job stays in memory only
                }
            });
        }

        /** Pick up jobs a previous page load left behind. */
        function restore() {
            if (restored) {
                return;
            }
            restored = true;
            withStore("readonly", function (store) {
                var req = store.getAll();
                req.onsuccess = function () {
                    var known = new Set(jobs.map(function (j) {
                        return j.id;
                    }));
                    (req.result || []).forEach(function (job) {
                        if (!known.has(job.id)) {
                            jobs.push(job);
                        }
                    });
                    jobs.sort(function (a, b) {
                        return a.created - b.created;
                    });
                    pump();
                };
            });
        }

        /**
         * @param {Object} job - the finished job
         */
        function forget(job) {
            jobs = jobs.filter(function (j) {
                return j.id !== job.id;
            });
            withStore("readwrite", function (store) {
                store["delete"](job.id);
            });
        }

        /**
         * Drop every job of a recording (the server refused it for good).
         * @param {string} rid - recording id
         */
        function dropRecording(rid) {
            jobs.filter(function (j) {
                return j.rid === rid;
            }).forEach(forget);
        }

        /**
         * @param {Object} job - upload job
         * @returns {FormData} multipart body
         */
        function body(job) {
            var form = new FormData();
            form.append("meta", JSON.stringify(job.meta));
            form.append("chunk", job.blob, "chunk.gz");
            return form;
        }

        /**
         * @param {Object} job - upload job
         * @returns {string} request url
         */
        function url(job) {
            var target = options.endpoint(job);
            var query = {
                app_key: target.app_key,
                device_id: target.device_id,
                rid: job.rid,
                stream: job.stream,
                seq: job.seq,
                "final": job["final"] ? 1 : 0,
                ct0: job.ct0,
                ct1: job.ct1,
                t: options.clock()
            };
            return target.url + "/v2/session-replays/chunk?" + Object.keys(query).map(function (k) {
                return encodeURIComponent(k) + "=" + encodeURIComponent(query[k]);
            }).join("&");
        }

        /** @param {number} seconds - wait before the next attempt */
        function retryLater(seconds) {
            clearTimeout(retryTimer);
            retryTimer = setTimeout(function () {
                retryTimer = null;
                pump();
            }, seconds * 1000);
        }

        /** Send the oldest job; on success, the next. */
        function pump() {
            if (busy || retryTimer || !jobs.length) {
                return;
            }
            var target = options.endpoint(jobs[0]);
            if (!target || !target.url || target.isTemporaryId) {
                // no device id to send under yet: wait, as the SDK's own queue does
                retryLater(10);
                return;
            }
            var job = jobs[0];
            busy = true;
            fetch(url(job), {
                method: "POST",
                body: body(job),
                credentials: "omit"
            }).then(function (res) {
                return res.json()["catch"](function () {
                    return {};
                }).then(function (answer) {
                    busy = false;
                    if (res.ok) {
                        forget(job);
                        pump();
                        return;
                    }
                    if (res.status === 409 || res.status === 429 || res.status >= 500) {
                        // consent or the user not known yet, quota, or a server problem: try again later
                        options.log("warning", "recording chunk " + job.seq + " of " + job.rid + " deferred (" + res.status + ")");
                        retryLater(Math.min(3600, answer && answer.retry_after || 60));
                        return;
                    }
                    // refused for good (no consent, too large, invalid): the rest of the recording would be too
                    options.log("error", "recording " + job.rid + " refused (" + res.status + "): " + (answer && answer.error));
                    dropRecording(job.rid);
                    pump();
                });
            })["catch"](function () {
                busy = false;
                retryLater(30);
            });
        }
        return {
            /**
             * Queue one chunk upload.
             * @param {Object} job - {rid, stream, seq, final, ct0, ct1, meta, blob}
             */
            add: function add(job) {
                job.id = job.rid + ":" + job.seq;
                job.created = options.clock();
                if (jobs.length >= MAX_JOBS) {
                    options.log("warning", "recording outbox is full, dropping the oldest chunk");
                    forget(jobs[0]);
                }
                jobs.push(job);
                withStore("readwrite", function (store) {
                    store.put(job);
                });
                restore();
                pump();
            },
            /** The page is going away: send what fits a keepalive request now; IndexedDB keeps the rest. */
            flushOnHide: function flushOnHide() {
                jobs.slice(0, 10).forEach(function (job) {
                    if (job.blob.size > KEEPALIVE_LIMIT) {
                        return;
                    }
                    try {
                        fetch(url(job), {
                            method: "POST",
                            body: body(job),
                            keepalive: true,
                            credentials: "omit"
                        });
                    } catch (e) {
                        // the next page load sends it
                    }
                });
            },
            restore: restore,
            size: function size() {
                return jobs.length;
            }
        };
    }

    // The rolling buffer's mirror in IndexedDB, per tab (PLAN.md 8.2). A multi-page site starts a
    // new document on every navigation; the mirror gives the new page the chunks of the last
    // `window` seconds, so a trigger on page two still shows how the user got there. A tab is
    // its recording stream (`cly_rsid` in sessionStorage), which also survives navigations.


    // at most this many chunks per tab, whatever the window (8 s chunks: ten minutes)
    var MAX_CHUNKS = 75;
    // other tabs' chunks older than this are left over from closed tabs
    var STALE_MS = 60 * 60 * 1000;

    /**
     * @param {string} tab - recording stream of the tab
     * @param {Object} chunk - sealed chunk
     * @returns {string} the chunk's key
     */
    function keyOf(tab, chunk) {
        return tab + ":" + chunk.t0 + ":" + chunk.t1;
    }

    /**
     * @param {Object} options - {clock}
     * @returns {Object} mirror: put, remove, load, clear
     */
    function createBufferMirror(options) {
        return {
            /**
             * @param {string} tab - recording stream
             * @param {Object} chunk - sealed chunk
             */
            put: function put(tab, chunk) {
                withStore(STORES.BUFFER, "readwrite", function (store) {
                    store.put({
                        id: keyOf(tab, chunk),
                        tab: tab,
                        t0: chunk.t0,
                        t1: chunk.t1,
                        format: chunk.format,
                        chunk: chunk
                    });
                });
            },
            /**
             * @param {string} tab - recording stream
             * @param {Object} chunk - chunk that left the buffer
             */
            remove: function remove(tab, chunk) {
                withStore(STORES.BUFFER, "readwrite", function (store) {
                    store["delete"](keyOf(tab, chunk));
                });
            },
            /**
             * The tab's chunks that reach into the window, oldest first, of the given format; the
             * rest of the tab's chunks and other tabs' stale ones are deleted.
             * @param {string} tab - recording stream
             * @param {number} since - window start (ms)
             * @param {string} format - the recorder's format; chunks of another are dropped
             * @returns {Promise<Object[]>} chunks
             */
            load: function load(tab, since, format) {
                return openDb().then(function (db) {
                    if (!db) {
                        return [];
                    }
                    return new Promise(function (resolve) {
                        try {
                            var store = db.transaction(STORES.BUFFER, "readwrite").objectStore(STORES.BUFFER);
                            var req = store.getAll();
                            req.onsuccess = function () {
                                var now = options.clock();
                                var keep = [];
                                (req.result || []).forEach(function (row) {
                                    if (row.tab === tab && row.t1 >= since && row.format === format) {
                                        keep.push(row);
                                    } else if (row.tab === tab || now - row.t1 > STALE_MS) {
                                        store["delete"](row.id);
                                    }
                                });
                                keep.sort(function (a, b) {
                                    return a.t0 - b.t0;
                                });
                                keep.slice(0, Math.max(0, keep.length - MAX_CHUNKS)).forEach(function (row) {
                                    store["delete"](row.id);
                                });
                                resolve(keep.slice(-MAX_CHUNKS).map(function (row) {
                                    return row.chunk;
                                }));
                            };
                            req.onerror = function () {
                                resolve([]);
                            };
                        } catch (e) {
                            resolve([]);
                        }
                    });
                });
            },
            /**
             * Forget the tab's chunks (consent withdrawn, recording stopped).
             * @param {string} tab - recording stream
             */
            clear: function clear(tab) {
                withStore(STORES.BUFFER, "readwrite", function (store) {
                    var req = store.index("tab").getAllKeys(tab);
                    req.onsuccess = function () {
                        (req.result || []).forEach(function (id) {
                            store["delete"](id);
                        });
                    };
                });
            }
        };
    }

    var VERSION = "0.1.0";
    // how long a page waits for its server settings before deciding that nothing records (see syncStream)
    var SETTINGS_WAIT_MS = 3000;
    var DEFAULTS = {
        enabled: true,
        window: 40,
        after: 10,
        maxDuration: 300,
        maxBytes: 2000000,
        maxPerDay: 10,
        keyframeInterval: 8,
        sampleRate: 1,
        recorder: "wire",
        triggers: {
            crash: {
                fatal: true,
                nonfatal: true
            },
            events: [],
            views: []
        },
        privacy: {
            maskAllText: false,
            maskAllInputs: true
        }
    };
    var SERVER_KEYS = {
        rec: "enabled",
        rec_sr: "sampleRate",
        rec_w: "window",
        rec_a: "after",
        rec_md: "maxDuration",
        rec_mb: "maxBytes",
        rec_pd: "maxPerDay"
    };
    var recorders = {
        wire: createWireRecorder
    };
    var pendingRecorders = window.__countlyRecorders || [];

    /**
     * @param {string} prefix - id prefix
     * @returns {string} a random id the server accepts ([A-Za-z0-9_-], ≤ 64)
     */
    function randomId(prefix) {
        var bytes = new Uint8Array(12);
        (window.crypto || window.msCrypto).getRandomValues(bytes);
        return prefix + Array.prototype.map.call(bytes, function (b) {
            return ("0" + b.toString(16)).slice(-2);
        }).join("");
    }

    /**
     * @param {string} text - device id
     * @returns {number} a stable number in [0, 1)
     */
    function hashUnit(text) {
        var h = 2166136261;
        for (var i = 0; i < text.length; i++) {
            h ^= text.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return (h >>> 0) / 4294967296;
    }

    /**
     * Does a segment value match a trigger condition (a value, or {$lt, $lte, $gt, $gte, $eq, $ne})?
     * @param {*} value - event segment value
     * @param {*} rule - condition
     * @returns {boolean} true when it matches
     */
    function matchesRule(value, rule) {
        if (rule === null || _typeof(rule) !== "object") {
            return value === rule;
        }
        var ops = {
            $lt: function $lt(a, b) {
                return a < b;
            },
            $lte: function $lte(a, b) {
                return a <= b;
            },
            $gt: function $gt(a, b) {
                return a > b;
            },
            $gte: function $gte(a, b) {
                return a >= b;
            },
            $eq: function $eq(a, b) {
                return a === b;
            },
            $ne: function $ne(a, b) {
                return a !== b;
            }
        };
        return Object.keys(rule).every(function (op) {
            return ops[op] ? ops[op](value, rule[op]) : false;
        });
    }

    /**
     * @param {string} pattern - "/checkout/*" style URL pattern
     * @param {string} path - location path
     * @returns {boolean} true when the path matches
     */
    function matchesScope(pattern, path) {
        var re = new RegExp("^" + pattern.split("*").map(function (part) {
            return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
        }).join(".*") + "$");
        return re.test(path);
    }

    // chunks a closing page could not compress, as `<prefix><rid>:<seq>` (see keepForNextPage)
    var CLOSING_PREFIX = "cly_rec_closing:";

    /**
     * gzip a chunk's JSON with the browser's CompressionStream.
     * @param {Object} chunk - envelope
     * @returns {Promise<Blob>} gzip bytes
     */
    function gzip(chunk) {
        var stream = new Blob([JSON.stringify(chunk)]).stream().pipeThrough(new CompressionStream("gzip"));
        return new Response(stream).blob();
    }

    /**
     * The recording module for one Countly instance.
     * @param {Object} Countly - the SDK instance
     * @returns {Object} the public Countly.recording API
     */
    function createRecordingModule(Countly) {
        var bridge = Countly._internals.recording;
        var log = function log(level, message) {
            Countly._internals.log(level === "error" ? "[ERROR] " : level === "warning" ? "[WARNING] " : "[DEBUG] ", "[recording] " + message);
        };
        // wall clock, the same as the SDK's event timestamps (without their +1 ms de-duplication)
        var clock = Date.now;
        var capture = null;
        var recorder = null;
        // sealed chunks of the last `window` seconds (plus the one that reaches past it)
        var buffer = [];
        // triggered recordings still in their `after` seconds
        var openTriggered = [];
        var study = null;
        var studyRecording = null;
        // set while the page closes or recording stops: the study recording's chunk sealed then is its last
        var ending = false;
        // set while the page closes: there is no time left to compress, so chunks wait in localStorage
        var leaving = false;
        var lastRid = null;
        var bufferWanted = false;
        var stopped = false;
        // until this page's server settings arrive, or SETTINGS_WAIT_MS pass, the tab's stream is on
        // whenever consent allows, also before anything records: the page's first view leaves before
        // them, and a recording they start must still find it
        var awaitingSettings = true;
        var settingsTimer = setTimeout(settingsArrived, SETTINGS_WAIT_MS);
        var mirror = createBufferMirror({
            clock: clock
        });
        var outbox = createOutbox({
            clock: clock,
            log: log,
            endpoint: function endpoint() {
                return bridge.info();
            }
        });

        /** @returns {Object} the effective settings: server > init > defaults (PLAN.md 8.4) */
        function settings() {
            var init = bridge.initConfig() || {};
            var server = bridge.serverConfig() || {};
            var s = Object.assign({}, DEFAULTS, init);
            s.triggers = Object.assign({}, DEFAULTS.triggers, init.triggers || {});
            s.privacy = Object.assign({}, DEFAULTS.privacy, init.privacy || {});
            Object.keys(SERVER_KEYS).forEach(function (key) {
                if (server[key] !== undefined) {
                    s[SERVER_KEYS[key]] = server[key];
                }
            });
            // crash triggers: one switch each for unhandled (rec_tcf) and handled (rec_tcn) errors
            if (typeof server.rec_tcf === "boolean" || typeof server.rec_tcn === "boolean") {
                s.triggers.crash = {
                    fatal: typeof server.rec_tcf === "boolean" ? server.rec_tcf : s.triggers.crash.fatal,
                    nonfatal: typeof server.rec_tcn === "boolean" ? server.rec_tcn : s.triggers.crash.nonfatal
                };
            }
            if (server.rec_te) {
                s.triggers.events = server.rec_te;
            }
            if (server.rec_tv) {
                s.triggers.views = server.rec_tv;
            }
            if (server.rec_r && server.rec_r.web) {
                s.recorder = server.rec_r.web;
            }
            if (server.rec_mask === "strict") {
                s.privacy.maskAllText = true;
            }
            s.study = server.rec_st && server.rec_st.until > Date.now() ? server.rec_st : null;
            return s;
        }

        /** @returns {string} this tab's recording stream id (kept for the tab's life) */
        function streamId() {
            var key = "cly_rsid";
            try {
                var existing = window.sessionStorage.getItem(key);
                if (existing) {
                    return existing;
                }
                var id = randomId("s");
                window.sessionStorage.setItem(key, id);
                return id;
            } catch (e) {
                return randomId("s");
            }
        }

        /** Recordings sent today by this device, for maxPerDay. */
        function dailyCount(add) {
            var key = "cly_rec_day";
            var today = new Date().toISOString().slice(0, 10);
            var state = {
                day: today,
                n: 0
            };
            try {
                var stored = JSON.parse(window.localStorage.getItem(key) || "null");
                if (stored && stored.day === today) {
                    state = stored;
                }
                if (add) {
                    state.n += add;
                    window.localStorage.setItem(key, JSON.stringify(state));
                }
            } catch (e) {
                // storage unavailable: no daily cap across page loads
            }
            return state.n;
        }

        /**
         * The fields every chunk of a recording carries (the server never decodes chunk bytes).
         * @param {Object} rec - recording
         * @returns {Object} meta
         */
        function meta(rec) {
            var info = bridge.info();
            var m = {
                kind: rec.kind,
                format: recorder.format,
                recorder: {
                    name: recorder.name,
                    version: recorder.version
                },
                sdk: {
                    name: info.sdk_name,
                    version: info.sdk_version
                },
                platform: "web",
                screen: {
                    w: window.innerWidth,
                    h: window.innerHeight,
                    dpr: window.devicePixelRatio || 1
                },
                t0: rec.t0
            };
            if (info.app_version) {
                m.app_version = String(info.app_version);
            }
            if (rec.kind === "study") {
                m.study = rec.study;
            } else {
                m.trigger = rec.trigger;
            }
            return m;
        }

        /**
         * Queue one chunk of a recording for upload.
         * @param {Object} rec - recording
         * @param {Object} chunk - sealed chunk
         * @param {boolean} final - the recording's last chunk
         */
        function send(rec, chunk, _final) {
            var seq = rec.seq++;
            var envelope = {
                v: 1,
                rid: rec.rid,
                stream: rec.stream,
                seq: seq,
                format: chunk.format,
                recorder: chunk.recorder,
                t0: chunk.t0,
                t1: chunk.t1,
                keyframe: true,
                screen: chunk.screen,
                overlay: chunk.overlay,
                data: chunk.data
            };
            var job = {
                rid: rec.rid,
                stream: rec.stream,
                seq: seq,
                "final": _final,
                ct0: chunk.t0,
                ct1: chunk.t1,
                meta: meta(rec)
            };
            if (leaving) {
                keepForNextPage(job, envelope);
                return;
            }
            queue(job, envelope);
        }

        /**
         * Compress the chunk and hand it to the outbox.
         * @param {Object} job - upload job without its blob
         * @param {Object} envelope - the chunk
         */
        function queue(job, envelope) {
            gzip(envelope).then(function (blob) {
                job.blob = blob;
                outbox.add(job);
            })["catch"](function (e) {
                log("error", "could not compress a chunk: " + e);
            });
        }

        /**
         * The page is closing: compression would not finish before it is gone (it runs in tasks
         * the closed page never gets), so keep the chunk as it is; the next page load sends it.
         * @param {Object} job - upload job without its blob
         * @param {Object} envelope - the chunk
         */
        function keepForNextPage(job, envelope) {
            try {
                window.localStorage.setItem(CLOSING_PREFIX + job.rid + ":" + job.seq, JSON.stringify({
                    job: job,
                    envelope: envelope
                }));
            } catch (e) {
                log("warning", "could not keep chunk " + job.seq + " of " + job.rid + " for the next page: " + e);
            }
        }

        /** Send the chunks an earlier page kept while it closed. */
        function sendKeptChunks() {
            var kept = [];
            try {
                for (var i = 0; i < window.localStorage.length; i++) {
                    var key = window.localStorage.key(i);
                    if (key && key.indexOf(CLOSING_PREFIX) === 0) {
                        kept.push(key);
                    }
                }
                kept.forEach(function (key) {
                    var item = JSON.parse(window.localStorage.getItem(key));
                    window.localStorage.removeItem(key);
                    queue(item.job, item.envelope);
                });
            } catch (e) {
                log("warning", "could not send the chunks kept by an earlier page: " + e);
            }
            if (kept.length) {
                log("debug", "sending " + kept.length + " chunk(s) kept by an earlier page");
            }
        }

        /**
         * A new chunk was sealed: it joins the buffer, the triggered recordings still recording
         * their `after` seconds, and the study recording.
         * @param {Object} chunk - sealed chunk
         */
        function onChunk(chunk) {
            var s = settings();
            if (bufferWanted) {
                var tab = streamId();
                buffer.push(chunk);
                mirror.put(tab, chunk);
                var from = chunk.t1 - s.window * 1000;
                // keep the chunk that reaches back past the window start whole
                while (buffer.length > 1 && buffer[1].t0 <= from) {
                    mirror.remove(tab, buffer.shift());
                }
            }
            openTriggered.forEach(function (rec) {
                rec.chunks.push(chunk);
            });
            if (studyRecording) {
                var rec = studyRecording;
                var ended = ending ? "closed" : endOfStudyRecording(rec, chunk);
                send(rec, chunk, !!ended);
                if (ended) {
                    log("debug", "study recording " + rec.rid + " ended: " + ended);
                    studyRecording = null;
                    if (ended === "max duration" && Date.now() - capture.lastActivity() < 60000) {
                        startStudyRecording();
                    }
                }
            }
        }

        /**
         * @param {Object} rec - study recording
         * @param {Object} chunk - its latest chunk
         * @returns {string|null} why it ends with this chunk, or null
         */
        function endOfStudyRecording(rec, chunk) {
            if (!study || Date.now() >= study.until) {
                return "study ended";
            }
            if (chunk.t1 - rec.t0 >= study.md * 1000) {
                return "max duration";
            }
            if (chunk.t1 - capture.lastActivity() >= study.idle * 1000) {
                return "idle";
            }
            return null;
        }

        /**
         * The tab's stream on the SDK's requests (PLAN.md 5.4): on while capturing, and while this page
         * still waits for its server settings; off otherwise.
         */
        function syncStream() {
            var on = !stopped && bridge.hasConsent() && bridge.isTracking() && (!!capture || awaitingSettings);
            bridge.setStream(on ? streamId() : null);
        }

        /** This page's server settings arrived (or will not): the stream stays on only while capturing. */
        function settingsArrived() {
            if (awaitingSettings) {
                awaitingSettings = false;
                clearTimeout(settingsTimer);
                syncStream();
            }
        }

        /** Begin what the settings and consent allow, and set the stream to match. */
        function ensureCapture() {
            startCapture();
            syncStream();
        }

        /** Begin the rolling buffer and/or study capture, as the settings and consent allow. */
        function startCapture() {
            if (stopped || !bridge.hasConsent() || !bridge.isTracking()) {
                if (capture && !bridge.isTracking()) {
                    stopCapture();
                }
                return;
            }
            var s = settings();
            var info = bridge.info();
            bufferWanted = !!s.enabled && hashUnit(String(info.device_id || "")) < s.sampleRate;
            study = s.study && (!s.study.scope || s.study.scope.some(function (p) {
                return matchesScope(p, window.location.pathname);
            })) ? s.study : null;
            if (!bufferWanted && !study) {
                return;
            }
            if (typeof CompressionStream === "undefined") {
                log("warning", "this browser cannot compress recordings (no CompressionStream); not recording");
                return;
            }
            if (!capture) {
                var factory = recorders[s.recorder] || recorders.wire;
                if (!recorders[s.recorder]) {
                    log("warning", "recorder \"" + s.recorder + "\" is not loaded; using cly-wire");
                }
                recorder = factory({
                    privacy: s.privacy,
                    clock: clock
                });
                capture = createCapture({
                    recorder: recorder,
                    keyframeInterval: s.keyframeInterval,
                    clock: clock,
                    onChunk: onChunk
                });
                bridge.setStream(streamId());
                capture.start();
                log("debug", "capture started with " + recorder.format + (study ? " for study " + study.id : ""));
                if (bufferWanted) {
                    restoreBuffer(s);
                }
            }
            if (study && !studyRecording) {
                startStudyRecording();
                if (study.ia) {
                    bridge.enableStudyInteractions(function () {
                        return !!studyRecording;
                    });
                }
                if (study.av) {
                    watchNavigation();
                }
            }
        }

        /**
         * Put back the chunks the tab's previous pages left in the window, ahead of this page's.
         * @param {Object} s - settings
         */
        function restoreBuffer(s) {
            var format = recorder.format;
            mirror.load(streamId(), clock() - s.window * 1000, format).then(function (previous) {
                if (!capture || !bufferWanted || recorder.format !== format || !previous.length) {
                    return;
                }
                var firstHere = buffer.length ? buffer[0].t0 : Infinity;
                buffer = previous.filter(function (chunk) {
                    return chunk.t1 <= firstHere;
                }).concat(buffer);
                log("debug", "buffer restored " + previous.length + " chunk(s) from earlier pages of this tab");
            });
        }

        /** Start a study recording (at load, and again after one ends at its maximum duration). */
        function startStudyRecording() {
            var t0 = clock();
            studyRecording = {
                rid: randomId("r"),
                kind: "study",
                study: study.id,
                stream: streamId(),
                t0: t0,
                seq: 0
            };
            lastRid = studyRecording.rid;
            bridge.recordStart({
                rid: studyRecording.rid,
                kind: "study",
                study: study.id,
                fmt: recorder.format,
                rec_v: recorder.name + "@" + recorder.version
            }, t0);
            if (study.av) {
                Countly.track_pageview(window.location.pathname);
            }
        }

        /** Studies on apps without page views: a view on every route change of a single-page app. */
        function watchNavigation() {
            var last = window.location.pathname;
            var check = function check() {
                if (studyRecording && window.location.pathname !== last) {
                    last = window.location.pathname;
                    Countly.track_pageview(last);
                }
            };
            ["pushState", "replaceState"].forEach(function (name) {
                var original = window.history[name];
                window.history[name] = function () {
                    var result = original.apply(this, arguments);
                    setTimeout(check, 0);
                    return result;
                };
            });
            window.addEventListener("popstate", check);
            window.addEventListener("hashchange", check);
        }
        function stopCapture() {
            if (capture) {
                capture.stop();
                capture = null;
            }
            buffer = [];
            mirror.clear(streamId());
            bridge.setStream(null);
        }

        /**
         * Turn the buffer into a triggered recording (PLAN.md 7.3): the past `window` seconds,
         * and `after` more seconds; sent once it has ended.
         * @param {string} type - crash, event, view or api
         * @param {string} key - event key, view name or api reason
         * @param {number} [after] - seconds to keep recording, overriding the setting
         * @returns {string|null} recording id
         */
        function trigger(type, key, after) {
            if (!capture || !bufferWanted) {
                return null;
            }
            var s = settings();
            if (dailyCount(0) >= s.maxPerDay) {
                log("warning", "maxPerDay (" + s.maxPerDay + ") recordings reached; not recording this " + type);
                return null;
            }
            dailyCount(1);
            // The buffer holds sealed chunks only: seal the one in progress, or a trigger soon
            // after a seal (or before the first) would lose the seconds just before it.
            capture.seal();
            var now = clock();
            var chunks = buffer.slice();
            var t0 = chunks.length ? chunks[0].t0 : now;
            var rec = {
                rid: randomId("r"),
                kind: "triggered",
                stream: streamId(),
                t0: t0,
                seq: 0,
                chunks: chunks,
                trigger: {
                    type: type,
                    ts: now
                }
            };
            if (key) {
                rec.trigger.key = String(key).slice(0, 256);
            }
            lastRid = rec.rid;
            bridge.recordStart({
                rid: rec.rid,
                kind: "triggered",
                trigger: type,
                trigger_key: rec.trigger.key,
                fmt: recorder.format,
                rec_v: recorder.name + "@" + recorder.version
            }, t0);
            openTriggered.push(rec);
            var seconds = Math.min(typeof after === "number" ? after : s.after, s.maxDuration);
            rec.timer = setTimeout(function () {
                finishTriggered(rec);
            }, seconds * 1000);
            log("debug", "triggered recording " + rec.rid + " (" + type + (key ? " " + key : "") + ")");
            return rec.rid;
        }

        /**
         * The triggered recording has ended: seal the current chunk and send all of them.
         * @param {Object} rec - recording
         */
        function finishTriggered(rec) {
            clearTimeout(rec.timer);
            if (capture) {
                capture.seal();
            }
            openTriggered = openTriggered.filter(function (r) {
                return r !== rec;
            });
            var s = settings();
            var chunks = rec.chunks;
            // keep the newest chunks within maxBytes (sizes are estimated from the JSON)
            var total = 0;
            var kept = [];
            for (var i = chunks.length - 1; i >= 0; i--) {
                total += JSON.stringify(chunks[i].data).length;
                if (total > s.maxBytes && kept.length) {
                    break;
                }
                kept.unshift(chunks[i]);
            }
            kept.forEach(function (chunk, index) {
                send(rec, chunk, index === kept.length - 1);
            });
        }

        // --- SDK notifications ---------------------------------------------------------------------
        bridge.attach({
            isRecording: function isRecording() {
                return !!capture;
            },
            maskAllText: function maskAllText() {
                return !!settings().privacy.maskAllText;
            },
            nodeId: function nodeId(el) {
                return recorder && capture ? recorder.nodeId(el) : undefined;
            },
            onEvent: function onEvent(event) {
                if (!capture) {
                    return;
                }
                var t = settings().triggers;
                if (event.key === "[CLY]_view" && event.segmentation && event.segmentation.visit) {
                    if ((t.views || []).indexOf(event.segmentation.name) !== -1) {
                        trigger("view", event.segmentation.name);
                    }
                    return;
                }
                (t.events || []).some(function (rule) {
                    var key = typeof rule === "string" ? rule : rule && rule.key;
                    if (key !== event.key) {
                        return false;
                    }
                    var sg = rule && rule.sg || {};
                    var segments = event.segmentation || {};
                    if (Object.keys(sg).every(function (k) {
                        return matchesRule(segments[k], sg[k]);
                    })) {
                        trigger("event", event.key);
                        return true;
                    }
                    return false;
                });
            },
            onCrash: function onCrash(crash) {
                var c = settings().triggers.crash || {};
                if (crash.nonfatal ? c.nonfatal : c.fatal) {
                    trigger("crash", crash.nonfatal ? "nonfatal" : "fatal");
                }
            },
            onConsent: function onConsent(given) {
                if (given) {
                    ensureCapture();
                } else {
                    // consent withdrawn: drop what is buffered and stop; stored recordings stay (PLAN.md 13.2)
                    openTriggered.forEach(function (rec) {
                        clearTimeout(rec.timer);
                    });
                    openTriggered = [];
                    studyRecording = null;
                    stopCapture();
                }
            },
            onServerConfig: function onServerConfig() {
                ensureCapture();
                settingsArrived();
            }
        });
        window.addEventListener("pagehide", function () {
            // the tab is going away: end what is open, keep what is not compressed yet for the
            // next page load, and send what is ready in keepalive requests
            leaving = true;
            openTriggered.slice().forEach(finishTriggered);
            // seal the page's last seconds: the study ends with them, the buffer mirror keeps them for the next page
            if ((studyRecording || bufferWanted) && capture) {
                ending = true;
                capture.seal();
                ending = false;
            }
            leaving = false;
            outbox.flushOnHide();
        });
        window.addEventListener("pageshow", function (e) {
            // back from the back/forward cache: send what the page kept, and follow the ended study recording with a new one
            if (e.persisted) {
                sendKeptChunks();
                ensureCapture();
            }
        });
        outbox.restore();
        sendKeptChunks();
        ensureCapture();
        return {
            /** Start the rolling buffer (when init did not, or after stop()). */
            start: function start() {
                stopped = false;
                ensureCapture();
            },
            /**
             * Send a recording now: the past window and `after` more seconds.
             * @param {Object} [options] - {reason, after}
             * @returns {string|null} recording id, or null when nothing is being recorded
             */
            send: function send(options) {
                options = options || {};
                return trigger("api", options.reason || "api", options.after);
            },
            /** Stop recording; open recordings are sent first. */
            stop: function stop() {
                stopped = true;
                openTriggered.slice().forEach(finishTriggered);
                if (studyRecording && capture) {
                    ending = true;
                    capture.seal();
                    ending = false;
                }
                studyRecording = null;
                stopCapture();
            },
            /** @param {Element} el - mask this element's text in recordings */
            mask: function mask(el) {
                if (el && el.classList) {
                    el.classList.add("cly-mask");
                }
            },
            /** @param {Element} el - stop masking this element's text */
            unmask: function unmask(el) {
                if (el && el.classList) {
                    el.classList.remove("cly-mask");
                }
            },
            /** @returns {Object} what is being recorded */
            status: function status() {
                var oldest = buffer.length ? buffer[0].t0 : null;
                return {
                    buffering: !!capture && bufferWanted,
                    bufferedMs: oldest ? clock() - oldest : 0,
                    study: studyRecording ? {
                        id: studyRecording.study,
                        rid: studyRecording.rid
                    } : null,
                    recorder: recorder ? recorder.format : null,
                    lastRid: lastRid,
                    pendingUploads: outbox.size(),
                    version: VERSION
                };
            }
        };
    }

    /**
     * Registers a recorder (the rrweb plugin calls this when it loads).
     * @param {string} name - recorder name, as the rec_r setting names it
     * @param {function} factory - (options) => recorder adapter
     */
    function registerRecorder(name, factory) {
        recorders[name] = factory;
    }
    pendingRecorders.forEach(function (entry) {
        registerRecorder(entry[0], entry[1]);
    });
    window.__countlyRecorders = {
        push: function push(entry) {
            registerRecorder(entry[0], entry[1]);
        }
    };

    /**
     * Attach to an initialized SDK instance, once, and make its API `Countly.recording`.
     * @param {Object} Countly - the global Countly object, which carries the API
     * @param {Object} instance - the SDK instance to record for
     */
    function attachTo(Countly, instance) {
        if (Countly.recording && Countly.recording.version) {
            return;
        }
        var queued = Array.isArray(Countly.recording) ? Countly.recording : [];
        Countly.recording = createRecordingModule(instance);
        Countly.recording.version = VERSION;
        queued.forEach(function (call) {
            if (Countly.recording[call[0]]) {
                Countly.recording[call[0]].apply(null, call.slice(1));
            }
        });
    }
    var waitingForInit = false;

    /**
     * Attach to the SDK. Loaded after init, at once. Loaded before it, during init
     * (`Countly._onInit`), before the page's first requests are made, so they carry the tab's
     * stream. Until the SDK is there, and as a fallback, it looks again every 200 ms.
     */
    function attach() {
        var Countly = window.Countly;
        if (Countly && Countly._internals && Countly._internals.recording && Countly.app_key) {
            attachTo(Countly, Countly);
            return;
        }
        if (Countly && Countly.recording && Countly.recording.version) {
            return;
        }
        if (Countly && !waitingForInit) {
            waitingForInit = true;
            Countly._onInit = Countly._onInit || [];
            Countly._onInit.push(function (instance) {
                if (instance._internals && instance._internals.recording) {
                    attachTo(Countly, instance);
                }
            });
        }
        setTimeout(attach, 200);
    }
    if (typeof window !== "undefined") {
        attach();
    }

    exports.createRecordingModule = createRecordingModule;
    exports.hashUnit = hashUnit;
    exports.matchesRule = matchesRule;
    exports.matchesScope = matchesScope;
    exports.registerRecorder = registerRecorder;

    return exports;

})({});
