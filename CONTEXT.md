# PhysioFusion — Project Context (read this first, every agent)

You are one of three parallel agents building a hackathon project in 24 hours. This file is the
single source of truth. Do not invent architecture that contradicts it. If something here is
ambiguous, prefer the simplest thing that satisfies the data contracts in section 4, and leave a
clear TODO rather than guessing at another agent's component.

## 1. What we're building

An AI physical-therapy coach. A webcam + a thigh-mounted IMU track a person doing **bodyweight
squats**. During a set, a fast rule-based loop coaches the user by voice. At the end of each set,
an AI agent (Gemini) reasons over the whole set and speaks a debrief + a next-set recommendation.
A web dashboard shows it all live.

The signature feature ("money-shot") is **sensor fusion**: when the camera loses sight of the
thigh (occlusion / the person turns), the IMU keeps tracking the squat, and the dashboard visibly
shows the handoff from "camera" to "imu". This is the entire justification for the hardware.

Event: QuackHacks 3 (Univ. of Oregon, 24h, science-fair booth, FAANG engineer judges).
Rubric: Innovation, Technical Execution, Design & UX, Presentation.

## 2. Framing rule (never violate)

This is a coaching / tracking tool for exercises a PT prescribes. It does NOT diagnose and does
NOT prescribe medically. Language is always "measure range of motion and adherence, coach form",
never "detect injury / condition".

## 3. Locked decisions (do not re-litigate)

- Exercise: bodyweight squat, ONE exercise only.
- Camera: side view. IMU: MPU6050 on the mid-thigh.
- Backend: Python, runs locally on the laptop the Arduino is plugged into.
- Realtime to dashboard: FastAPI WebSocket (local).
- Data store: BigQuery (NOT Snowflake) — history + PT trends only.
- AI: Gemini Flash (`gemini-2.5-flash`) — end-of-set debrief + end-of-session PT report. Off the
  realtime path.
- Voice: ElevenLabs — pre-generated cue clips during the set, dynamic voice for the debrief.
- Coaching: fast rule loop DURING the set; AI agent AT THE END of the set.
- Google track = Gemini + BigQuery. Both already core; do not add scope to chase it.
- Live data lives in memory. BigQuery is only for cross-session history (its inserts can be
  briefly non-queryable, so never put it on the realtime loop).
- Physical hardware stays on the laptop. Do NOT move IMU/MediaPipe/fusion to the cloud.

## 4. DATA CONTRACTS (the most important section — all three agents depend on these)

### 4a. IMU serial line (Arduino prints, Python reads), 115200 baud, ~50-100 Hz
```
ax,ay,az,gx,gy,gz,t
```
floats; accel in g, gyro in deg/s, t = millis().

### 4b. IMU Python interface (Hardware agent implements, MediaPipe agent consumes)
A class with:
```python
def get_latest(self) -> dict | None:
    # returns {"tilt": float, "ang_vel": float, "smoothness": float,
    #          "t": float, "quality": float}  or None if no data yet
```
`tilt` = thigh angle from a complementary filter (the camera-independent depth signal).

### 4c. Per-frame session state (backend -> dashboard over WebSocket, JSON)
```json
{
  "phase": "SET_ACTIVE|SET_END|DEBRIEF|REST",
  "angle": 92.4,
  "rep_count": 7,
  "rep_target": 10,
  "rom_min": 88.0,
  "rom_max": 172.0,
  "depth_state": "below_parallel|at_parallel|shallow",
  "form_flags": ["too_fast"],
  "tempo": 1.8,
  "imu_quality": 0.96,
  "landmark_visibility": 0.41,
  "tracking_source": "camera|imu|none",
  "rep_depths": [95, 93, 90],
  "setup_status": {
    "ok": true,
    "severity": "good|info|warning|blocking",
    "code": "ok|starting|searching|no_person|legs_out_of_frame|torso_out_of_frame|partial_body|not_side_view|low_visibility|camera_stale",
    "hint": "Tracking — go."
  }
}
```

