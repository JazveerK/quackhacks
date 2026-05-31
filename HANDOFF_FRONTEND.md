# SteadyPT — Frontend Handoff

This doc is everything you need to build the dashboard (and later the PT view,
voice playback, Gemini debrief, and BigQuery writes) against the existing
backend. The backend is locked — its WebSocket contract is the boundary
between us.

You are **Agent C** in the project brief (UI / dashboard + voice + Gemini +
BigQuery). I am **Agent B** (pose tracking + fusion + rep state machine).

---

## TL;DR

- Backend = Python (FastAPI + MediaPipe + OpenCV) running locally.
- One WebSocket: `ws://127.0.0.1:8000/ws`. JSON-only.
- Three message types from server: `frame`, `state`, `set_end`.
- Two commands from client: `end_set`, `reset_set`.
- There's a placeholder dashboard at `static/index.html` you can rip out or
  start from.
- You can mock the entire backend without a webcam (see "Dev without backend"
  at the bottom).

---

## Repo layout

```
.
├── pose_tracker.py     # Agent B — MediaPipe pose, fusion, rep state machine.
├── server.py           # Agent B — FastAPI WS server. DO NOT add Gemini/BQ here.
├── run.py              # Launcher (handles macOS camera permission).
├── smoke.py            # Backend unit tests (rep counter).
├── requirements.txt
├── static/
│   └── index.html      # Placeholder dashboard — replace this.
└── HANDOFF_FRONTEND.md # This file.
```

Anything UI / voice / LLM / BigQuery goes in your own files. Keep them out of
`pose_tracker.py` and `server.py`. If you need a hook on the backend (e.g.
"call my Gemini wrapper at set end"), ping me — I'll add an injectable
callback, you implement the body.

---

