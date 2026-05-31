# SteadyPT

**AI physical-therapy coach.** A webcam + MediaPipe track your bodyweight squats in
real time — counting reps, judging depth, and scoring each set 0–100 — then an
end-of-set Gemini debrief explains how you did in a clinician's voice. A live web
dashboard shows it all as you move, and a clinician handoff view summarizes the session.

Built at QuackHacks 3 (24h hackathon).

## 🔗 Live demo

**https://steadypt-713924675865.us-central1.run.app**

> The hosted link runs in **demo mode** (clearly banner-labeled): the cloud server has
> no webcam, so it plays a *simulated* squat set through the full UI. To see real
> camera tracking, run it locally (below) — it uses your machine's webcam.

## How it works

1. **Pose tracking** — MediaPipe Pose gives 33 body landmarks per frame; we take the
   hip–knee–ankle triple and compute the **knee angle** with vector math.
2. **Rep counting** — a hysteresis state machine watches the angle cross down/up
   thresholds (with debouncing) so jitter never counts phantom reps, and a depth gate
   voids reps that don't go deep enough.
3. **Scoring** — each set is scored 0–100 from four weighted parts: **depth** (40%) —
   did you hit the prescribed angle — plus **consistency**, **tempo**, and
   **completion** (20% each), rolled up to a letter grade.
4. **AI debrief** — the per-set analysis is sent to Gemini for a short, clinical
   spoken-style debrief; results persist to BigQuery for cross-session progress.

## Run it locally (real camera tracking)

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python run.py        # picks your webcam, starts the server
# open http://localhost:8000
```

Optional Google services (the app degrades gracefully without them):

- `GEMINI_API_KEY` — AI prescription parsing + debriefs (falls back to a templated debrief)
- Application Default Credentials — BigQuery persistence (falls back to in-memory)

## Project layout

| Path | What |
|---|---|
| `pose_tracker.py` | Pose tracking, rep state machine, per-set scoring + summary |
| `server.py` | FastAPI app — WebSocket state broadcast, REST, serves the dashboard |
| `ai_agent.py` | Gemini wrappers — prescription parse, clinical debrief, session report |
| `bq.py` | BigQuery persistence (set + session writes, recent reads) |
| `profile.py` / `exercise_spec.py` | PT profile + per-exercise rules (depth/tempo/reps) |
| `frontend/` | React + Vite dashboard (built into `static/`) |
| `demo_tracker.py` | Camera-less synthetic stream behind `PF_DEMO` (powers the hosted demo) |
| `smoke.py` | Headless backend test suite (rep counter, scoring, setup classifier) |

## Tests

```bash
.venv/bin/python smoke.py        # 133 assertions: counting, scoring, setup, fusion
.venv/bin/python -m pytest tests/
```