`setup_status` coaches the user into the right camera framing. `severity=blocking` means we
can't track at all; `warning` means tracking is degraded (front view, partial body); `good`
means we're tracking cleanly. See `HANDOFF_FRONTEND.md` for the full code table.

### 4d. Per-set summary (backend -> Gemini agent at set end, JSON)
Top-level keys are the original 4d contract. An `analysis` sub-object and a `templated_debrief`
fallback string were added so the Gemini agent has PT-relevant data to ground its feedback in.
```json
{
  "exercise": "bodyweight_squat",
  "reps_completed": 10,
  "rep_target": 10,
  "rep_depths_deg": [95, 92, 90, 96, 101, 104],
  "target_depth_deg": 95,
  "depth_trend": "declining_late|consistent",
  "form_flag_counts": {"shallow": 4, "too_fast": 3},
  "fatigue_signal": "none|depth_decline|tempo_decline|both",
  "analysis": {
    "set_duration_sec": 41.2,
    "voided_reps": 0,
    "depth": {
      "per_rep_deg": [...],
      "mean_deg": 92.3,
      "stddev_deg": 4.1,
      "min_deg": 87,
      "max_deg": 101,
      "target_deg": 95,
      "reps_at_or_below_target": 7,
      "target_hit_rate": 0.7,
      "trend": "improving|consistent|declining_late|insufficient_data",
      "first_half_avg_deg": 90.0,
      "second_half_avg_deg": 95.5,
      "halves_delta_deg": 5.5
    },
    "tempo": {
      "per_rep_sec": [...],
      "eccentric_per_rep_sec": [...],   // descent time
      "concentric_per_rep_sec": [...],  // ascent + bottom hold
      "mean_sec": 1.9,
      "stddev_sec": 0.3,
      "trend": "speeding_up|consistent|slowing_down|insufficient_data",
      "halves_delta_sec": 0.4,
      "eccentric_concentric_ratio_mean": 0.91
    },
    "rom": {"min_deg": 88, "max_deg": 175},
    "form": {
      "flag_counts": {"shallow": 4, "too_fast": 3},
      "shallow_rep_indices": [5, 6, 9, 10],
      "fast_rep_indices": [1, 2, 8],
      "notes": ["..."]
    },
    "tracking": {
      "camera_frame_ratio": 0.92,
      "imu_frame_ratio": 0.08,
      "occlusion_events": 2
    }
  },
  "templated_debrief": "Completed 10 of 10 reps. Average depth 95° (70% at target)..."
}
```

`templated_debrief` is the rule-based fallback the UI shows verbatim if the Gemini call errors
or times out (per reliability rule, section 8).

### 4e. BigQuery tables
- `sets(session_id, set_index, reps, avg_depth_deg, min_depth_deg, fatigue_score, debrief_text, recommended_next)`
- `sessions(session_id, user_id, exercise, started_at, sets_count, total_reps, avg_depth, adherence_flag)`
Write a `sets` row at each set end; a `sessions` row at session end. PT view reads these.

## 5. Components & ownership (one agent each)

### Agent A — Hardware (`imu.py`)
Arduino firmware that streams 4a. A Python `imu.py` implementing 4b: read serial on a background
thread, keep the latest sample, derive `tilt` (complementary filter:
`tilt = 0.98*(tilt + gyro*dt) + 0.02*accel_tilt`), `ang_vel`, `smoothness`. Provide a `MockIMU`
fallback that returns a steady healthy signal so others can run without hardware. Calibrate a
tilt->depth mapping (capture standing tilt and deep-squat tilt). Pins (Uno): VCC->5V, GND->GND,
SDA->A4, SCL->A5, 115200 baud. Library: Adafruit MPU6050.