## Running the backend

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run.py
# open http://127.0.0.1:8000
```

On macOS the first run will trigger a camera permission dialog — accept it.

Env overrides:
- `PF_PORT=9000` change port (default 8000)
- `PF_CAMERA=1` use a different webcam index
- `PF_REP_TARGET=5` shorter sets for testing

---

## WebSocket contract

### URL
```
ws://127.0.0.1:8000/ws
```
All messages are JSON text frames.

### Server → client (5 message types)

**1. `frame`** — JPEG of the camera with skeleton already drawn on top.
Roughly 20-30/s.
```json
{
  "type": "frame",
  "jpeg": "<base64-encoded JPEG bytes>"
}
```
Render with `<img src="data:image/jpeg;base64,…">` or paint into a canvas.

**2. `state`** — per-frame session state (the "data contract 4c" from the
brief). Roughly 20-30/s. Throttle in your UI if needed.
```json
{
  "type": "state",
  "state": {
    "phase": "SET_ACTIVE",
    "angle": 92.4,
    "rep_count": 7,
    "rep_target": 10,
    "rom_min": 88.0,
    "rom_max": 172.0,
    "depth_state": "below_parallel",
    "form_flags": ["too_fast"],
    "tempo": 1.8,
    "imu_quality": 0.96,
    "landmark_visibility": 0.41,
    "tracking_source": "camera",
    "rep_depths": [95, 93, 90, 89, 92, 94, 91],
    "setup_status": {
      "ok": true,
      "severity": "good",
      "code": "ok",
      "hint": "Tracking — go."
    },
    "profile": {
      "patient_name": "Sam",
      "condition": "post-ACL repair, left knee, 6 weeks",
      "sets": 3, "reps_per_set": 8,
      "depth_deg": 100.0, "tempo_sec": 3.0,
      "focus": "controlled eccentric; quad re-engagement",
      "contraindications": ["no valgus collapse", "no pain in L knee"],
      "source": "default"
    }
  }
}
```

`setup_status` is described in detail below — it's the camera-positioning
guidance for the user. `profile` is the active PT prescription (defaults to
Sam) — display patient_name + reps_per_set + depth_deg somewhere on the
dashboard so the upload feature is visible.

**3. `set_end`** — fires exactly once per set, just after `phase` flips to
`SET_END`. Includes the original 4d contract, the rich `analysis` sub-object,
the `templated_debrief` fallback, the active `profile`, and an `ai_debrief`
slot which is initially `null`. **The actual AI debrief arrives in a separate
`ai_debrief` follow-up message ~1–3s later** (see message type 4 below) so
the frame loop never blocks on the Gemini call.
```json
{
  "type": "set_end",
  "summary": {
    "exercise": "bodyweight_squat",
    "reps_completed": 10,
    "rep_target": 10,
    "rep_depths_deg": [95, 92, 90, 96, 101, 104, 92, 88, 95, 99],
    "target_depth_deg": 95,
    "depth_trend": "declining_late",
    "form_flag_counts": {"shallow": 4, "too_fast": 3},
    "fatigue_signal": "depth_decline",
    "analysis": { /* see below */ },
    "templated_debrief": "Completed 10 of 10 reps. Average depth 95° (70% at target)...",
    "profile": { /* same shape as the profile block in state */ },
    "ai_debrief": null
  }
}
```

**4. `ai_debrief`** — async follow-up to the most recent `set_end`. Arrives
1–3 seconds after `set_end`. UI shows `templated_debrief` immediately on
set_end, then swaps to (or augments with) this when it arrives. Never
arrives if Gemini is unavailable or errors — keep `templated_debrief` as
the always-on display.
```json
{
  "type": "ai_debrief",
  "text": "Nice work Sam. You hit depth on 5 of 8 reps...",
  "summary_seq": 2
}
```
`summary_seq` ties the debrief to the set that produced it so a stale
in-flight debrief from a previous set can't overwrite the current one.

**5. `profile`** — broadcast whenever the active PT profile changes (initial
default on connect, after a PT prescription upload, after a `reset_set`
applies a queued profile). Update any "current prescription" panel on the
dashboard.
```json
{
  "type": "profile",
  "profile": { "patient_name": "Sam", "reps_per_set": 8, "depth_deg": 100.0, ... },
  "source": "default" | "uploaded" | "parsed"
}
```

When you connect, the server also sends the last cached `frame`, `profile`,
`state`, `set_end`, and `ai_debrief` immediately so a fresh client isn't blank.

### Client → server (commands)

**End the current set early** (manual safety net):
```json
{"cmd": "end_set"}
```
Backend flips `phase` to `SET_END` and emits the `set_end` summary; the
`ai_debrief` follow-up arrives 1–3s later (or never if Gemini is down).

**Start a new set** (also resets ROM, flags, counters):
```json
{"cmd": "reset_set", "rep_target": 10}
```
`rep_target` is optional; omit to use the active profile's prescribed reps.
On reset, any pending profile (queued from a prescription upload) is applied
and a fresh `profile` message is broadcast.

That's the WS command surface. If you need more, ask.

### HTTP — `POST /profile/upload`

The PT pastes a free-form prescription text; backend parses with Gemini
Flash and applies it as the active profile. **Strongest demo moment:**
add a textarea + Submit button on the dashboard, render the parsed numbers
appearing in the rep counter / depth gauge / banner.

Request:
```http
POST /profile/upload
content-type: application/json

