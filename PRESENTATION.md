# SteadyPT — Presentation & Technical Defense Guide

> Everything you need to explain the project end-to-end and answer hard questions
> from FAANG-engineer judges. Read the **30-second pitch** and the **Q&A bank** at
> minimum. The rest is depth you can pull from on demand.
>
> **Demo reality:** this is a **camera-only** build (no wearable sensor). The pitch,
> demo, and answers below all reflect that. We *explored* a thigh IMU + sensor
> fusion and it didn't make the reliability bar — see **Section 9, "What we
> explored that didn't ship."** Be honest about it; it's a strength, not a gap.

---

## 1. The 30-second pitch

**SteadyPT is an AI physical-therapy coach that runs on a webcam.** MediaPipe pose
tracking watches a patient do a prescribed exercise — and not just one hard-coded
exercise: a PT can paste their exercise documentation (or upload a prescription
PDF) and the app generates a tracker for **any** exercise on the fly. During the
set, a fast rule-based loop coaches form by voice. At the end of each set, Gemini
reasons over the whole set and speaks a debrief plus a concrete next-set
adjustment. The patient drives the entire app **hands-free by voice**, and every
session is persisted to BigQuery and exported as a real **FHIR Observation** for
the clinician.

**The differentiator:** most "AI fitness" demos hard-code one movement and bolt an
LLM onto rep counting. We did the opposite — the LLM **compiles** a PT's written
prescription into a structured tracker *once*, and a deterministic engine runs it
in real time. New exercise in seconds, no retraining, no LLM anywhere near the
per-frame loop.

**One-line framing (never violate):** this is a *coaching and measurement* tool
for PT-prescribed exercise. It measures range of motion and adherence and coaches
form. It does **not** diagnose and does **not** prescribe medically.

---

## 2. Why this matters (the problem)

Patients do 80%+ of their PT alone at home, and adherence + form fall apart once
they leave the clinic. PTs get no objective data on what actually happened between
visits — just "yeah, I did my exercises." SteadyPT closes that loop: objective
ROM/tempo/adherence per rep, an AI coach in the room, and a structured,
interoperable report (FHIR) that drops straight into the clinician's workflow.

---

## 3. System architecture

```
                      ┌─────────────────────────────────────────────┐
                      │              LAPTOP (all local)              │
                      │                                              │
  Webcam (side view)  │   pose_tracker.py (cv2 loop, daemon thread)  │
  ───frames───────────┼──▶ MediaPipe Pose → joint angle (e.g. knee)  │
                      │        │                                     │
                      │        ▼                                     │
                      │   RepCounter (debounced state machine)       │
                      │     → 4c per-frame state JSON + form flags    │
                      │        │ on_state / on_frame / on_set_end     │
                      │        ▼                                     │
                      │   server.py (FastAPI)                        │
                      │     • TrackerBridge (thread→async handoff)    │
                      │     • /ws WebSocket  ◀── 30 Hz broadcast ──   │
                      │     • REST: /exercise/load, /profile/upload,  │
                      │       /session/end, /pt/overview, /tts, ...   │
                      │        │            │              │          │
                      │   ai_agent.py   bq.py          tts.py         │
                      │   (Gemini Flash) (BigQuery)   (ElevenLabs)    │
                      └────────┼────────────┼──────────────┼─────────┘
                               │            │              │
                        Google Gemini   BigQuery      ElevenLabs
                               │
                      ┌────────▼─────────────────────────────────────┐
                      │  React SPA (Vite + Tailwind), served static   │
                      │  Check-in → Live → Debrief → Clinician        │
                      │  + floating hands-free Voice Assistant        │
                      │  + /share/<id> FHIR clinician handoff page    │
                      └───────────────────────────────────────────────┘
```

**Key architectural principle: the LLM is NEVER on the realtime path.** Gemini is
called in exactly three places, all off the per-frame loop: (1) compile a
prescription / documentation into an exercise tracker at load time, (2)
end-of-set debrief, (3) end-of-session progress report. The per-frame rep
counting, form flags, and analytics are pure deterministic math at camera frame
rate. This is the single most important design decision and we lead with it.

---

## 4. End-to-end data flow (follow one rep through the system)

1. **Camera** frame → MediaPipe Pose → 33 body landmarks, each with a visibility
   score. We take the three landmarks that define the active exercise's joint
   (hip-knee-ankle for a squat) and compute the vertex angle in pixel space.

2. **Setup classifier** (`_classify_setup`) checks framing: is a person in frame,
   is the whole body visible, is the camera at the right angle (side vs front for
   this exercise)? It emits a `setup_status` with a severity (good/info/warning/
   blocking) and a human hint, so we coach the user into a good camera setup
   *before* they waste a rep.

3. **Rep state machine** (`RepCounter.update`): a debounced two-state machine
   (`up` → `down` → `up`) on the EMA-smoothed angle. A rep only *counts* if it
   passes validity gates: plausible tempo, mostly tracked on camera, and actually
   deep enough. Each completed rep records depth, tempo, eccentric/concentric
   split, and form flags. Rejected reps are voided *with a reason*.

4. **State emit** (`_emit_state`): every frame produces the 4c JSON contract
   (phase, angle, rep_count, depth_state, form_flags, setup_status, profile, …)
   handed to `server.py` via `on_state`.

5. **Broadcast**: `TrackerBridge` is a thread-safe "latest value" bag. The cv2
   thread *pushes*; an async loop in FastAPI *pulls* at 30 Hz and sends only
   changed messages (sequence-numbered) over the WebSocket. JPEG frames go the
   same way, base64-encoded, with the skeleton overlaid (green when tracking).

6. **Frontend** (`useSocket.js`): one shared WebSocket for the whole app via
   `SocketContext`. Messages (`frame`, `state`, `set_end`, `ai_debrief`,
   `profile`, `agent_reply`) update React state; every screen reads the same feed.

7. **Set end** fires once (rep target hit, ~4s stillness, or manual/voice "stop").
   `_build_summary` produces the rich 4d JSON (per-rep depth/tempo arrays, trends,
   fatigue signal, a 0–100 set score, a `templated_debrief` fallback). The UI
   shows the templated text instantly; Gemini runs async and the `ai_debrief`
   swaps in 1–3s later. The set row is written to BigQuery on a background thread.

