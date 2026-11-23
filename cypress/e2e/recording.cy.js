/* eslint-disable require-jsdoc */
var hp = require("../support/helper.js");

// The Session Replay recording module (modules/recording) on a page with the SDK
// (fixtures/recording.html). Uploads go to the server's chunk endpoint, which the tests
// answer with cy.intercept and read as the server would: the URL's fields and the
// multipart `meta`. What the SDK queues (the tab's `rsid`, the [CLY]_recording_start
// event) is read from its request queue, as test_mode keeps it there.

var CHUNKS = "**/v2/session-replays/chunk*";

/**
 * Opens the fixture page
 * @param {Array} uploads - from acceptUploads: emptied once this page's module is there, so it holds this page's uploads
 * @param {Object} conf - merged into the init config
 * @param {boolean} consent - give the session_replay consent right after init
 */
function openPage(uploads, conf, consent) {
    hp.haltAndClearStorage(() => {
        cy.visit("./cypress/fixtures/recording.html?c=" + encodeURIComponent(JSON.stringify(conf || {})) + (consent ? "&consent=1" : ""));
    });
    // the module attaches once the SDK is initialized
    cy.window().its("Countly.recording.version").should("equal", "0.1.0").then(() => {
        // what the previous test's page sent as it closed (keepalive uploads on pagehide) is not this test's
        uploads.length = 0;
    });
}

/**
 * An upload as the server sees it: the query fields and the recording's meta
 * @param {Object} req - intercepted request
 * @returns {Object} {query, meta, chunkPart}
 */
function readUpload(req) {
    var params = new URL(req.url).searchParams;
    var query = {};
    params.forEach((value, key) => {
        query[key] = value;
    });
    var body = typeof req.body === "string" ? req.body : new TextDecoder().decode(req.body);
    var meta = /name="meta"\r\n\r\n([\s\S]*?)\r\n--/.exec(body);
    return {
        query: query,
        meta: meta ? JSON.parse(meta[1]) : null,
        chunkPart: /name="chunk"; filename="chunk\.gz"/.test(body)
    };
}

/**
 * Answers every chunk upload with success and keeps what was sent
 * @returns {Array} the uploads, filled as they arrive
 */
function acceptUploads() {
    var uploads = [];
    cy.intercept("POST", CHUNKS, (req) => {
        uploads.push(readUpload(req));
        req.reply({ statusCode: 200, body: { result: "Success" } });
    });
    return uploads;
}

/**
 * Waits for a recording's last chunk, and gives all of its chunks in order
 * @param {Array} uploads - from acceptUploads
 * @param {Function} rid - gives the recording id once known
 * @returns {Cypress.Chainable<Array>} the recording's uploads
 */
function recordingUploads(uploads, rid) {
    return cy.wrap(null, { timeout: 15000 }).should(() => {
        expect(uploads.some((u) => u.query.rid === rid() && u.query.final === "1"), "the recording's final chunk").to.equal(true);
    }).then(() => uploads.filter((u) => u.query.rid === rid()).sort((a, b) => Number(a.query.seq) - Number(b.query.seq)));
}

/**
 * The checks every recording's chunks pass: one stream, seq from 0 without gaps, the last one final, each with its bytes
 * @param {Array} chunks - a recording's uploads, in seq order
 * @param {string} stream - the tab's recording stream
 */
function checkChunks(chunks, stream) {
    expect(chunks.length).to.be.above(0);
    chunks.forEach((chunk, i) => {
        expect(chunk.query.seq).to.equal(String(i));
        expect(chunk.query.final).to.equal(i === chunks.length - 1 ? "1" : "0");
        expect(chunk.query.stream).to.equal(stream);
        expect(chunk.query.app_key).to.equal(hp.appKey);
        expect(chunk.query.device_id).to.equal("recording-tester");
        expect(Number(chunk.query.ct1)).to.be.at.least(Number(chunk.query.ct0));
        expect(chunk.chunkPart).to.equal(true);
        expect(chunk.meta.format).to.equal("cly-wire/1");
        expect(chunk.meta.recorder.name).to.equal("countly-wire");
        expect(chunk.meta.platform).to.equal("web");
        expect(chunk.meta.screen.w).to.be.above(0);
    });
    // the chunks follow each other
    for (var i = 1; i < chunks.length; i++) {
        expect(Number(chunks[i].query.ct0)).to.be.at.least(Number(chunks[i - 1].query.ct0));
    }
}

/**
 * The events the SDK queued for sending, from every request in its queue
 * @returns {Cypress.Chainable<Array>} [{event, rsid}]
 */