{
  "text": "3 sets of 8 squats at 100 degrees depth, slow tempo, no valgus collapse. Patient: Sam, 6 weeks post L-knee ACL repair."
}
```

Success (200) returns the parsed profile:
```json
{
  "profile": {
    "patient_name": "Sam",
    "condition": "post-ACL repair, L knee, 6 weeks",
    "sets": 3, "reps_per_set": 8,
    "depth_deg": 100.0, "tempo_sec": 3.0,
    "focus": "...", "contraindications": ["no valgus collapse"],
    "source": "parsed"
  },
  "source": "uploaded"
}
```

Errors:
- 400 — empty text
- 502 — Gemini not available (missing key, API error). Show the user a
  friendly "couldn't parse — try editing the text" message; the previous
  profile stays active.

After a successful upload, the backend also broadcasts a `profile` WS
message so all clients update their displays. No need to refetch.

### HTTP — `GET /profile`

Returns the current active profile (same shape as the WS `profile` message).
Useful for an initial fetch if you don't want to wait for the WS replay.

### HTTP — `GET /session`

Live session metadata + in-memory list of this session's set summaries
(no BigQuery read-after-write delay). Useful for the live debrief panel
and any "session so far" display.

Response:
```json
{
  "session_id": "537e48b1",
  "user_id": "demo_user",
  "started_at": "2026-05-30T20:00:00+00:00",
  "sets_count": 2,
  "set_index": 2,
  "summaries": [/* full per-set 4d summary objects, oldest first */],
  "bq_available": true,
  "gemini_available": true
}
```

### HTTP — `POST /session/end`

Finalizes the current session: writes the `sessions` row to BigQuery,
calls Gemini for a PT-facing progress report (clinical voice, audience
is the clinician), then rotates to a fresh session_id so subsequent sets
start clean.

Response:
```json
{
  "session_id": "537e48b1",
  "user_id": "demo_user",
  "sets_count": 3,
  "total_reps": 22,
  "avg_depth": 96.4,
  "adherence_flag": "complete" | "partial",
  "report": "Sam completed 3 sets of bodyweight squats today. Depth held in the first two sets and softened in the third...",
}
```

`report` is null if Gemini is unavailable. Safe to call with zero sets —
returns `report: null, reason: "no sets in this session"` and rotates the
session_id.

### HTTP — `GET /sets/recent?limit=50`

PT view trends. Returns the most recent N rows from the BigQuery `sets`
table across all sessions, latest first.

Response:
```json
{
  "rows": [
    {
      "session_id": "537e48b1", "set_index": 3,
      "reps": 6, "avg_depth_deg": 96.4, "min_depth_deg": 92,
      "fatigue_score": 0.5,
      "debrief_text": "...",
      "recommended_next": "drop 2 reps; focus depth"
    },
    ...
  ],
  "bq_available": true
}
```
Returns an empty `rows` list if BQ isn't configured — fall back to
`/session.summaries` for the live demo.

### Auth notes for whoever runs the server

`GEMINI_API_KEY` is required for the AI debrief + prescription parse +
session report. Set it in the environment of the process running `run.py`.

For BigQuery on a laptop (not Cloud Shell), run once:
```
gcloud auth application-default login
```
Then `bigquery.Client()` finds the project. The dataset is
`PF_BQ_DATASET` (default `physiofusion`) — change via env if needed.

`GET /session` exposes `bq_available` and `gemini_available` booleans so
the UI can show a corner badge ("Google services: connected").

---

## Field semantics (the tricky bits)

| Field | Range / values | Notes |
|---|---|---|
| `phase` | `SET_ACTIVE` / `SET_END` / `DEBRIEF` / `REST` | After `set_end` fires, phase stays `DEBRIEF` until you send `reset_set`. |
| `angle` | ~60-180 (degrees) | Knee angle (hip-knee-ankle). 180 = standing, 90 = parallel. **EMA-smoothed**, not raw. |
| `rep_count` | int >= 0 | Only advances on real reps (debounced, source-gated, tempo-validated). |
| `rep_target` | int | Whatever was set via `reset_set` or `PF_REP_TARGET`. |
| `rom_min` / `rom_max` | degrees | Lifetime min/max angle for the current set. |
| `depth_state` | `below_parallel` / `at_parallel` / `shallow` | Computed against the current rep's min angle while descending, else against the live angle. |
| `form_flags` | `[]` / `["shallow"]` / `["too_fast"]` / both | Flags stick for ~2.5s so the UI has time to show them. |
| `tempo` | seconds | Duration of the last completed rep. `0` until first rep. |
| `imu_quality` | 0..1 | From the IMU (currently MockIMU = 0.95). |
| `landmark_visibility` | 0..1 | Avg visibility of hip/knee/ankle on the chosen leg. |
| `tracking_source` | `"camera"` / `"imu"` / `"none"` | **THIS IS THE MONEY SHOT.** When the camera loses the leg, this flips to `"imu"` and the depth gauge keeps tracking. `"none"` only appears in degraded states (no IMU sample AND no pose detected); treat it the same as "no data" — `angle` will be 0 in that case. Make the camera↔IMU flip visually obvious. |
| `rep_depths` | array of degrees | Min angle per completed rep. Use this for the per-rep bar chart. |

### Camera setup status (`setup_status`)

Backend emits a status object every frame so the UI can coach the user into
the right framing before/during the set. **You don't need to block the rep
counter or hide the dashboard on a bad status — just surface the hint.**

```ts
type SetupSeverity = "good" | "info" | "warning" | "blocking";
interface SetupStatus {
  ok: boolean;
  severity: SetupSeverity;
  code: SetupCode;
  hint: string;        // human-readable, short, ready to display verbatim
}
type SetupCode =
  | "ok"                    // we're tracking cleanly
  | "starting"              // very first frames, before any state has arrived
  | "searching"             // pose was visible recently, looking for it again
  | "no_person"             // no pose detected for ~2s
  | "legs_out_of_frame"     // torso visible but legs cut off / occluded
  | "torso_out_of_frame"    // legs visible but shoulders cut off
  | "partial_body"          // neither half is solidly visible
  | "not_side_view"         // pose detected but person is facing the camera
  | "low_visibility"        // pose detected but landmarks unreliable (lighting, etc.)
  | "camera_stale";         // OS isn't delivering frames (disconnected?)