8. **Session end** writes a `sessions` row, generates a clinician progress report
   (Gemini over BigQuery history), and builds the **FHIR Observation** for the
   clinician handoff.

---

## 5. The strong parts (what to lead with, and what judges will probe)

### 5a. The "any exercise" pipeline — our headline (`exercise_spec.py` + `spec_generator.py`)

Most AI-fitness demos hard-code one movement. We made the exercise itself **data**.
A PT pastes documentation (or uploads a PDF prescription) and Gemini converts it
**once** into a structured, validated `ExerciseSpec`: which joint (3 MediaPipe
landmarks), the angle thresholds that drive the rep machine, whether "good" means a
*smaller* angle (squat, curl — go lower) or a *larger* one (arm raise — go higher)
via `rom_metric`, the form rules, and the spoken cues. A single generic tracker
then runs that spec with **zero further LLM calls**.

- `SQUAT_SPEC` reproduces our original hard-coded squat behaviour *exactly*, so we
  regression-tested the generic engine against the known-good one.
- The module is dependency-free (no mediapipe/cv2), so it imports in headless
  tests and in the generator.
- `from_dict` is tolerant of missing optional keys but **raises** on anything that
  would make the tracker unsafe (bad joint, bad metric, out-of-range angles). The
  generator retries once, then falls back to the default squat spec with an
  explicit error surfaced to the PT. The LLM is never load-bearing.
- Each spec declares a camera `view` (front/side); the tracker enforces it at
  runtime (a top-down camera foreshortens the limb and makes depth read shallow),
  so generated exercises get a camera-angle sanity check for free.

**Talking point:** "We turned exercise prescription into a compiler target. The
LLM is the compiler; it runs once; the runtime is deterministic."

### 5b. Rep state machine + validity gates (`RepCounter`)

Direction-agnostic via a sign term (`sgn`) so the *same* machine handles "go lower"
(squat) and "go higher" (arm raise). Debounced (`DEBOUNCE_FRAMES`) so jitter
doesn't double-count. A rep must pass three gates to count:

1. **Tempo** in `[MIN_REP_SEC, MAX_REP_SEC]` — rejects twitches and accidental holds.
2. **Tracked fraction** ≥ `MIN_CAM_FRAC` — a rep done while the camera couldn't see
   you doesn't count (no phantom reps).
3. **Depth** past the count gate — not just a wiggle past the trigger.

Rejected reps are voided *with a reason* (`too_fast`, `shallow`, `not_tracked`,
`incomplete`) so the coach can explain why a rep didn't count. Every completed rep
also stores its eccentric (descent) and concentric (ascent) time separately —
that's the tempo data the clinician cares about.

### 5c. Per-set analytics + 0–100 scoring (`_build_summary`, `_compute_score`)

At set end we compute a deterministic 0–100 score with a letter grade and a
per-component breakdown — depth (hit-rate at/below target), consistency (rep-to-rep
stddev), tempo (fraction controlled), completion (reps vs target) — plus depth and
tempo *trends* across the set and a fatigue signal (depth decline, tempo decline,
or both). This is the structured ground truth Gemini reasons over for the debrief,
and it's what makes the AI feedback *specific* ("82 — your depth held but reps 5
and 9 came up shallow") instead of generic.

### 5d. Clinical interoperability — FHIR + validated norms (`fhir_observation.py`, `sts_norms.py`)

The clinician handoff isn't a screenshot — it's a real **FHIR R4 Observation**
(LOINC-coded 30-second Sit-to-Stand), with:

- A **quality gate**: tracking confidence < 0.80 ⇒ status `preliminary` +
  `dataAbsentReason`, so unreliable measurements can't be mistaken for clinical data.
- **Age/sex-stratified normative interpretation** from published reference ranges
  (Rikli & Jones 1999) aligned with **CDC STEADI** fall-risk thresholds — encoded
  as FHIR `interpretation` (L/N/H) + `referenceRange`, never as a diagnosis.
- Every payload carries an explicit note: "observational data for clinician
  review, NOT a clinical diagnosis." The framing rule is enforced in code.

This is what makes it look like a real digital-health product, not a hackathon toy.

### 5e. Hands-free voice agent (`ai_agent.converse` + `VoiceAssistant.jsx`)