function queuedEvents() {
    return cy.fetch_local_request_queue().then((rq) => {
        var out = [];
        rq.filter((r) => r.events).forEach((r) => {
            JSON.parse(r.events).forEach((event) => {
                out.push({ event: event, rsid: r.rsid });
            });
        });
        return out;
    });
}

/**
 * Opens the page that loads the module before init and tracks its view right after init
 * (fixtures/recording_before_init.html), from a clean storage
 * @param {Object} conf - merged into the init config
 * @param {Object} opts - {consent: give the session_replay consent, late: keep the server's settings back}
 */
function openBeforeInit(conf, opts) {
    var query = "?c=" + encodeURIComponent(JSON.stringify(conf || {})) + (opts.consent ? "&consent=1" : "") + (opts.late ? "&sc=late" : "");
    hp.haltAndClearStorage(() => {
        cy.visit("./cypress/fixtures/recording_before_init.html" + query);
    });
    cy.window().its("Countly.recording.version").should("equal", "0.1.0");
}

/**
 * Delivers server settings to the page as a later answer would arrive (through the stored config)
 * @param {Object} c - the settings
 */
function deliverServerSettings(c) {
    cy.window().then((win) => {
        var key = hp.appKey + "/cly_config";
        var value = JSON.stringify({ v: 2, t: Date.now(), c: c });
        win.localStorage.setItem(key, value);
        win.dispatchEvent(new win.StorageEvent("storage", { key: key, newValue: value }));
    });
}

/**
 * The page's view from the request queue, once the SDK turned it into a request
 * @param {string} name - the view's name
 * @returns {Cypress.Chainable<Object>} {event, rsid}
 */
function queuedView(name) {
    cy.wait(1500);
    return queuedEvents().then((events) => {
        var view = events.find((e) => e.event.key === "[CLY]_view" && e.event.segmentation && e.event.segmentation.name === name);
        expect(view, "the view " + name).to.exist;
        return view;
    });
}