```

Suggested UI mapping:
| Severity | Visual treatment |
|---|---|
| `good` | Green checkmark / nothing |
| `info` | Subtle gray hint ("Looking for you...") |
| `warning` | Yellow banner with the `hint` text |
| `blocking` | Red full-width banner with the `hint`; dim or hide the rep counter |

Use `code` for icon mapping (stable, machine-readable); use `hint` for the
visible label. Don't compose your own hint strings — they may evolve on the
backend.

### Fusion behavior you can rely on
- `tracking_source = "camera"` only when avg leg visibility >= 0.6 **and** every
  individual leg landmark >= 0.4.
- `tracking_source = "imu"` otherwise (occlusion, person stepped out, low light).
- **Reps are only counted from camera-sourced angles.** You won't see
  `rep_count` increment while `tracking_source == "imu"`.
- When the source flips, the EMA + debounce resets to avoid a phantom rep
  from the angle step.

### Set-end triggers (any one fires it)
1. `rep_count >= rep_target`.
2. ~4 seconds of standing still after at least 1 rep.
3. Client sent `{"cmd": "end_set"}`.

### Form-cue mapping (suggested UI labels)
| Flag | Suggested label | Suggested pre-recorded clip |
|---|---|---|
| `shallow` | "Go deeper" | `go_deeper.mp3` |
| `too_fast` | "Slow it down" | `slow_down.mp3` |

These are the only two form flags shipped (scope discipline from the brief).
Don't invent new ones in the UI — they'll never fire.

---

## Set-end summary detail (what to feed Gemini)

The top-level keys haven't changed. We added a rich `analysis` sub-object plus
a `templated_debrief` string. Feed the **whole summary** to the agent; the
analysis is where the PT-relevant signal lives.

Full shape:

```json
{
  "exercise": "bodyweight_squat",
  "reps_completed": 10,
  "rep_target": 10,
  "rep_depths_deg": [95, 92, 90, ...],
  "target_depth_deg": 95,
  "depth_trend": "declining_late",
  "form_flag_counts": {"shallow": 4, "too_fast": 3},
  "fatigue_signal": "depth_decline",

  "analysis": {
    "set_duration_sec": 41.2,
    "voided_reps": 1,

    "depth": {
      "per_rep_deg": [95, 92, 90, 96, 101, 104, 92, 88, 95, 99],
      "mean_deg": 95.2,
      "stddev_deg": 4.8,
      "min_deg": 88,
      "max_deg": 104,
      "target_deg": 95,
      "reps_at_or_below_target": 7,
      "target_hit_rate": 0.7,
      "trend": "declining_late",      // "improving" | "consistent" | "declining_late" | "insufficient_data"
      "first_half_avg_deg": 92.6,
      "second_half_avg_deg": 97.8,
      "halves_delta_deg": 5.2
    },

    "tempo": {
      "per_rep_sec": [2.1, 1.9, 2.2, ...],
      "eccentric_per_rep_sec": [1.0, 0.9, 1.1, ...],   // descent time
      "concentric_per_rep_sec": [1.1, 1.0, 1.1, ...],  // ascent + bottom hold
      "mean_sec": 2.0,
      "stddev_sec": 0.3,
      "trend": "slowing_down",     // "speeding_up" | "consistent" | "slowing_down" | "insufficient_data"
      "halves_delta_sec": 0.4,
      "eccentric_concentric_ratio_mean": 0.91
    },

    "rom": {"min_deg": 88, "max_deg": 175},

    "form": {
      "flag_counts": {"shallow": 4, "too_fast": 3},
      "shallow_rep_indices": [5, 6, 9, 10],   // 1-based
      "fast_rep_indices": [1, 2, 8],
      "notes": [                              // human-readable bullets
        "Average knee angle at bottom was 95° (target 95°).",
        "70% of reps reached the target depth (7 of 10).",
        "Depth got shallower by ~5° between the first and second half — late-set fatigue pattern.",
        "4 rep(s) above parallel: rep 5, 6, 9, 10.",
        "Average rep tempo was 2.0s.",
        "Reps slowed by ~0.4s late in the set (potential fatigue)."
      ]
    },

    "tracking": {
      "camera_frame_ratio": 0.92,
      "imu_frame_ratio": 0.08,
      "occlusion_events": 2
    }
  },

  "templated_debrief": "Completed 10 of 10 reps. Average depth 95° (70% at target 95°). Depth dropped off in the second half — classic late-set fatigue. Next set, drop the target by 2 reps and focus on hitting depth on every one."
}
```

### How to use this with Gemini

**Suggested prompt** (replace the bracketed bits):

> You are a supportive PT exercise coach. You do not diagnose conditions or
> prescribe medical treatment — you coach form and range of motion based on
> what the sensors saw. Given this completed bodyweight-squat set as JSON,
> give:
> 1. A 2-3 sentence spoken debrief that references the *specific numbers*
>    (mean depth, hit rate, trend, tempo if relevant).
> 2. One concrete next-set adjustment: change reps, depth focus, or tempo.
> Be concise, conversational, and specific. Avoid medical language.
>
> SET SUMMARY:
> {JSON}

Lean on these fields specifically — they're the ones a PT will look at:
- `analysis.depth.target_hit_rate` — "you hit depth on 7/10".
- `analysis.depth.halves_delta_deg` + `trend` — late-set fatigue signal.
- `analysis.tempo.eccentric_concentric_ratio_mean` — descent vs ascent control.
  PT norm is ~1.0; <0.7 means the descent is too fast.
- `analysis.tempo.trend` — slowing/speeding up across the set.
- `analysis.form.shallow_rep_indices` / `fast_rep_indices` — call out *which*
  reps had issues.
- `analysis.tracking.camera_frame_ratio` — if low, mention framing/lighting.
- `voided_reps` — if > 0, mention that we didn't count some attempts and why.

### Fallback (Gemini error or rate-limited)

If your Gemini call fails, show `templated_debrief` verbatim. It's a
rule-based one-paragraph summary, written in the same tone, and references
the same numbers — so the UX degrades gracefully. The brief calls for this
explicitly under section 8 ("Rule loop works without the agent").

---

## TypeScript types (copy into your codebase)

```ts
export type Phase = "SET_ACTIVE" | "SET_END" | "DEBRIEF" | "REST";
export type DepthState = "below_parallel" | "at_parallel" | "shallow";
export type TrackingSource = "camera" | "imu" | "none";
export type FormFlag = "shallow" | "too_fast";