The patient runs the *entire* app by voice (you're mid-squat — you can't touch a
laptop). Browser Web Speech API → finalized transcript → Gemini returns
`{speech, action}` where `action` ∈ {start_set, end_set, next_set, end_session,
go_checkin/live/debrief/clinician, read_debrief, note}. The server executes the
action on the tracker and broadcasts the spoken reply. It infers intent (not exact
keywords) and is phase-aware (won't "start" mid-set). Falls back to a
keyword-matcher if Gemini is down — voice still controls the app. ("note" records a
symptom in the patient's own words onto the session for the clinician handoff.)

---

## 6. Reliability / graceful degradation (the "it won't die on stage" story)

Everything that can fail, fails *closed*. This is deliberate and worth saying out loud:

| If this is missing/broken… | …the app still does this |
|---|---|
| Camera loses the person mid-set | Detected by the setup classifier → clear "Can't see you" takeover; no phantom reps counted |
| `GEMINI_API_KEY` unset / Gemini errors | Templated debrief + keyword voice fallback; rep coaching unaffected |
| Gemini can't parse an uploaded exercise | Retries once, then falls back to the default squat spec with a surfaced error |
| No BigQuery credentials | Inserts/reads return False/[]; live session uses in-memory summaries |
| No ElevenLabs key / TTS fails | Frontend falls back to the browser's built-in SpeechSynthesis |
| Bad camera frame | Caught and skipped; the loop never dies |
| Scanned (image-only) PDF uploaded | Friendly 422 telling the PT to paste text instead |
| Page reloaded mid-session | Server replays last frame/state/profile/summary on WS connect; client auto-reconnects |

The mantra from the project context: **"Software works without hardware. The rule
loop works without the agent. One flawless beats five flaky."**

---

## 7. Tech stack & why each choice

| Layer | Choice | Why |
|---|---|---|
| Pose | **MediaPipe Pose** | On-device, real-time, 33 landmarks with per-landmark visibility (drives our tracking-quality + setup checks) |
| Backend | **FastAPI + uvicorn** | Async WebSocket for 30 Hz push; runs locally next to the camera |
| Realtime | **WebSocket** (local) | Low-latency push of state + base64 JPEG frames to the browser |
| AI | **Gemini 2.5 Flash** | Fast, cheap, JSON-mode for structured extraction; off the realtime path (Google track) |
| Storage | **BigQuery** | Cross-session history + PT trends; fail-closed, never on the live loop (Google track) |
| Voice out | **ElevenLabs** (+ browser TTS fallback) | Natural debrief voice; never load-bearing |
| Voice in | **Web Speech API** | Zero-install browser speech recognition for hands-free control |
| Interop | **FHIR R4 + LOINC + CDC STEADI norms** | Real clinical interoperability, not a screenshot |
| Frontend | **React + Vite + Tailwind** | Fast iteration; one shared socket via context; served as a static build by FastAPI |

---

## 8. Q&A BANK — anticipated SWE questions + crisp answers

**Q: Why isn't the LLM counting reps / analyzing each frame?**
A: Latency, cost, and determinism. Rep counting has to be frame-rate, reliable,
and explainable. We use Gemini exactly three places, all off the hot path: spec
generation (once at load), set debrief, session report. The per-frame loop is
deterministic math. We can show you the exact three call sites.

**Q: How does "any exercise" work without retraining a model?**
A: We don't train anything. An exercise is fully described by a structured
`ExerciseSpec`: the joint (3 MediaPipe landmarks), angle thresholds for the rep
machine, a `rom_metric` of "min" vs "max" (go-lower vs go-higher), form rules, and
cues. Gemini converts a PT's written documentation into that spec **once**, we
validate it, and a single generic tracker runs it. Same engine, different
parameters. The squat spec reproduces our original hard-coded behaviour exactly,
which is how we regression-tested the generic engine.

**Q: What if Gemini returns garbage for the spec?**
A: We validate `from_dict` strictly — bad joint, bad metric, or out-of-range
angles raise. The generator retries once, then falls back to the default squat
spec with an explicit error surfaced to the PT. The tracker can always proceed
with a usable spec; the LLM is never load-bearing.

**Q: How do you not double-count reps / handle jitter?**
A: EMA smoothing on the angle, a debounced two-state machine (`DEBOUNCE_FRAMES`
consecutive frames to flip phase), and three validity gates at rep completion
(tempo window, tracked-fraction, depth-past-count-gate). Rejected reps are voided
*with a reason* so the coach can explain why a rep didn't count.

**Q: What's your end-to-end latency?**
A: The realtime path is pure local math — MediaPipe inference per frame plus a
constant-time state machine, broadcast at a 30 Hz tick over a local WebSocket. No
network round-trip on the rep path. The only multi-second waits are the Gemini
calls, which are deliberately *off* the realtime path and run async at set/session
boundaries with templated fallbacks shown instantly. (We didn't benchmark exact
ms; if you want a number we can measure live.)

**Q: What happens when the camera can't see the patient mid-set?**
A: The setup classifier flags it (`severity: blocking`) and the live view shows a
clear "Can't see you" takeover with a hint to step back into frame. Crucially, we
*don't* count reps you did off-camera — the tracked-fraction gate voids them. We
explored a wearable-sensor fallback to keep tracking through occlusion; it didn't
ship (see next answer).

**Q: Did you consider a wearable / sensor to handle occlusion?**
A: Yes — honestly, that was our original "money-shot." We prototyped a thigh-mounted
IMU (MPU6050 on an Arduino) with a visibility-adaptive Kalman filter that fuses the
camera and the IMU, so the depth estimate coasts on the sensor when the leg is
occluded. The fusion math works in isolation, but we couldn't get the hardware
reliable enough to trust on stage inside the time box, so we shipped a clean
camera-only product. The architecture kept the seam for it — the IMU source is
constructor-injected — so it's an additive feature, not a rewrite. We'd rather demo
one thing that works flawlessly than five flaky things.

**Q: How do the cv2 thread and the async server share data safely?**
A: `TrackerBridge` — a lock-guarded "latest value" bag with monotonic sequence
numbers per channel (state/frame/summary/profile/ai_debrief). The cv2 thread
pushes; the FastAPI async broadcast loop snapshots under the lock and sends only
channels whose sequence changed. Producer/consumer decoupling, no shared mutable
state outside the lock, no blocking the event loop.

**Q: Why BigQuery and not Postgres/Redis?**
A: It's only for cross-session history and PT trend analysis, not live state —
live state is in memory. BigQuery fits the analytical read pattern and it's the
Google track. Critically, BigQuery streaming inserts have read-after-write delay,
so we *never* read back a row we just wrote; the session report pulls *prior*
sessions from BQ and appends the current session's numbers locally.

**Q: BigQuery is down at the booth. What happens?**
A: Nothing visible. Every `bq.py` function fails closed — logs one line, returns
False/[]. The live demo uses in-memory session summaries; the PT view falls back
to set-level data. Storage problems can't crash the demo by design.

**Q: Is the FHIR thing real or cosmetic?**
A: Real FHIR R4 Observation — LOINC-coded sit-to-stand, age/sex-stratified
normative interpretation from published reference ranges (Rikli & Jones) aligned
with CDC STEADI, encoded as FHIR `interpretation` + `referenceRange`. There's a
hard quality gate: confidence < 0.80 marks the observation `preliminary` with a
`dataAbsentReason`. Every payload explicitly says it's observational data for
clinician review, not a diagnosis.

**Q: Are you diagnosing fall risk / injury? That's a regulated claim.**
A: No, and we're careful about this in code, not just in the pitch. We *measure*
range of motion and adherence and *compare* to published normative ranges as a
screening signal for the clinician. Every output is labeled observational, not
diagnostic. We never say "you have X" — we say "this score is below the average
band for this cohort, for clinician review."

**Q: How accurate is the depth measurement from a single camera?**
A: We compute the joint angle from MediaPipe landmarks in the image plane, and the
biggest error source is camera angle, not the model — a top-down view foreshortens
the limb. So each exercise spec declares its correct `view` and we enforce it at
runtime: if the projected limb/torso ratio says the camera is too steep, we warn
("not side view") before the set rather than silently reporting shallow depth.

**Q: How is the set-end debrief both instant *and* AI-generated?**
A: Two-stage. `_build_summary` always produces a `templated_debrief` from the
structured numbers, shown instantly. The Gemini debrief runs on a background
thread and arrives as a separate `ai_debrief` WebSocket message 1–3s later, which
swaps in. If Gemini errors, the templated text just stays. The 0–100 set score and
all analytics are deterministic regardless.

**Q: What happens on a fresh page load mid-session — is the dashboard blank?**
A: No. On WebSocket connect the server replays the last known frame, state,
profile, and summary so a fresh client is immediately populated. The frontend also
auto-reconnects with exponential backoff.

**Q: What did you actually build vs. what's a library?**
A: Libraries: MediaPipe (landmarks), Gemini SDK, BigQuery client, ElevenLabs,
FastAPI. *Ours*: the entire ExerciseSpec compile-once pipeline, the
direction-agnostic rep state machine with validity gates, the per-set analytics +
0–100 scoring, the thread→async bridge, the FHIR/norms clinical layer, the
hands-free voice agent loop, the camera-setup classifier, and all the
graceful-degradation plumbing.

**Q: Biggest limitation / what would you do with more time?**
A: Honest answers: (1) single camera, single person in frame. (2) Occlusion is
handled by *pausing* rather than tracking through it — the IMU fusion we prototyped
would fix that. (3) The tilt/angle work isn't per-user calibrated. (4) Web Speech
API accuracy varies by browser/mic. None of these affect the core demo, and all
have a clear path forward.

---

## 9. What we explored that didn't ship (be honest, it lands well)

> Judges respect a team that knows exactly why they cut something. Use this.

**Sensor fusion via a thigh IMU.** Our original signature feature was an MPU6050
IMU on the thigh fused with the camera through a **visibility-adaptive Kalman
filter** — the camera's measurement noise scales as `R = R_base / v²` with landmark
visibility `v`, so as the leg is occluded the Kalman gain collapses toward zero and
the angle estimate coasts on the IMU, then re-anchors when the camera recovers. The
filter and the firmware are in the repo and the math checks out in isolation.

**Why we cut it from the demo:** we couldn't get the end-to-end hardware path
(serial reliability + per-user tilt→angle calibration) trustworthy enough to put on
stage in a 24-hour window. Rather than risk the signature beat flaking live, we
shipped a polished camera-only product. The codebase kept the seam — the IMU source
is constructor-injected and the fusion is a drop-in — so it's a clean future
addition, not a rewrite. **The lesson we'll say out loud:** "one thing that works
flawlessly beats five flaky things," and knowing which to cut is part of execution.

(If asked to show it: we can talk through `KalmanAngleFilter` in `pose_tracker.py`,
but we won't live-demo it because it's not reliable yet — and we'd rather show you
that judgment than a frozen gauge.)

---

## 10. Demo script (the beats — in priority order)

1. **Set up + live tracking** — stand side-on; the setup coach guides framing,
   the skeleton overlay turns green, the rep counter ticks, the depth arc fills
   past the target marker, and a voice cue fires on a shallow or too-fast rep.
2. **Set-end Gemini debrief** — finish the set (or say "that's enough"). The
   templated debrief appears instantly, the AI debrief swaps in and is spoken
   aloud, per-rep depth bars render, and the set persists to BigQuery.
3. **"Any exercise" (the headline)** — paste or upload a *different* exercise's
   documentation/prescription PDF → it's live and tracking in seconds, no code
   change. This is the moment that separates us from a hard-coded demo.
4. **Clinician handoff** — open `/share/<id>` to show the real FHIR Observation
   with the quality gate and normative interpretation.

Throughout: the patient drives it **hands-free by voice**.

**Graceful-degradation beat (optional flex):** cover the camera or step out of
frame to trigger the "Can't see you" takeover, then step back — shows we detect and
recover instead of counting garbage.

**If something breaks:** every subsystem has a fallback (Section 6). Stay calm —
rep counting, scoring, and the templated debrief work with zero cloud services.

---

## 11. File map (where to point when asked "show me the code")

| Concern | File | Key symbols |
|---|---|---|
| Pose, rep machine, analytics, scoring | `pose_tracker.py` | `RepCounter.update`, `PoseTracker._process_frame`, `_classify_setup`, `_build_summary`, `_compute_score` |
| Exercise schema ("any exercise") | `exercise_spec.py` | `ExerciseSpec`, `RepDefinition`, `SQUAT_SPEC`, `REGISTRY` |
| LLM → spec compiler (once) | `spec_generator.py` | `generate_spec_from_docs` |
| Gemini wrappers (debrief, voice, reports) | `ai_agent.py` | `generate_debrief`, `converse`, `generate_progress_report`, `parse_prescription` |
| FastAPI server, WebSocket, REST, voice routing | `server.py` | `TrackerBridge`, `_broadcast_loop`, `/ws`, `_handle_voice`, `_finalize_session` |
| BigQuery persistence (fail-closed) | `bq.py` | `insert_set`, `insert_session`, `query_session_history` |
| FHIR Observation + clinical gate | `fhir_observation.py` | `build_sts_observation` |
| Validated STS norms (Rikli & Jones / STEADI) | `sts_norms.py` | `interpret_sts`, `NORMS` |
| Voice out (ElevenLabs + fallback) | `tts.py` | `synthesize`, `is_available` |
| Frontend live data plumbing | `frontend/src/hooks/useSocket.js`, `SocketContext.jsx` | one shared socket, message switch |
| Screens | `frontend/src/screens/*` | `CheckIn`, `LiveDashboard`, `Debrief`, `ClinicianView`, `ClinicianHandoff` |
| Hands-free voice UI | `frontend/src/components/VoiceAssistant.jsx` | Web Speech API loop |
| Backend assertions | `smoke.py` | ~60 assertions: counter, profile binding, setup classifier |
| (Explored, not in demo) IMU + fusion | `imu.py`, `pose_tracker.py:KalmanAngleFilter` | kept for the roadmap; see §9 |

---

## 12. The data contracts (memorize the shapes, not the values)

- **4c — per-frame state (backend→dashboard):** `phase, angle, rep_count,
  rep_target, rom_min/max, depth_state, form_flags, tempo,
  landmark_visibility, rep_depths, setup_status, profile`.
- **4d — per-set summary (backend→Gemini):** `reps_completed, rep_depths_deg,
  depth_trend, form_flag_counts, fatigue_signal, set_score`, a rich `analysis`
  sub-object (depth/tempo/rom/form stats), `templated_debrief`, `profile`.
- **4e — BigQuery:** `sets(session_id, set_index, reps, avg_depth_deg,
  min_depth_deg, fatigue_score, debrief_text, recommended_next)`;
  `sessions(session_id, user_id, exercise, started_at, sets_count, total_reps,
  avg_depth, adherence_flag, sts_observation)`.

These contracts are the seams that let the team build in parallel without stepping
on each other — worth mentioning if asked about team workflow.

---
---

# PART II — Full codebase walkthrough

> Everything below is reference depth: read it once and you can answer "how does
> X actually work" for any part of the system. Organized file-by-file, with the
> control flow spelled out. Camera-only throughout (the IMU code exists but is not
> wired into the demo — see §9).

## A. Repository layout (every file, one line)

**Backend (Python, runs locally next to the camera):**

| File | What it is |
|---|---|
| `server.py` | FastAPI app: WebSocket broadcast, REST endpoints, voice routing, session lifecycle, FHIR handoff. The integration hub. |
| `pose_tracker.py` | The core. MediaPipe loop, rep state machine, setup classifier, per-set analytics + scoring, state emit. ~2000 lines, owns contracts 4c/4d. |
| `exercise_spec.py` | The `ExerciseSpec` schema — the structured "how to track one exercise" object. Dependency-free. Built-in squat + push-up specs. |
| `spec_generator.py` | The single LLM call that compiles PT documentation → a validated `ExerciseSpec`. |
| `ai_agent.py` | All Gemini wrappers: prescription parse, set debrief, session report, cross-session progress report, conversational voice agent. |
| `profile.py` | `PTProfile` dataclass (patient + prescription targets) + the default "Sam, post-ACL" demo persona. |
| `bq.py` | BigQuery persistence. Per-set + per-session writes, history reads. Fails closed everywhere. |
| `fhir_observation.py` | Builds a FHIR R4 Observation (30-sec sit-to-stand) with a quality gate + normative interpretation. |
| `sts_norms.py` | Validated age/sex sit-to-stand norm bands (Rikli & Jones / CDC STEADI). Pure function. |
| `tts.py` | ElevenLabs text→MP3 (stdlib urllib, no extra dep). Fails closed → browser voice. |
| `run.py` | macOS-aware launcher: picks the iPhone Continuity Camera, pre-flights the permission dialog, then boots uvicorn. |
| `imu.py` | Real MPU6050 serial driver + complementary filter. **Explored, not in the demo.** |
| `seed_bigquery.py` | Seeds demo patient history into BigQuery so the cross-session PT trend has data at the booth. |
| `mock_state.py` | Fake 4c/4d streams for building the UI without a camera. |
| `smoke.py` | ~60 backend assertions (rep counter, profile binding, setup classifier, scoring). |
| `imu_firmware.ino` / `imu_diag.ino` | Arduino sketches (explored, not in the demo). |

**Frontend (React + Vite + Tailwind, built to `static/` and served by FastAPI):**

| Path | What it is |
|---|---|
| `frontend/src/App.jsx` | Top-level: segmented-control nav between 4 screens + the `/share/<id>` handoff route. Holds the workout plan. |
| `frontend/src/SocketContext.jsx` | One shared backend connection for the whole app via React context. |
| `frontend/src/hooks/useSocket.js` | The WebSocket: connect, auto-reconnect, message switch → React state, `send()`. |
| `frontend/src/hooks/useVoice.js` | Web Speech API wrapper (browser speech recognition + synthesis). |
| `frontend/src/screens/CheckIn.jsx` | Build today's workout, set pain/ROM check-in, upload a prescription, pick/generate an exercise, start. |
| `frontend/src/screens/LiveDashboard.jsx` | The live session: camera feed + skeleton, rep counter, depth arc, form-cue banner, setup overlays. |
| `frontend/src/screens/Debrief.jsx` | Between-set results: score, per-rep depth bars, trends, spoken AI debrief. |
| `frontend/src/screens/ClinicianView.jsx` | PT trend view across sessions (BigQuery-backed) + Gemini progress report. |
| `frontend/src/screens/ClinicianHandoff.jsx` | Standalone FHIR Observation viewer (the `/share/<id>` page). |
| `frontend/src/components/VoiceAssistant.jsx` | The floating hands-free "Coach" — wake-word voice control over the whole app. |
| `frontend/src/components/*` | Presentational pieces: `CameraPanel`, `RepCounter`, `DepthGauge`, `FormCueBanner`, `RepBars`, etc. |
| `frontend/src/coach/setCues.js` | Deterministic during-set spoken cue selection (never hits the LLM). |

## B. Backend runtime model (threads + boot sequence)

There are **three concurrent execution contexts**, and knowing the boundary
between them answers most "how is this safe" questions:

1. **The cv2 / MediaPipe thread** (`pose-tracker`, daemon). Opens the webcam, runs
   `PoseTracker.run()` → a `while` loop calling `_process_frame` per frame. Pure
   synchronous CPU work. It *pushes* into the bridge; it never touches the event loop.
2. **The asyncio event loop** (uvicorn). Runs the FastAPI app: the `/ws` WebSocket
   handler(s), the REST endpoints, and the `_broadcast_loop` coroutine that pulls
   from the bridge every ~33ms and sends changed messages to all clients.
3. **Short-lived background threads** for anything blocking that must not stall
   either of the above: BigQuery inserts (`bq-insert-set`), the async Gemini
   debrief (`_spawn_ai_debrief`), and `asyncio.to_thread(...)` for the Gemini calls
   invoked from request handlers.

**The `TrackerBridge` is the only shared mutable state**, and it's fully
lock-guarded. It holds the latest `state`, `frame`, `set_summary`, `profile`, and
`ai_debrief`, each with a monotonic sequence number. Producers (`push_*`) and the
consumer (`snapshot`) both take `self._lock`. The broadcast loop compares each
channel's sequence to the last it sent and only emits deltas. This is a classic
single-writer-per-channel / latest-value-wins pattern — no queues, no backpressure,
so a slow client just misses intermediate frames instead of blocking the tracker.

**Boot sequence** (`lifespan` context manager in `server.py`):
`_start_tracker()` → picks the camera (`_select_camera_index`, iPhone-preferring on
macOS) → constructs `PoseTracker` with the bridge callbacks wired in → starts the
tracker thread → seeds the bridge with the default profile → `asyncio.create_task(_broadcast_loop())`.
On shutdown: cancel the broadcast task, `tracker.stop()`.

`run.py` is the recommended entry point on macOS because AVFoundation requires the
camera-permission dialog to be triggered from the **main** thread, but the tracker
runs on a background thread — so `run.py` opens the camera once on the main thread
(firing the dialog), sets `OPENCV_AVFOUNDATION_SKIP_AUTH=1`, then launches uvicorn.

## C. `pose_tracker.py` — the core, in depth

### C.1 The phase machine

A `PoseTracker` is always in exactly one `phase`, and the transitions are driven
per-frame inside `_process_frame`:

```
WAITING_FOR_START ──(voice/button "start", once camera angle is confirmed)──▶ COUNTDOWN
COUNTDOWN ──(3-2-1 elapsed)──▶ SET_ACTIVE
SET_ACTIVE ──(rep target hit │ ~stillness │ "stop")──▶ SET_END
SET_END ──(summary emitted once + async Gemini spawned)──▶ DEBRIEF
DEBRIEF ──(voice/button "next")──▶ reset_set() ──▶ WAITING_FOR_START
```

- **WAITING_FOR_START:** a queued start (`_start_requested`) is *held* until the
  setup classifier reports a good camera angle (`code ∈ START_OK_CODES`), so a set
  never begins from a bad angle. `START_GRACE_SEC` (15s) is a safety valve so a
  flaky pose lock can't strand the user forever.
- **COUNTDOWN:** `COUNTDOWN_SEC` (3s) 3-2-1, surfaced to the UI via `state.countdown`.
- **SET_ACTIVE:** reps are counted, ROM tracked, form flags raised. Only this phase
  feeds the rep counter.
- **SET_END → DEBRIEF:** the set-end summary fires exactly once (`_set_emitted`
  latch), then `_spawn_ai_debrief` kicks off the Gemini call on a background thread
  so the frame loop doesn't block 1–3s.

Set-end triggers (`_check_set_end`): explicit request (`request_set_end`), rep
count ≥ target, OR resting at the start position without moving for `STILL_SECONDS`
(the "patient walked away" idle fallback).

### C.2 The per-frame pipeline (`_process_frame`, the hot loop)

Every camera frame runs this sequence (all deterministic, no LLM):

1. **Pose inference** — `cv2.cvtColor` → `pose.process(rgb)` → 33 landmarks.
2. **Limb extraction** (`_extract_limb`) — resolves the active exercise's joint
   (e.g. hip-knee-ankle), auto-picking the more-visible side unless pinned, and
   computes the vertex `cam_angle` via `angle_deg` in pixel space. Also returns the
   mean + min leg-landmark visibility.
3. **Camera-trust test** — `camera_trusted = cam_angle exists AND mean leg
   visibility ≥ VIS_THRESHOLD AND every leg landmark ≥ LANDMARK_VIS_FLOOR`.
4. **Skeleton overlay** — `_draw_body_skeleton` paints the body (no face landmarks)
   onto the JPEG, green when `camera_trusted` else red.
5. **Setup classification** (`_classify_setup`) — returns the `setup_status` (code +
   severity + hint). This is what drives all the live-view coaching overlays.
6. **Angle resolution** — camera-only in the demo: the smoothed camera angle (EMA
   `ANGLE_EMA_ALPHA`) when trusted, else the tracking source degrades to `"none"`
   and the live view shows "Can't see you." *(The Kalman/IMU branch is gated behind
   `imu_on`, which is false in the demo — §9.)*
7. **Lifecycle transitions** — the phase machine above.
8. **Rep + ROM update** — if `SET_ACTIVE` and tracking on camera, `counter.update`;
   update `rom_min`/`rom_max`. On a source change, `counter.pause_streaks()` so a
   discontinuity can't leak a fake rep.
9. **Stuck-in-down recovery** — if the user has been "down" for `STUCK_DOWN_SEC`
   (sat down / walked off mid-rep), force the counter back to "up."
10. **Emit** — `_emit_state` packages the 4c dict and calls `on_state`.
11. **Set-end** — if `SET_END` and not yet emitted: build summary, fire
    `on_set_end`, spawn the async debrief.

Every step is wrapped so a single bad frame is caught and skipped — the loop never dies.

### C.3 `RepCounter` — the rep state machine internals

A two-state machine (`up` / `down`) per rep, made **direction-agnostic** by a sign
term `sgn` (−1 for "go lower" squats, +1 for "go higher" raises) so every
comparison `sgn*angle > sgn*threshold` works for both. Key thresholds come from the
active `ExerciseSpec.rep_definition`: `start`, `trigger`, `target`, `return`.

- **up → down:** angle passes `trigger` toward the active end for `DEBOUNCE_FRAMES`
  consecutive frames. Records `rep_start_t`, attributes the descent start back to
  the last standing frame (so the full eccentric is captured, not just past-trigger).
- **during down:** tracks the running extreme (`min_angle_this_rep`) and the time it
  occurred (`t_at_min`), and counts camera vs non-camera frames for the rep.
- **down → up (rep completes):** angle crosses back past `return` for
  `DEBOUNCE_FRAMES`. Then the **three validity gates**:
  1. `MIN_REP_SEC ≤ tempo ≤ MAX_REP_SEC`
  2. `cam_frac ≥ MIN_CAM_FRAC`
  3. `sgn*depth ≥ sgn*count_depth_deg` (must reach within `COUNT_DEPTH_MARGIN_DEG`
     of parallel — kills tiny bobs)
  - **Valid** → increment, append depth/tempo/eccentric/concentric/cam_frac, run
    `_eval_form` against the spec's `form_rules`.
  - **Invalid** → `voided_reps += 1` with a `last_void_reason` (`too_fast`,
    `too_slow`, `not_tracked`, `shallow`, `incomplete`). The UI watches
    `rep_void_count` climb and voices the reason.

`_eval_form` applies the spec's form rules (`tempo`, `shallow`, `target_not_reached`,
`rom`), all direction-aware. Per-rep flags accumulate into `flag_counts` for the
summary.

### C.4 Tunables (the constants a judge might ask you to defend)

All at the top of `pose_tracker.py`. The ones worth knowing:

| Constant | Value | Meaning |
|---|---|---|
| `DEBOUNCE_FRAMES` | 3 | Frames past a threshold before a phase flips (anti-jitter) |
| `ANGLE_EMA_ALPHA` | 0.30 | Angle smoothing (higher = snappier, noisier) |
| `MIN_REP_SEC` / `MAX_REP_SEC` | 0.7 / 15.0 | Tempo validity window for a rep to count |
| `MIN_CAM_FRAC` | 0.5 | A rep must be ≥50% camera-tracked to count |
| `COUNT_DEPTH_MARGIN_DEG` | 10 | How close to parallel a rep must get to count |
| `VIS_THRESHOLD` / `LANDMARK_VIS_FLOOR` | 0.6 / 0.4 | Mean / per-landmark visibility for "camera trusted" |
| `STILL_SECONDS` | 20 | Idle-at-top auto-end fallback |
| `STUCK_DOWN_SEC` | 20 | Force-reset if stuck mid-rep |
| `COUNTDOWN_SEC` | 3 | Pre-set 3-2-1 |
| `FLAG_TTL_SEC` | 2.5 | How long a form flag stays on screen |

Profile-driven (overridden at runtime by the active `PTProfile`): target depth,
tempo, rep target. Defaults (`TARGET_DEPTH_DEG=95`, etc.) are the fallback before
any prescription loads.

### C.5 Set summary + scoring (`_build_summary`, `_compute_score`)

`_build_summary` assembles the 4d contract: per-rep depth/tempo arrays, eccentric/
concentric splits, depth + tempo **trends** (via `_trend` over first-half vs
second-half means), a **fatigue signal**, ROM min/max, form flag counts with the
specific shallow/fast rep indices, tracking ratios, a 0–100 **set score**, a
human-readable `templated_debrief` (the always-available fallback), and the profile.

`_compute_score` → 0–100 with a letter grade and four components: **depth**
(hit-rate at/below target + partial credit for closeness), **consistency** (low
rep-to-rep stddev), **tempo** (fraction not-too-fast), **completion** (reps vs
target). This score is what Gemini opens the spoken debrief with.

## D. The "any exercise" system, in depth

**`ExerciseSpec`** (a dataclass) fully describes how to track one exercise:
- `primary_joint`: `{name, landmarks:[A,VERTEX,C], side}` — the 3 MediaPipe landmarks
  whose vertex angle defines a rep. Side-agnostic base names are resolved at runtime.
- `rep_definition`: the four angle thresholds (`start/trigger/target/return`).
- `rom_metric`: `"min"` (good rep = smaller angle: squat, curl) or `"max"` (larger:
  arm raise). This single field is what makes the engine bidirectional.
- `view`: `"side"` or `"front"` — enforced at runtime by a foreshortening check
  (`view_check_ratio` / `min_limb_torso_ratio`), so a wrong camera angle is caught.
- `form_rules`, `cues`, `rep_target`, plus engine tuning (`parallel_buffer_deg`,
  `count_margin_deg`) and `ui` overrides (`to_ui()` gives the frontend gauge labels).
- `validate()` clamps/raises on anything unsafe; `from_dict`/`to_dict` round-trip it.

**Flow for a generated exercise:** PT pastes docs or uploads a PDF →
`/exercise/load` or `/exercise/load_pdf` → `spec_generator.generate_spec_from_docs`
makes **one** Gemini call (JSON mode, with worked few-shot examples in the system
prompt) → `ExerciseSpec.from_dict(...)` validates → registered in `REGISTRY` (so it
shows in the dropdown) → `tracker.load_exercise_spec(spec)` installs it. From there
the generic tracker runs it with zero further LLM calls. Built-ins (squat, push-up)
are pre-registered; the lateral arm raise exists as a "max"-metric test fixture to
prove the engine is bidirectional but is intentionally only reachable via generation.

**Pending-switch safety:** a profile or exercise change mid-set is queued
(`_pending_profile` / `_pending_exercise`) and applied on the next `reset_set()`, so
the rules never change underneath an in-flight rep.

## E. `ai_agent.py` — the four Gemini surfaces

All use `gemini-2.5-flash`, all fail closed (return `None` / a fallback, never raise):

1. **`parse_prescription(text) → PTProfile | None`** — JSON-mode extraction of
   sets/reps/depth/tempo/contraindications from free-form PT text, merged over the
   default profile so missing fields stay sane.
2. **`generate_debrief(profile, summary) → str | None`** — the spoken end-of-set
   debrief. Prompt tells it to open with the score, ground every claim in specific
   numbers from the summary (`target_hit_rate`, `halves_delta_deg`, shallow/fast rep
   indices…), give one concrete next-set adjustment, 4–6 sentences, no markdown
   (it's read aloud). Caller falls back to `summary['templated_debrief']`.
3. **`generate_session_report` / `generate_progress_report`** — clinician-facing
   notes. The progress report reasons over BigQuery cross-session history and has a
   structured templated fallback (`_progress_fallback`) so it *never* returns None.
4. **`converse(user_text, context, history) → {speech, action}`** — the voice agent
   turn. The prompt defines the action vocabulary, is phase-aware, and stays terse
   mid-set. `_converse_fallback` is a keyword matcher so voice control survives
   Gemini being down. The returned `action` is validated against `AGENT_ACTIONS`.

## F. `server.py` — endpoint catalog + responsibilities

**WebSocket `/ws`:** on connect, replays last frame/profile/state/summary/debrief so
a fresh client isn't blank. Then a receive loop handling client commands: `say`
(voice turn → `_handle_voice`), `start_set`, `end_set`, `reset_set`/`next_set`,
`set_imu` (the demo sends `enabled:false`), `select_exercise`.

**REST:**

| Endpoint | Purpose |
|---|---|
| `GET /` , `/favicon.svg`, `/assets/*`, `/static/*` | Serve the React build |
| `POST /profile/upload` | Free-form prescription text → Gemini parse → install profile |
| `GET /profile` | Current active profile |
| `GET /exercises` | Dropdown options + active exercise |
| `POST /exercise/load` | PT documentation text → generate + install an ExerciseSpec |
| `POST /exercise/load_pdf` | Same, from an uploaded PDF (text extracted via `pypdf`) |
| `POST /tts` | Debrief text → ElevenLabs MP3 (503 → browser voice fallback) |
| `GET /session` | Live session metadata + in-memory set summaries + service-availability flags |
| `POST /session/end` | Finalize: write session row, Gemini reports, build FHIR, rotate session |
| `GET /sets/recent`, `GET /pt/overview` | BigQuery-backed PT trend views |
| `POST/GET /user-context` | Age + sex for norm-stratified FHIR interpretation |
| `GET /share/{id}` , `GET /api/share/{id}` | Clinician handoff page + its FHIR Observation JSON |

**Voice routing (`_handle_voice`):** builds live `_agent_context` (phase, prescription,
reps, last-set score), calls `ai_agent.converse`, executes the returned action on the
tracker (start/end/next/end-session/note/read_debrief/navigate), appends to a capped
in-memory conversation history, and broadcasts an `agent_reply` (with the report
payload on `end_session`).

**Session lifecycle:** `SESSION_ID` is generated at boot; `set_index` increments per
set; `session_summaries` is the in-memory source of truth for the live PT report
(avoids BigQuery's read-after-write delay). `_finalize_session` writes the session
row, runs the session + cross-session Gemini reports, optionally builds the FHIR
Observation (only if age + sex were provided), then `_new_session()` rotates to a
fresh id.

## G. `bq.py` — persistence (fail-closed)

`init_client()` memoizes the client (including `None`), so a missing-auth laptop
doesn't retry on every call. Two tables (§4e). `insert_set` derives scalar columns
(avg/min depth, a fatigue score, a stable `recommended_next` synthesized from the
analysis, the debrief text) from the rich 4d summary. `insert_session` coerces the
`adherence_flag` string to the BOOLEAN column and JSON-stringifies the FHIR
observation into its column. Reads: `query_recent_sets`, `query_session_history`
(oldest-first, for trends), `query_session` (single, parses the FHIR JSON back).
**Every function catches all exceptions, logs one line, returns `False`/`[]`/`None`.**
The realtime path never depends on it.

## H. FHIR + norms (`fhir_observation.py`, `sts_norms.py`)

`build_sts_observation(session)` emits a FHIR R4 `Observation`: LOINC-coded
sit-to-stand, `valueQuantity` = reps, `component[]` for provenance (tracking source
— `"camera"` in this build — confidence, calibration id, mean concentric/eccentric,
tempo asymmetry, peak flexion, adherence, clinical flags). A **quality gate**:
confidence < `QUALITY_THRESHOLD` (0.80) ⇒ status `preliminary` + `dataAbsentReason`.
`sts_norms.interpret_sts(reps, age, sex)` maps the score to an age/sex band (raises
for age < 60, clamps > 94), yielding an L/N/H FHIR interpretation, a reference range,
and a CDC-STEADI fall-risk flag — all explicitly labeled screening, not diagnosis.

## I. Frontend architecture

**Single shared connection.** `main.jsx` wraps `<App/>` in `<SocketProvider>`;
`useSocket` opens one WebSocket, auto-reconnects with exponential backoff, and
exposes `{ connected, state, frame, summary, aiDebrief, profile, agentReply, send }`.
Every screen calls `useSession()` to read the same live feed — no screen owns a
connection, none use mocks anymore.

**`App.jsx`** holds the screen router (segmented control: Check-in / Live / Debrief /
Clinician), the workout plan (`[{id,name,sets,reps}]`) and position, and detects the
`/share/<id>` URL to render the standalone clinician handoff.

**Screen by screen:**
- **CheckIn** — builds today's workout, captures a quick pain/knee check-in, lets the
  PT upload a prescription / pick or generate an exercise, captures age+sex for the
  FHIR norms. `startSession()` sends `set_imu enabled:false` (camera-only), selects
  the exercise, sets the rep target, starts the set, and routes to Live.
- **LiveDashboard** — the money screen: `CameraPanel` (backend JPEG + skeleton),
  `RepCounter`, the half-circle `DepthArc` (fills toward target; direction set by the
  exercise's `rom_metric`), `FormCueBanner`, descent-tempo readout, and the
  setup/lost-tracking overlays (`CameraLostOverlay` on `setup_status.severity ===
  "blocking"`). No IMU/fusion UI.
- **Debrief** — set score, per-rep depth bars (`RepBars`), depth/tempo trend chips,
  and the spoken AI debrief (TTS via `/tts`, browser-voice fallback).
- **ClinicianView** — cross-session ROM/adherence trend from `/pt/overview`
  (BigQuery), with defensive readers that handle both session rows and set rows,
  plus the Gemini progress report.
- **ClinicianHandoff** — fetches `/api/share/{id}`, renders the FHIR Observation as a
  clinician-legible quality panel + metric grid + raw FHIR JSON viewer; falls back to
  a baked-in demo observation if the backend is unreachable.

**Voice (`VoiceAssistant` + `useVoice`)** — a floating mic. While open the mic
listens continuously, but only utterances prefixed with the wake word "hey coach …"
are acted on (booth-chatter guard). Each turn is sent over the WS (`say`) to the
backend agent; replies are spoken. During an active set the agent stays quiet and
only short deterministic cues (`coach/setCues.js`) play — never the LLM on the rep path.

## J. Configuration & how to run

**Env vars** (all optional — everything degrades gracefully):
`GEMINI_API_KEY` (AI debrief + voice + spec generation), `PF_BQ_DATASET`
(default `physiofusion`), `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` (coach voice),
`PF_CAMERA` (force a camera index), `PF_USER_ID` (demo patient id), `PF_IMU_PORT`
(unused in the camera-only demo). BigQuery uses Application Default Credentials
(`gcloud auth application-default login` once on the laptop).

**Run it:**
```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python run.py          # picks the camera, boots http://127.0.0.1:8000
# rebuild the UI after frontend changes:
cd frontend && npm install && npm run build   # outputs to ../static
```
`mock_state.py` lets you build the UI with no camera; `smoke.py` runs the backend
assertions; `seed_bigquery.py` loads demo history for the PT trend view.

## K. Tests

`smoke.py` (~60 assertions) covers the rep counter (counts real reps, rejects
twitches/too-fast/shallow), profile binding (prescription targets drive the live
session), the setup classifier (correct codes/severities for no-person / partial /
wrong-view), and the scoring math. There are also `smoke_reps.py` and
`smoke_exercises.py` for narrower checks, plus a `tests/` directory. Run any with
`.venv/bin/python smoke.py`.