describe("Session Replay recording", () => {
    beforeEach(() => {
        // the crash test's error is for the SDK to report, not a failure of the test
        cy.on("uncaught:exception", () => false);
    });

    it("records nothing and stamps no stream without the session_replay consent, even with require_consent off", () => {
        var uploads = acceptUploads();
        openPage(uploads, { recording: { keyframeInterval: 2, after: 1 } }, false);
        cy.window().then((win) => {
            expect(win.Countly.recording.status().buffering).to.equal(false);
            expect(win.Countly.recording.send({ reason: "tests", after: 1 })).to.equal(null);
            win.Countly.add_event({ key: "without_consent" });
        });
        cy.wait(3000).then(() => {
            expect(uploads).to.have.length(0);
        });
        queuedEvents().then((events) => {
            var sent = events.find((e) => e.event.key === "without_consent");
            expect(sent, "the event").to.exist;
            expect(sent.rsid).to.equal(undefined);
            expect(events.some((e) => e.event.key === "[CLY]_recording_start")).to.equal(false);
        });
    });

    it("with the consent, stamps the tab's stream on its requests, and send() uploads the seconds before it and after", () => {
        var uploads = acceptUploads();
        var rid = null;
        var stream = null;
        openPage(uploads, { recording: { keyframeInterval: 2, after: 1 } }, true);
        cy.window().its("Countly.recording").invoke("status").its("buffering").should("equal", true);
        cy.window().then((win) => {
            stream = win.sessionStorage.getItem("cly_rsid");
            expect(stream).to.match(/^s[0-9a-f]{24}$/);
            win.Countly.add_event({ key: "with_consent" });
        });
        // a sealed chunk in the buffer: the recording starts before send()
        cy.wait(2500);
        cy.window().then((win) => {
            rid = win.Countly.recording.send({ reason: "tests", after: 1 });
            expect(rid).to.match(/^r[0-9a-f]{24}$/);
        });
        recordingUploads(uploads, () => rid).then((chunks) => {
            checkChunks(chunks, stream);
            var meta = chunks[0].meta;
            expect(meta.kind).to.equal("triggered");
            expect(meta.trigger.type).to.equal("api");
            expect(meta.trigger.key).to.equal("tests");
            expect(meta.t0).to.equal(Number(chunks[0].query.ct0));
            // the buffer: it starts before the trigger
            expect(meta.trigger.ts - meta.t0).to.be.above(1000);
            expect(meta.study).to.equal(undefined);
        });
        queuedEvents().then((events) => {
            expect(events.find((e) => e.event.key === "with_consent").rsid).to.equal(stream);
            var start = events.find((e) => e.event.key === "[CLY]_recording_start");
            expect(start, "the recording's start event").to.exist;
            expect(start.event.segmentation).to.include({ rid: rid, kind: "triggered", trigger: "api", trigger_key: "tests", fmt: "cly-wire/1" });
            expect(start.rsid).to.equal(stream);
        });
    });

    it("an uncaught error starts a crash recording with the seconds before it", () => {
        var uploads = acceptUploads();
        var stream = null;
        openPage(uploads, { recording: { keyframeInterval: 2, after: 1 } }, true);
        cy.window().its("Countly.recording").invoke("status").its("buffering").should("equal", true);
        cy.wait(2500);
        cy.window().then((win) => {
            stream = win.sessionStorage.getItem("cly_rsid");
            win.eval("setTimeout(function () { throw new Error('recording test crash'); }, 0);");
        });
        cy.window().its("Countly.recording").invoke("status").its("lastRid").should("match", /^r[0-9a-f]{24}$/);
        cy.window().then((win) => {
            var rid = win.Countly.recording.status().lastRid;
            recordingUploads(uploads, () => rid).then((chunks) => {
                checkChunks(chunks, stream);
                expect(chunks[0].meta.trigger).to.include({ type: "crash", key: "fatal" });
                expect(chunks[0].meta.trigger.ts - chunks[0].meta.t0).to.be.above(1000);
            });
        });
        // the crash itself carries the stream, so the dashboard finds its recording
        cy.fetch_local_request_queue().then((rq) => {
            var crash = rq.find((r) => r.crash && JSON.parse(r.crash)._error.indexOf("recording test crash") !== -1);
            expect(crash, "the crash request").to.exist;
            expect(crash.rsid).to.equal(stream);
        });
    });

    it("an event trigger the server set starts a recording for that event when its segments match, and not for others", () => {
        var uploads = acceptUploads();
        var trigger = { key: "checkout_failed", sg: { amount: { $gt: 100 } } };
        openPage(uploads, { recording: { keyframeInterval: 2, after: 1 }, behavior_settings: { c: { rec_te: [trigger] } } }, true);
        cy.window().its("Countly.recording").invoke("status").its("buffering").should("equal", true);
        cy.window().then((win) => {
            win.Countly.add_event({ key: "another_event" });
            win.Countly.add_event({ key: "checkout_failed", segmentation: { amount: 50 } });
        });
        cy.wait(2500).then(() => {
            expect(uploads, "no recording for the events that do not match").to.have.length(0);
        });
        cy.window().then((win) => {
            expect(win.Countly.recording.status().lastRid).to.equal(null);
            win.Countly.add_event({ key: "checkout_failed", segmentation: { amount: 150 } });
            var rid = win.Countly.recording.status().lastRid;
            expect(rid).to.match(/^r[0-9a-f]{24}$/);
            recordingUploads(uploads, () => rid).then((chunks) => {
                expect(chunks[0].meta.trigger).to.include({ type: "event", key: "checkout_failed" });
                expect(uploads.every((u) => u.query.rid === rid), "the only recording").to.equal(true);
            });
        });
    });

    it("a study the server answered streams the visit as study recordings, and stop() sends its last chunk", () => {
        var uploads = acceptUploads();
        var study = { id: "study_e2e", until: Date.now() + 3600000, md: 600, idle: 300, ia: false, av: false };
        var stream = null;
        var rid = null;
        // the triggered buffer is off (rec: false): only the study records
        openPage(uploads, { recording: { keyframeInterval: 2 }, behavior_settings: { c: { rec: false, rec_st: study } } }, true);
        cy.window().its("Countly.recording").invoke("status").its("study.id").should("equal", "study_e2e");
        cy.window().then((win) => {
            var status = win.Countly.recording.status();
            expect(status.buffering).to.equal(false);
            rid = status.study.rid;
            stream = win.sessionStorage.getItem("cly_rsid");
        });
        // streamed as it records: a chunk arrives before the visit ends
        cy.wrap(null, { timeout: 10000 }).should(() => {
            expect(uploads.some((u) => u.query.rid === rid && u.query.final === "0")).to.equal(true);
        });
        cy.window().then((win) => {
            win.Countly.recording.stop();
            expect(win.Countly.recording.status().study).to.equal(null);
        });
        recordingUploads(uploads, () => rid).then((chunks) => {
            expect(chunks.length).to.be.at.least(2);
            checkChunks(chunks, stream);
            chunks.forEach((chunk) => {
                expect(chunk.meta.kind).to.equal("study");
                expect(chunk.meta.study).to.equal("study_e2e");
                expect(chunk.meta.trigger).to.equal(undefined);
            });
        });
        queuedEvents().then((events) => {
            var start = events.find((e) => e.event.key === "[CLY]_recording_start");
            expect(start.event.segmentation).to.include({ rid: rid, kind: "study", study: "study_e2e" });
        });
    });

    it("withdrawing the consent stops recording, and the tab's later requests carry no stream", () => {
        var uploads = acceptUploads();
        openPage(uploads, { recording: { keyframeInterval: 2, after: 1 } }, true);
        cy.window().its("Countly.recording").invoke("status").its("buffering").should("equal", true);
        cy.window().then((win) => {
            win.Countly.remove_consent(["session_replay"]);
            var status = win.Countly.recording.status();
            expect(status.buffering).to.equal(false);
            expect(status.bufferedMs).to.equal(0);
            expect(win.Countly.recording.send({ reason: "tests", after: 1 })).to.equal(null);
            win.Countly.add_event({ key: "after_withdrawal" });
        });
        cy.wait(3000).then(() => {
            expect(uploads).to.have.length(0);
        });
        queuedEvents().then((events) => {
            expect(events.find((e) => e.event.key === "after_withdrawal").rsid).to.equal(undefined);
        });
    });
    describe("loaded before init", () => {
        it("attaches during init, so the page's first view carries the tab's stream", () => {
            var uploads = acceptUploads();
            openBeforeInit({ recording: { keyframeInterval: 2 } }, { consent: true });
            cy.window().its("Countly.recording").invoke("status").its("buffering").should("equal", true);
            queuedView("landing").then((view) => {
                cy.window().then((win) => {
                    var stream = win.sessionStorage.getItem("cly_rsid");
                    expect(stream).to.match(/^s[0-9a-f]{24}$/);
                    expect(view.rsid).to.equal(stream);
                });
            });
            cy.wrap(uploads).should("have.length", 0);
        });

        it("before the server's settings arrive, the first view carries the stream, and a study they start records on it", () => {
            var uploads = acceptUploads();
            var study = { id: "study_late", until: Date.now() + 3600000, md: 600, idle: 300, ia: false, av: false };
            var stream = null;
            // the page's own settings record nothing: only the server's later answer does
            openBeforeInit({ recording: { enabled: false, keyframeInterval: 2 } }, { consent: true, late: true });
            cy.window().its("Countly.recording").invoke("status").its("buffering").should("equal", false);
            queuedView("landing").then((view) => {
                cy.window().then((win) => {
                    stream = win.sessionStorage.getItem("cly_rsid");
                    expect(view.rsid, "the first view, before any setting").to.equal(stream);
                    expect(win.Countly.recording.status().study).to.equal(null);
                });
            });
            deliverServerSettings({ rec: false, rec_st: study });
            cy.window().its("Countly.recording").invoke("status").its("study.id").should("equal", "study_late");
            cy.wrap(null, { timeout: 10000 }).should(() => {
                var chunk = uploads.find((u) => u.meta && u.meta.study === "study_late");
                expect(chunk, "a chunk of the study recording").to.exist;
                expect(chunk.query.stream).to.equal(stream);
            });
            cy.window().then((win) => {
                win.Countly.add_event({ key: "while_recording" });
            });
            // the heartbeat turns the event into a request
            cy.wait(1500);
            queuedEvents().then((events) => {
                expect(events.find((e) => e.event.key === "while_recording").rsid).to.equal(stream);
            });
            cy.window().then((win) => {
                win.Countly.recording.stop();
            });
        });

        it("when the server's settings record nothing, the requests after them carry no stream", () => {
            var uploads = acceptUploads();
            openBeforeInit({ recording: { enabled: false } }, { consent: true, late: true });
            queuedView("landing").then((view) => {
                expect(view.rsid, "the first view, before the settings").to.match(/^s[0-9a-f]{24}$/);
            });
            deliverServerSettings({ rec: false });
            cy.window().then((win) => {
                expect(win.Countly.recording.status().buffering).to.equal(false);
                win.Countly.add_event({ key: "after_settings" });
            });
            cy.wait(1500);
            queuedEvents().then((events) => {
                expect(events.find((e) => e.event.key === "after_settings").rsid).to.equal(undefined);
            });
            cy.wrap(uploads).should("have.length", 0);
        });
    });
});