export type SetupSeverity = "good" | "info" | "warning" | "blocking";
export type SetupCode =
  | "ok" | "starting" | "searching"
  | "no_person" | "legs_out_of_frame" | "torso_out_of_frame" | "partial_body"
  | "not_side_view" | "low_visibility" | "camera_stale";
export interface SetupStatus {
  ok: boolean;
  severity: SetupSeverity;
  code: SetupCode;
  hint: string;
}

export interface SessionState {
  phase: Phase;
  angle: number;
  rep_count: number;
  rep_target: number;
  rom_min: number;
  rom_max: number;
  depth_state: DepthState;
  form_flags: FormFlag[];
  tempo: number;
  imu_quality: number;
  landmark_visibility: number;
  tracking_source: TrackingSource;
  rep_depths: number[];
  setup_status: SetupStatus;
}

export type Trend2 = "consistent" | "declining_late";
export type DepthTrend =
  | "improving" | "consistent" | "declining_late" | "insufficient_data";
export type TempoTrend =
  | "speeding_up" | "consistent" | "slowing_down" | "insufficient_data";
export type FatigueSignal =
  | "none" | "depth_decline" | "tempo_decline" | "both";

export interface SetSummary {
  // Legacy 4d (unchanged shape).
  exercise: "bodyweight_squat";
  reps_completed: number;
  rep_target: number;
  rep_depths_deg: number[];
  target_depth_deg: number;
  depth_trend: Trend2;
  form_flag_counts: { shallow: number; too_fast: number };
  fatigue_signal: FatigueSignal;