(A `MockIMU` class is already provided in `pose_tracker.py` so the rest of the stack runs
without hardware. Agent A's real `IMU` class replaces it via constructor injection.)

### Agent B — Backend core (`pose_tracker.py`)
MediaPipe pose on the webcam (side view); knee angle from hip-knee-ankle; squat rep state machine
with debounce + EMA smoothing; ROM/form logic; the FUSION (camera angle when leg-landmark
visibility is solid, else IMU); the phase machine + set-end trigger (rep target OR ~4s stillness
OR manual button); per-rep timing decomposition (eccentric/concentric); camera setup detection;
rich 4d summary + templated debrief; emits 4c per frame via `on_state(state)`.

Exports `SquatTracker` (alias of `PoseTracker`), `run_camera(tracker, camera_index, side)`,
and `MockIMU` for `main.py` to wire up. Tests in `smoke.py` (60 assertions).

### Agent C — UI / dashboard + voice + Gemini + BigQuery (`server.py` + dashboard)
FastAPI server with a WebSocket. `server.py` exposes:
- `start_server()` — boots uvicorn in a background thread (non-blocking).
- `broadcast_state(state: dict)` — pushes per-frame state to all WS clients.
- `handle_set_end(summary: dict)` — calls Gemini (`gemini-2.5-flash`, key from `GEMINI_API_KEY`)
  for the debrief, writes to BigQuery, then broadcasts a `{"type":"debrief", ...}` message to
  the dashboard so the UI can show + speak it. Falls back to `summary.templated_debrief` if
  Gemini errors.

Two dashboard views:
- **(A) Patient Live View** — camera feed slot + big rep counter + depth gauge with parallel
  marker + form-cue banner + **tracking-source panel (the money-shot, must visibly flip
  camera↔imu)** + small tempo/quality readout.
- **(B) PT View** — ROM/adherence trends from BigQuery + a Gemini progress report.

Plus the between-set debrief transition (typed + spoken text + per-rep depth bars + "Start next
set"). Voice: pre-generated ElevenLabs clips on `form_flags`, dynamic voice for the debrief.

Build entirely against `mock_state.py` first — the dashboard must look correct before the
backend is wired in.

## 6. Coaching detail

- Fast cues (pre-generate as audio up front): "go deeper", "good depth", "two more", "last one",
  "slow it down", "nice control". Triggered by `form_flags`/rep milestones. NEVER call the LLM here.
- End-of-set agent prompt: "You are a supportive PT exercise coach (not a doctor, never diagnose).
  Given this completed squat set as JSON, give (1) a 2-3 sentence spoken debrief, (2) one concrete
  next-set adjustment (reps/depth/tempo). Be concise, specific to the numbers, plain language.
  SET: {per_set_summary}"

  Lean on `analysis.depth.target_hit_rate`, `analysis.depth.halves_delta_deg`,
  `analysis.tempo.eccentric_concentric_ratio_mean`, `analysis.tempo.trend`,
  `analysis.form.shallow_rep_indices`/`fast_rep_indices`, and
  `analysis.tracking.camera_frame_ratio` for specific, grounded feedback.

## 7. Integration order (do this, not big-bang at the end)

1. Each agent gets its piece running standalone against mocks (first ~90 min).
2. Pose state -> dashboard over WebSocket (real reps + depth gauge).
3. Real IMU -> fusion -> occlusion fallback -> tracking-source panel.
4. Fast voice cues during the set.
5. Phase machine + set-end -> Gemini debrief -> dynamic voice.
6. BigQuery writes + PT view + Gemini report.

Polish + rehearse the 3 demo beats last (live tracking, occlusion handoff, agent debrief).

## 8. Reliability rules (build these in, they save the demo)

- Software works without hardware (MockIMU; pose-only still counts reps).
- Rule loop works without the agent (UI uses `summary.templated_debrief` if Gemini errors).
- Manual "end set" button as a set-end safety net.
- Pre-generate all fast cue clips; no live API on the rep path.
- Never crash the main loop on a bad frame or a dropped serial read; catch and continue.

## 9. Scope discipline

ONE exercise (squat). Two form cues done well (shallow, too_fast). Protect the tracking-source
panel. MVP = Live View + occlusion fusion + fast cues + set-end Gemini debrief. Everything else
(PT view, BigQuery trends, session report, multi-set flow) is stretch. One flawless beats five
flaky.
