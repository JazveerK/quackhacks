# PhysioFusion

AI physical-therapy coach: webcam + thigh-mounted IMU track bodyweight squats, with
sensor-fusion fallback when the camera loses sight of the thigh, an end-of-set Gemini
debrief, and a live web dashboard.

QuackHacks 3 (24h hackathon). Three-agent team.

## Project structure

```
quackhacks/
├── docs/                       # All documentation
│   ├── CONTEXT.md              # Project brief + data contracts (read first)
│   ├── HANDOFF_FRONTEND.md     # WebSocket / 4c / 4d contract reference
│   ├── HANDOFF_VOICE_IN.md     # Web Speech API + voice commands
│   ├── frontend-spec.md        # Frontend UI/UX specification
│   ├── pose-matching.md        # Pose matching overlay design
│   ├── elevenlabs-coach-integration.md  # ElevenLabs TTS integration
│   └── FEATURE_clinician_handoff.md     # FHIR clinician handoff feature
│
├── frontend/                   # React + Vite + Tailwind v4
│   ├── src/
│   │   ├── screens/            # Page-level components (CheckIn, Live, Debrief, Clinician)
│   │   ├── components/         # Reusable UI components
│   │   ├── coach/              # Pose overlay, cue player, debrief audio
│   │   └── hooks/              # WebSocket hook
│   └── vite.config.js
│
├── backend/
│   └── scripts/                # Utility scripts (cue generation)
│
├── tests/
│   └── test_fhir_observation.py
│
├── static/                     # Vite build output (served by FastAPI)
│
├── server.py                   # FastAPI server (WebSocket + HTTP)
├── pose_tracker.py             # MediaPipe pose tracking + sensor fusion
├── ai_agent.py                 # Gemini Flash wrappers (debrief, prescription parse)
├── profile.py                  # PT profile dataclass
├── bq.py                       # BigQuery persistence
├── coach_voice.py              # ElevenLabs TTS output
├── coach_chat.py               # Coach chat endpoint
├── fhir_observation.py         # FHIR R4 Observation builder
├── sts_norms.py                # Sit-to-stand age/sex norms
├── mock_state.py               # Fake 4c stream for frontend dev
├── mock_ws.py                  # Mock WebSocket server
├── smoke.py                    # Backend smoke tests
├── run.py                      # Launcher (macOS camera preflight)
└── requirements.txt
```

## Quick start

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### Google services (Gemini + BigQuery)

```bash
export GEMINI_API_KEY="AIza..."          # AI Studio key
gcloud auth application-default login    # one-time, for BigQuery on the laptop
export PF_BQ_DATASET="physiofusion"      # optional; this is the default
```

Both Gemini and BigQuery degrade gracefully without these — the demo runs
either way.

### No camera / no hardware (develop the dashboard)

```bash
.venv/bin/python mock_state.py    # prints a simulated set with an occlusion window
```

### Frontend development

```bash
cd frontend && npm install && npm run dev
```

### Backend with webcam

```bash
.venv/bin/python run.py
# open http://127.0.0.1:8000
```

### Run tests

```bash
.venv/bin/python smoke.py
python -m tests.test_fhir_observation
```

## Demo beats (in priority order)

1. Live tracking — skeleton overlay + ticking rep counter.
2. **Occlusion handoff** — step out of frame, `tracking_source` flips to `imu`, depth gauge keeps tracking.
3. Set-end Gemini debrief, spoken via ElevenLabs.