  // New rich breakdown — feed this to the AI agent.
  analysis: {
    set_duration_sec: number;
    voided_reps: number;
    depth: {
      per_rep_deg: number[];
      mean_deg: number;
      stddev_deg: number;
      min_deg: number;
      max_deg: number;
      target_deg: number;
      reps_at_or_below_target: number;
      target_hit_rate: number;
      trend: DepthTrend;
      first_half_avg_deg: number | null;
      second_half_avg_deg: number | null;
      halves_delta_deg: number;
    };
    tempo: {
      per_rep_sec: number[];
      eccentric_per_rep_sec: number[];
      concentric_per_rep_sec: number[];
      mean_sec: number;
      stddev_sec: number;
      trend: TempoTrend;
      halves_delta_sec: number;
      eccentric_concentric_ratio_mean: number;
    };
    rom: { min_deg: number | null; max_deg: number | null };
    form: {
      flag_counts: { shallow: number; too_fast: number };
      shallow_rep_indices: number[];     // 1-based
      fast_rep_indices: number[];
      notes: string[];
    };
    tracking: {
      camera_frame_ratio: number;
      imu_frame_ratio: number;
      occlusion_events: number;
    };
  };

  // Rule-based fallback. Show verbatim if your Gemini call errors.
  templated_debrief: string;
}

export type ServerMsg =
  | { type: "frame"; jpeg: string }
  | { type: "state"; state: SessionState }
  | { type: "set_end"; summary: SetSummary };

export type ClientCmd =
  | { cmd: "end_set" }
  | { cmd: "reset_set"; rep_target?: number };
