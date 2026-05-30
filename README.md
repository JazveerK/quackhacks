# PhysioFusion

AI physical-therapy coach: webcam + thigh-mounted IMU track bodyweight squats, with
sensor-fusion fallback when the camera loses sight of the thigh, an end-of-set Gemini
debrief, and a live web dashboard.

QuackHacks 3 (24h hackathon). Three-agent team.

## First read

- **[`CONTEXT.md`](CONTEXT.md)** — project brief + data contracts. Read first.
- **[`HANDOFF_FRONTEND.md`](HANDOFF_FRONTEND.md)** — WebSocket / 4c / 4d contract reference
  for the dashboard + Gemini wiring.

## What's in the repo

| File | Owner | Status |
|---|---|---|
| `pose_tracker.py` | Agent B | Done — pose tracking + fusion + rep state machine + 4c/4d + setup hints |
| `mock_state.py` | (shared) | Done — fake 4c stream + 4d summary, matches current contracts |
| `smoke.py` | Agent B | Done — 60 backend assertions |
| `run.py` | Agent B | Done — standalone launcher (mac webcam pre-flight) |
| `server.py` | Agent C | **Placeholder** — current file is a smoke server. Agent C rewrites per CONTEXT.md §5 |
| `static/index.html` | Agent C | **Placeholder** — minimal smoke UI. Agent C builds the real one |
| `main.py` | (shared) | TODO — integration entry point. Wires Agent A's IMU + B's tracker + C's server |
| `imu.py` | Agent A | TODO — real MPU6050 driver. `MockIMU` from `pose_tracker.py` is the stand-in |

## Quick start

```bash
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

### No camera / no hardware (develop the dashboard)
```bash
.venv/bin/python mock_state.py    # prints a simulated set with an occlusion window
```
Or import in your code:
```python
from mock_state import state_stream, sample_set_summary
```

### Backend only, with webcam
```bash
.venv/bin/python run.py
# open http://127.0.0.1:8000  (smoke dashboard; Agent C will replace)
```
On macOS the first run will pop a camera permission dialog — accept it.

### Run the backend tests
```bash
.venv/bin/python smoke.py
```

## Demo beats (in priority order)

1. Live tracking — skeleton overlay + ticking rep counter.
2. **Occlusion handoff** — step out of frame, `tracking_source` flips to `imu`, depth gauge
   keeps tracking. This is the entire justification for the hardware. Don't break this.
3. Set-end Gemini debrief, spoken via ElevenLabs.
