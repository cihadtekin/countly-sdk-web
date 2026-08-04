# Countly Session Replay (rrweb) — Web SDK plugin

Opt-in plugin that records the page DOM and interactions on the end-user's
device with [rrweb](https://github.com/rrweb-io/rrweb), keeps a short **rolling
window** of the most recent activity in memory, and ships that window to the
Countly server only when the integration asks for it. Recording never happens on
Countly — the server only ingests, stores, and replays.

## Files

| File | What it is |
|------|------------|
| `countly_session_replay.js` | The Countly integration source (hand-written, reviewable). Reads `window.rrweb`. |
| `rrweb.min.js` | Vendored, pinned rrweb **2.1.1** UMD build (sets `window.rrweb`). |
| `countly_session_replay.min.js` | Single-file distribution bundle = `rrweb.min.js` + integration, produced by `build.js`. |
| `build.js` | `node plugin/session-replay/build.js` — regenerates the bundle. |

## Integration

Two ways to include it, both after `countly.js`:

**Single bundle (recommended for customers):**

```html
<script src="countly.js"></script>
<script src="plugin/session-replay/countly_session_replay.min.js"></script>
```

**Separate files (handy during development):**

```html
<script src="countly.js"></script>
<script src="plugin/session-replay/rrweb.min.js"></script>
<script src="plugin/session-replay/countly_session_replay.js"></script>
```

## Usage

```js
Countly.init({ app_key: "YOUR_APP_KEY", url: "https://your-server" });

// Start capturing. Keeps a rolling in-memory window (30s default).
Countly.startSessionRecording();

// ...later, on a crash / rage-click / manual trigger...
Countly.sendSessionRecording();   // ships the current window to the server

Countly.stopSessionRecording();   // stop + clear the buffer
Countly.isSessionRecording();     // -> boolean
```

Async queue form works too:

```js
Countly.q.push(["startSessionRecording", { rollingWindowMs: 60000 }]);
Countly.q.push(["sendSessionRecording"]);
```

## Options (passed to `startSessionRecording`)

| Option | Default | Description |
|--------|---------|-------------|
| `rollingWindowMs` | `30000` | Rolling window length in ms. The main knob. |
| `maxEvents` | `10000` | Hard safety cap on buffered events. |
| `maskAllInputs` | `true` | Mask all input values (passwords, form fields). |
| `blockSelector` | `[data-countly-block], video, iframe, canvas` | Elements stored as opaque placeholders. |
| `maskTextSelector` | `[data-countly-mask]` | Layout kept, text content replaced. |
| `ignoreSelector` | `[data-countly-ignore]` | Interactions inside are not recorded. |
| `sampling` | `{ mousemove: 50 }` | rrweb sampling options. |
| `autoSendOnCrash` | `true` | Auto-send the current rolling window when a crash/error is recorded, with no `sendSessionRecording()` call. The crash and the recording are tagged with the same correlation id so they can be matched (see below). |

### Auto-send on crash

With `autoSendOnCrash` on (the default), the plugin wraps the SDK's crash path
(`recordError`, which every `track_errors` crash, unhandled rejection, and
`log_error` funnels through). When a crash is recorded it:

1. generates a correlation id,
2. adds it to the crash as a custom segment `cly_sr_crash_id`, and
3. ships the current rolling window with `trigger: "crash"` and `crash_id` set
   to the same id.

So a crash and the ~30s of session leading up to it carry a shared id, letting
the server match a replay to its crash. Turn it off with
`Countly.startSessionRecording({ autoSendOnCrash: false })`.

## Privacy

Masking/blocking is applied **at capture time**, before anything is buffered:

- all inputs and text are masked by default — raw values never leave the page;
- `[data-countly-mask]` keeps layout but replaces text;
- `[data-countly-block]` stores the element as an opaque placeholder;
- `[data-countly-ignore]` skips interactions inside;
- `video` / `iframe` / `canvas` are blocked;
- query strings and hashes are stripped from captured URLs (tokens never stored).

## Consent

Gated behind the `session-replay` consent feature. When `require_consent` is on:

```js
Countly.add_consent("session-replay");
```

## Payload & correlation (server side)

`sendSessionRecording()` gzip-compresses the events (browser `CompressionStream`,
base64; falls back to raw base64 when unavailable) and enqueues them as a
`session_recording` parameter on the standard `/i` request. Because it rides the
normal `/i` write pipeline, the server correlates each recording to the current
Countly session via `app_user.lsid` — the SDK does **not** send a session id.

Payload shape:

```json
{
  "rrweb_version": "2.1.1",
  "recorded_at": 1690000000000,
  "window_ms": 30000,
  "compressed": true,
  "data": "<base64 gzip of the rrweb events array>",
  "event_count": 42,
  "duration_ms": 29850,
  "pages": ["https://site/path"],
  "raw_bytes": 12345
}
```

## Updating the vendored rrweb

```bash
npm install --no-save --legacy-peer-deps rrweb@<version>
cp node_modules/rrweb/dist/rrweb.umd.min.cjs plugin/session-replay/rrweb.min.js
# bump RRWEB_VERSION in countly_session_replay.js, then:
node plugin/session-replay/build.js
```