```

---

## What's yours to build (Agent C scope from the brief)

The brief gives you ownership of:

1. **Patient Live View** — camera feed + skeleton, big rep counter, depth gauge
   with a parallel marker, form-cue banner, **tracking-source panel that
   visibly flips camera↔imu**. (Last one is non-negotiable per the brief.)
2. **PT View** — ROM/adherence trends from BigQuery + a Gemini progress
   report.
3. **Between-set debrief modal** — typed + spoken Gemini debrief, per-rep
   depth bar chart, "Start next set" button (sends `reset_set`).
4. **Voice**:
   - Pre-generated ElevenLabs clips for `form_flags` (play in the browser when
     a flag appears).
   - Dynamic ElevenLabs synthesis of the Gemini debrief at set end.
5. **Gemini Flash** calls (debrief + end-of-session report). Prompt is in the
   brief.
6. **BigQuery** writes (`sets` at each set end, `sessions` at session end) and
   reads (PT view trends).

Backend is not going to call Gemini, BigQuery, or ElevenLabs. If you want
those wired into the WS stream, ping me and I'll add an injectable hook —
but the implementation lives in your code.

---

## Two ways to serve your UI

**Option A — replace `static/index.html`.** FastAPI serves whatever is in
that folder at `/static/*` and `index.html` at `/`. Drop a built bundle here
and you're done.

**Option B — separate Vite/React dev server.** Run your dev server on a
different port and connect to `ws://127.0.0.1:8000/ws` directly. Easiest for
hot reload. Configure CORS only if you start making HTTP calls; the WS works
cross-origin out of the box.

You can ignore the existing `static/index.html` entirely. It was a smoke-test
UI to verify the WS contract; it's not the design we want to ship.

---

## Dev without backend (and without webcam)

Recommended for early UI work. Two options:

**Option 1 — backend with MockIMU and no person in front of the camera.**
Just run `.venv/bin/python run.py`. With nobody in frame, you'll get a
steady stream of frames and `state` messages with `tracking_source="imu"`
and `rep_count=0`. Good for verifying the layout binds correctly. Use the
"End Set" button to fire a `set_end` summary on demand.

**Option 2 — pure mock WS server.** Drop in a small Node/Python script that
broadcasts synthetic `state` messages on the same `/ws` path. Lets you
develop the UI on a plane. Example skeleton:

```python
# mock_ws.py
import asyncio, json, math, time
import websockets

async def handler(ws):
    t0 = time.time()
    reps = 0
    while True:
        t = time.time() - t0
        # fake a rep every 4s
        angle = 130 + 45 * math.sin(t * (2 * math.pi / 4))
        if angle > 174:
            reps_now = int(t // 4)
            if reps_now > reps:
                reps = reps_now
        await ws.send(json.dumps({
            "type": "state",
            "state": {
                "phase": "SET_ACTIVE",
                "angle": angle, "rep_count": reps, "rep_target": 10,
                "rom_min": 88, "rom_max": 175,
                "depth_state": "below_parallel" if angle < 95 else "at_parallel" if angle < 100 else "shallow",
                "form_flags": [],
                "tempo": 3.2,
                "imu_quality": 0.95,
                "landmark_visibility": 0.85,
                "tracking_source": "camera" if int(t) % 12 < 9 else "imu",  # flips for the demo
                "rep_depths": [92] * reps,
            }
        }))
        await asyncio.sleep(1/20)

async def main():
    async with websockets.serve(handler, "127.0.0.1", 8000):
        await asyncio.Future()

asyncio.run(main())
```

The `tracking_source` line flips between `camera` and `imu` every few
seconds — use it to develop the money-shot panel without the real backend.

---

## Demo beats to design around (rubric: 24h, FAANG judges)

In order of priority:

1. **Live tracking visibly working** — skeleton lines + ticking rep counter.
2. **Occlusion handoff** — when the person steps out / camera is covered,
   `tracking_source` flips to `imu` and the depth gauge keeps moving. The
   tracking-source panel must make this *obvious*. This is the entire
   justification for the hardware.
3. **Agent debrief** — Gemini debrief modal + spoken voice at set end.

Anything that doesn't serve those three is stretch.

---

## Things to ask me about

- Need a new state field on the WS? — ask before duplicating logic on the
  client.
- Need a new command (e.g., `start_session`, `pause`)? — easy add, just ask.
- Need a backend hook for Gemini/ElevenLabs/BigQuery to fire at set end
  exclusively? — I'll wire a callback; you write the body.

Don't:
- Don't reach into `pose_tracker.py` or `server.py` to add LLM / BQ / voice
  code. Use the WS.
- Don't depend on undocumented fields. If a field isn't in the table above,
  it isn't part of the contract.
- Don't poll an HTTP endpoint. Everything is push over the WS.

— B
