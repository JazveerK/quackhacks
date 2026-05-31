"""
SteadyPT local server.

Runs the PoseTracker on a daemon thread, broadcasts per-frame state JSON,
JPEG frames, set summaries, profile updates, and the AI debrief follow-up
to all WebSocket clients. Accepts a few control commands (end_set,
reset_set) back from the dashboard. Exposes an HTTP endpoint for the PT
to upload a prescription text.

Run:
    .venv/bin/python run.py
    # or directly: uvicorn server:app --host 127.0.0.1 --port 8000
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import threading
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

# Load .env into the process environment BEFORE anything reads a key. Without
# this the Gemini voice agent silently runs in keyword-only fallback and TTS
# stays disabled even when .env holds valid keys. Existing env vars win, so an
# explicitly-exported key still overrides the file.
try:
    from dotenv import load_dotenv
    load_dotenv(Path(__file__).parent / ".env")
except ImportError:
    pass

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from pose_tracker import PoseTracker, MockIMU
from profile import PTProfile, DEFAULT_PROFILE
import ai_agent
import bq
import tts
import exercise_spec
import spec_generator
from exercise_spec import ExerciseSpec
from fhir_observation import build_sts_observation, QUALITY_THRESHOLD

STATIC_DIR = Path(__file__).parent / "static"


# ---------------------------------------------------------------------------
# Tracker bridge. Producer (cv2 thread) -> async consumer (broadcast loop).
# ---------------------------------------------------------------------------
class TrackerBridge:
    """Thread-safe bag holding the most recent state, frame, summary,
    profile, and AI debrief text."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict | None = None
        self._frame_b64: str | None = None
        self._set_summary: dict | None = None
        self._profile: dict | None = DEFAULT_PROFILE.to_dict()
        self._ai_debrief: dict | None = None
        self._frame_seq = 0
        self._state_seq = 0
        self._summary_seq = 0
        self._profile_seq = 1   # send the initial default to fresh clients
        self._ai_debrief_seq = 0

    # ----- producer hooks (called from tracker / HTTP handlers) -----
    def push_state(self, state: dict) -> None:
        with self._lock:
            self._state = state
            self._state_seq += 1

    def push_frame(self, jpeg: bytes) -> None:
        b64 = base64.b64encode(jpeg).decode("ascii")
        with self._lock:
            self._frame_b64 = b64
            self._frame_seq += 1

    def push_set_summary(self, summary: dict) -> None:
        with self._lock:
            self._set_summary = summary
            self._summary_seq += 1

    def push_profile(self, profile: PTProfile, source: str) -> None:
        with self._lock:
            self._profile = {"profile": profile.to_dict(), "source": source}
            self._profile_seq += 1

    def push_ai_debrief(self, text: str) -> None:
        # Tagged with the summary it relates to so the UI knows which set
        # the AI debrief is for. summary_seq is monotonically increasing.
        with self._lock:
            self._ai_debrief = {"text": text, "summary_seq": self._summary_seq}
            self._ai_debrief_seq += 1

    def snapshot(self) -> dict:
        with self._lock:
            return {
                "state": self._state,
                "frame_b64": self._frame_b64,
                "set_summary": self._set_summary,
                "profile": self._profile,
                "ai_debrief": self._ai_debrief,
                "seqs": {
                    "state": self._state_seq,
                    "frame": self._frame_seq,
                    "summary": self._summary_seq,
                    "profile": self._profile_seq,
                    "ai_debrief": self._ai_debrief_seq,
                },
            }


bridge = TrackerBridge()
tracker: PoseTracker | None = None
tracker_thread: threading.Thread | None = None
clients: set[WebSocket] = set()


# ---------------------------------------------------------------------------
# Session / set tracking. session_id is generated when the server starts;
# set_index increments on each completed set. In-memory list of this
# session's summaries powers the session-end PT report without re-querying
# BigQuery (which has read-after-write delay).
# ---------------------------------------------------------------------------
SESSION_ID = uuid.uuid4().hex[:8]
SESSION_STARTED_AT = datetime.now(timezone.utc)
SESSION_USER_ID = os.environ.get("PF_USER_ID", "demo_user")
set_index = 0
session_summaries: list[dict] = []
_session_lock = threading.Lock()

# Voice-agent conversation history for the current session (capped, in-memory).
conversation: list[dict] = []

# Patient-spoken notes for this session ("note that my right knee hurts"),
# surfaced to the clinician handoff. Reset each new session.
session_notes: list[dict] = []

# User context for clinician handoff (age + sex_at_birth), set via
# POST /user-context before or during a session. Drives norm-stratified STS.
_user_context: dict = {}

# In-memory FHIR Observation store keyed by session_id — demo fallback for the
# clinician handoff page when BigQuery is unavailable.
_observation_store: dict[str, dict] = {}


def _new_session() -> None:
    """Reset to a fresh session_id + counters. Called by POST /session/end
    after the closing session row is written."""
    global SESSION_ID, SESSION_STARTED_AT, set_index, session_summaries, conversation, session_notes
    with _session_lock:
        SESSION_ID = uuid.uuid4().hex[:8]
        SESSION_STARTED_AT = datetime.now(timezone.utc)
        set_index = 0
        session_summaries = []
        conversation = []
        session_notes = []


def _on_set_end(summary: dict) -> None:
    """Tag, persist (BigQuery, best-effort), broadcast."""
    global set_index
    with _session_lock:
        set_index += 1
        summary["session_id"] = SESSION_ID
        summary["set_index"] = set_index
        session_summaries.append(summary)
        sid, sidx = SESSION_ID, set_index
    # Storage: best-effort, never fatal.
    threading.Thread(
        target=bq.insert_set,
        args=(sid, sidx, summary),
        daemon=True, name="bq-insert-set",
    ).start()
    bridge.push_set_summary(summary)


def _make_imu_source():
    """Pick the IMU backend: real serial IMU if a port is available, else MockIMU.

    Set PF_IMU_PORT to force a specific serial device. PF_IMU_PORT="mock" (or no
    port found) keeps MockIMU so the app runs with no hardware. The real reader
    is resilient — it survives an absent/unplugged Arduino — but we only reach for
    it when a port is actually present so a no-hardware dev run shows a healthy
    mock signal instead of a dead "none" source.
    """
    port = os.environ.get("PF_IMU_PORT", "").strip()
    if port.lower() == "mock":
        print("[server] PF_IMU_PORT=mock -> using MockIMU.")
        return MockIMU()
    try:
        from imu import IMU, find_imu_port
        port = port or find_imu_port()
        if not port:
            print("[server] No IMU serial port found -> using MockIMU.")
            return MockIMU()
        print(f"[server] Using real IMU on {port}.")
        return IMU(port=port)
    except Exception as e:
        print(f"[server] IMU init failed ({e}); using MockIMU.")
        return MockIMU()


def _select_camera_index() -> int:
    """Pick which camera to open.

    PF_CAMERA forces a specific index. Otherwise, on macOS we try to prefer an
    iPhone Continuity Camera: it advertises a much higher resolution (1080p+)
    than the built-in FaceTime camera, so we probe a few indices and take the
    highest-resolution one. This is a heuristic — if it grabs the wrong camera,
    set PF_CAMERA=N to pin a specific index.
    """
    env = os.environ.get("PF_CAMERA", "").strip()
    if env:
        try:
            return int(env)
        except ValueError:
            print(f"[server] ignoring non-integer PF_CAMERA={env!r}")

    import sys
    if sys.platform != "darwin":
        return 0

    try:
        import cv2
    except Exception:
        return 0

    backend = getattr(cv2, "CAP_AVFOUNDATION", 0)
    best_idx, best_res = 0, -1
    for idx in range(4):
        cap = None
        try:
            cap = cv2.VideoCapture(idx, backend)
            if not cap.isOpened():
                continue
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            h, w = frame.shape[:2]
            res = w * h
            print(f"[server] camera probe: index {idx} -> {w}x{h}")
            if res > best_res:
                best_idx, best_res = idx, res
        except Exception as e:
            print(f"[server] camera probe index {idx} failed: {e}")
        finally:
            if cap is not None:
                cap.release()

    label = "iPhone/Continuity heuristic" if best_res > 0 else "default"
    print(f"[server] using camera index {best_idx} ({label}); override with PF_CAMERA=N")
    return best_idx


def _start_tracker() -> None:
    global tracker, tracker_thread
    camera_index = _select_camera_index()
    tracker = PoseTracker(
        imu_source=_make_imu_source(),
        on_state=bridge.push_state,
        on_set_end=_on_set_end,
        on_frame=bridge.push_frame,
        on_ai_debrief=bridge.push_ai_debrief,
        camera_index=camera_index,
        show_window=False,
        # The set waits for an explicit start (voice / button) before counting.
        require_start_gesture=True,
        # Thumbs-up gesture disabled — the app is voice-driven.
        enable_gesture=False,
        # rep_target / depth_target / tempo all come from the default profile.
    )
    # Make sure the bridge starts with whatever profile the tracker actually
    # picked (in case env vars / args nudged it).
    bridge.push_profile(tracker.profile, source=tracker.profile.source)

    def _run():
        try:
            tracker.run()
        except Exception as e:
            print(f"[server] tracker thread crashed: {e}")

    tracker_thread = threading.Thread(target=_run, daemon=True, name="pose-tracker")
    tracker_thread.start()


async def _broadcast_loop() -> None:
    last = {"state": -1, "frame": -1, "summary": -1, "profile": -1, "ai_debrief": -1}
    while True:
        snap = bridge.snapshot()
        seqs = snap["seqs"]
        msgs: list[str] = []

        if seqs["frame"] != last["frame"] and snap["frame_b64"] is not None:
            last["frame"] = seqs["frame"]
            msgs.append(json.dumps({"type": "frame", "jpeg": snap["frame_b64"]}))
        if seqs["state"] != last["state"] and snap["state"] is not None:
            last["state"] = seqs["state"]
            msgs.append(json.dumps({"type": "state", "state": snap["state"]}))
        if seqs["profile"] != last["profile"] and snap["profile"] is not None:
            last["profile"] = seqs["profile"]
            msgs.append(json.dumps({"type": "profile", **snap["profile"]}))
        if seqs["summary"] != last["summary"] and snap["set_summary"] is not None:
            last["summary"] = seqs["summary"]
            msgs.append(json.dumps({"type": "set_end", "summary": snap["set_summary"]}))
        if seqs["ai_debrief"] != last["ai_debrief"] and snap["ai_debrief"] is not None:
            last["ai_debrief"] = seqs["ai_debrief"]
            msgs.append(json.dumps({"type": "ai_debrief", **snap["ai_debrief"]}))

        if msgs and clients:
            stale: list[WebSocket] = []
            for ws in list(clients):
                try:
                    for m in msgs:
                        await ws.send_text(m)
                except Exception:
                    stale.append(ws)
            for ws in stale:
                clients.discard(ws)

        await asyncio.sleep(0.03)   # ~30 Hz broadcast tick


@asynccontextmanager
async def lifespan(app: FastAPI):
    _start_tracker()
    task = asyncio.create_task(_broadcast_loop())
    try:
        yield
    finally:
        task.cancel()
        if tracker is not None:
            tracker.stop()


app = FastAPI(lifespan=lifespan)


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


# The React build references these from the site root (e.g. <link href="/favicon.svg">),
# so serve them at root rather than only under /static.
@app.get("/favicon.svg")
async def favicon():
    return FileResponse(STATIC_DIR / "favicon.svg")


@app.get("/icons.svg")
async def icons():
    return FileResponse(STATIC_DIR / "icons.svg")


if STATIC_DIR.exists():
    # The React build (static/index.html) loads its bundle from /assets/*, so
    # that path has to be mounted alongside /static for the UI to render.
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


# ---------------------------------------------------------------------------
# PT prescription upload.
# ---------------------------------------------------------------------------
class PrescriptionUpload(BaseModel):
    text: str


@app.post("/profile/upload")
async def upload_profile(payload: PrescriptionUpload):
    """Accept a free-form prescription text, parse via Gemini, install as the
    next set's profile. Returns the parsed profile JSON."""
    if tracker is None:
        raise HTTPException(503, "tracker not ready yet")
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(400, "empty prescription text")

    parsed = ai_agent.parse_prescription(text)
    if parsed is None:
        raise HTTPException(
            502,
            "Could not parse prescription. Check GEMINI_API_KEY and try again."
        )

    tracker.set_profile(parsed)
    # Applying immediately is the demo-friendly behaviour: PT uploads while
    # patient is between sets, then patient (or PT) clicks Start Next Set
    # which calls reset_set. We pre-apply here too so the live state shows
    # the new targets right away.
    tracker.reset_set()
    bridge.push_profile(parsed, source="uploaded")

    return JSONResponse({"profile": parsed.to_dict(), "source": "uploaded"})


class TTSRequest(BaseModel):
    text: str


@app.post("/tts")
async def tts_synthesize(payload: TTSRequest):
    """Render debrief text to speech via ElevenLabs, returning MP3 audio.

    Returns 503 when no ElevenLabs key is configured (or synthesis fails) so the
    frontend falls back to the browser's built-in SpeechSynthesis voice. Voice is
    never load-bearing.
    """
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(400, "empty text")
    if not tts.is_available():
        raise HTTPException(503, "TTS not configured (no ELEVENLABS_API_KEY)")
    # Offload the blocking HTTP call so we don't stall the event loop.
    audio = await asyncio.to_thread(tts.synthesize, text)
    if not audio:
        raise HTTPException(502, "TTS synthesis failed")
    return Response(content=audio, media_type="audio/mpeg")


@app.get("/exercises")
async def list_exercises():
    """Available exercises for the dropdown + which one is active."""
    active = tracker.exercise_spec.id if tracker is not None else exercise_spec.DEFAULT_EXERCISE.id
    return JSONResponse({"exercises": exercise_spec.options(), "active": active})


class ExerciseDoc(BaseModel):
    text: str


@app.post("/exercise/load")
async def load_exercise(payload: ExerciseDoc):
    """Generate an Exercise Spec from a PT's written documentation (Gemini, ONCE)
    and install it on the tracker, so the SAME real-time engine now coaches that
    exercise. The LLM never runs on the per-frame rep path.

    Falls back to the default squat spec (with an `error` message) if generation
    fails — voice/AI is never load-bearing.
    """
    if tracker is None:
        raise HTTPException(503, "tracker not ready yet")
    text = (payload.text or "").strip()
    if not text:
        raise HTTPException(400, "empty documentation")

    result = await asyncio.to_thread(spec_generator.generate_spec_from_docs, text)
    try:
        spec = ExerciseSpec.from_dict(result["spec"])
    except Exception as e:
        raise HTTPException(502, f"generated spec failed validation: {e}")

    # Register so it shows up in the dropdown + is reselectable, then install it.
    exercise_spec.REGISTRY[spec.id] = spec
    tracker.load_exercise_spec(spec)

    return JSONResponse({
        "spec": result["spec"],
        "source": result["source"],
        "error": result["error"],
        "active": spec.id,
    })


@app.get("/profile")
async def get_profile():
    """Return the currently active profile."""
    if tracker is None:
        return JSONResponse({"profile": DEFAULT_PROFILE.to_dict(), "source": "default"})
    return JSONResponse({"profile": tracker.profile.to_dict(),
                         "source": tracker.profile.source})


# ---------------------------------------------------------------------------
# Session lifecycle + BigQuery-backed PT view.
# ---------------------------------------------------------------------------
@app.get("/session")
async def get_session():
    """Current session metadata + in-memory set summaries (live, no BQ delay)."""
    with _session_lock:
        return JSONResponse({
            "session_id": SESSION_ID,
            "user_id": SESSION_USER_ID,
            "started_at": SESSION_STARTED_AT.isoformat(),
            "sets_count": len(session_summaries),
            "set_index": set_index,
            "summaries": list(session_summaries),
            "bq_available": bq.is_available(),
            "gemini_available": bool(os.environ.get("GEMINI_API_KEY", "").strip()),
            "tts_available": tts.is_available(),
        })


def _build_sts_observation(sid, user_id, started_at, summaries, total_reps,
                           sets_count, active_profile):
    """Build a FHIR STS Observation for the clinician handoff (best-effort).

    Returns (observation_dict | None, share_url | None). Requires age +
    sex_at_birth in the live _user_context; otherwise returns (None, None).
    Stores the observation in _observation_store so /share can serve it even
    without BigQuery.
    """
    if not (_user_context.get("age") and _user_context.get("sex_at_birth")):
        return None, None

    conf_values = [
        float(s.get("tracking_confidence_mean", s.get("fusion_confidence", 0.0)))
        for s in summaries
    ]
    tracking_conf_mean = sum(conf_values) / len(conf_values) if conf_values else 0.0
    concentric_vals = [float(s.get("mean_concentric_s", 1.0)) for s in summaries]
    eccentric_vals = [float(s.get("mean_eccentric_s", 1.0)) for s in summaries]
    all_depths_raw = []
    for s in summaries:
        all_depths_raw.extend(s.get("rep_depths_deg") or [])
    peak_flexion = float(min(all_depths_raw)) if all_depths_raw else 180.0

    obs_session = {
        "session_id": sid,
        "patient_ref": f"Patient/{user_id}",
        "effective_dt": started_at.isoformat(),
        "issued_dt": datetime.now(timezone.utc).isoformat(),
        "reps": total_reps,
        "age": _user_context["age"],
        "sex": _user_context["sex_at_birth"],
        "uses_arm_support": False,
        "tracking_source": "fused",
        "tracking_confidence_mean": round(tracking_conf_mean, 3),
        "calibration_id": f"cal-{sid}",
        "mean_concentric_s": round(sum(concentric_vals) / len(concentric_vals), 2) if concentric_vals else 1.0,
        "mean_eccentric_s": round(sum(eccentric_vals) / len(eccentric_vals), 2) if eccentric_vals else 1.0,
        "peak_knee_flexion_deg": peak_flexion,
        "rom_delta_vs_baseline_deg": 0.0,
        "pain_nprs": None,
        "adherence_completed": sets_count,
        "adherence_prescribed": int(active_profile.sets),
        "clinical_flags": {
            "rom_regression": False,
            "tempo_guarding": False,
            "progression_stalled": False,
        },
    }
    try:
        sts_obs = build_sts_observation(obs_session)
    except ValueError as e:
        # Age outside the validated 60-94 range — build a raw observation
        # without norm classification (fhir_observation §6).
        print(f"[server] FHIR observation: age out of range, building without norms: {e}")
        from fhir_observation import _component  # noqa: F401  (kept for parity)
        sts_obs = {
            "resourceType": "Observation",
            "id": sid,
            "meta": {"tag": [{"system": "urn:physiofusion:tags", "code": "patient-administered-remote-assessment"}]},
            "status": "final" if tracking_conf_mean >= QUALITY_THRESHOLD else "preliminary",
            "code": {"coding": [{"system": "http://loinc.org", "code": "66247-8", "display": "30-second Chair Stand Test"}]},
            "subject": {"reference": f"Patient/{user_id}"},
            "effectiveDateTime": started_at.isoformat(),
            "valueQuantity": {"value": total_reps, "unit": "reps"},
            "note": [
                {"text": "This observation is observational data intended for clinician review and is NOT a clinical diagnosis."},
                {"text": f"Age {_user_context['age']} is outside the validated range (60-94); norm classification omitted."},
            ],
            "component": [],
        }
    except Exception as e:
        print(f"[server] FHIR observation build failed: {e}")
        return None, None

    _observation_store[sid] = sts_obs
    return sts_obs, f"/share/{sid}"


def _finalize_session() -> dict:
    """Finalize the current session: write the session row to BigQuery, call
    Gemini for a PT-facing progress report, then rotate to a fresh session.

    Returns the report text (or None) plus aggregates. Safe with zero sets.
    Used by both POST /session/end and the voice agent's end_session action.
    """
    with _session_lock:
        sid = SESSION_ID
        started_at = SESSION_STARTED_AT
        user_id = SESSION_USER_ID
        summaries = list(session_summaries)
        notes = list(session_notes)
    if not summaries:
        _new_session()
        return {
            "session_id": sid, "sets_count": 0, "total_reps": 0,
            "report": None, "reason": "no sets in this session",
            "patient_notes": [n["text"] for n in notes],
        }

    sets_count = len(summaries)
    total_reps = sum(int(s.get("reps_completed", 0)) for s in summaries)
    depths = []
    for s in summaries:
        rd = s.get("rep_depths_deg") or []
        depths.extend(rd)
    avg_depth = round(sum(depths) / len(depths), 1) if depths else 0.0
    # Adherence: did every set hit its rep target?
    all_targets_hit = all(
        int(s.get("reps_completed", 0)) >= int(s.get("rep_target", 0))
        for s in summaries
    )
    adherence_flag = "complete" if all_targets_hit else "partial"

    active_profile = tracker.profile if tracker is not None else DEFAULT_PROFILE

    # FHIR STS Observation for clinician handoff (None unless user-context set).
    sts_obs, share_url = _build_sts_observation(
        sid, user_id, started_at, summaries, total_reps, sets_count, active_profile
    )

    # Write the session row (best-effort).
    bq.insert_session(
        session_id=sid, user_id=user_id, started_at=started_at,
        sets_count=sets_count, total_reps=total_reps,
        avg_depth=avg_depth, adherence_flag=adherence_flag,
        sts_observation=sts_obs,
    )

    # Gemini progress report (gracefully degrades to None).
    report = ai_agent.generate_session_report(active_profile, summaries)

    # Rotate to a fresh session_id so subsequent sets start clean.
    _new_session()

    return {
        "session_id": sid,
        "user_id": user_id,
        "sets_count": sets_count,
        "total_reps": total_reps,
        "avg_depth": avg_depth,
        "adherence_flag": adherence_flag,
        "report": report,
        "share_url": share_url,
        "sts_observation": sts_obs,
        "patient_notes": [n["text"] for n in notes],
    }


@app.post("/session/end")
async def end_session():
    """Finalize the current session and return the PT report + aggregates."""
    return JSONResponse(await asyncio.to_thread(_finalize_session))


@app.get("/sets/recent")
async def sets_recent(limit: int = 50):
    """Most recent N sets from BigQuery, latest first. Powers View B trends.

    Returns an empty list if BQ isn't configured — the UI can fall back to
    the in-memory `/session` summaries.
    """
    rows = bq.query_recent_sets(limit=max(1, min(int(limit), 500)))
    return JSONResponse({"rows": rows, "bq_available": bq.is_available()})


# ---------------------------------------------------------------------------
# Clinician handoff: user context + FHIR Observation sharing.
# ---------------------------------------------------------------------------
class UserContext(BaseModel):
    age: int
    sex_at_birth: str  # "male" | "female"


@app.post("/user-context")
async def set_user_context(ctx: UserContext):
    """Set age + biological sex for norm-stratified STS interpretation."""
    global _user_context
    if ctx.sex_at_birth not in ("male", "female"):
        raise HTTPException(400, "sex_at_birth must be 'male' or 'female'")
    if ctx.age < 1 or ctx.age > 120:
        raise HTTPException(400, "age must be between 1 and 120")
    _user_context = {"age": ctx.age, "sex_at_birth": ctx.sex_at_birth}
    return JSONResponse({"status": "ok", "user_context": _user_context})


@app.get("/user-context")
async def get_user_context():
    return JSONResponse({"user_context": _user_context})


@app.get("/share/{session_id}")
async def share_handoff_page(session_id: str):
    """Serve the SPA shell; the frontend fetches the observation via the API."""
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/share/{session_id}")
async def share_handoff_api(session_id: str):
    """Return the FHIR Observation for a session (in-memory store, then BQ)."""
    obs = _observation_store.get(session_id)
    if obs is None:
        row = bq.query_session(session_id)
        if row and row.get("sts_observation"):
            obs = row["sts_observation"]
    if obs is None:
        raise HTTPException(404, "No observation found for this session. "
                            "The session may not exist or tracking quality "
                            "was insufficient.")
    return JSONResponse({"session_id": session_id, "observation": obs})


# ---------------------------------------------------------------------------
# Voice agent. A finalized speech transcript from the browser is turned into a
# spoken reply + an optional action (start/end/next set, end session) by Gemini,
# executed on the tracker, then broadcast to all dashboard clients.
# ---------------------------------------------------------------------------
async def _broadcast(payload: dict) -> None:
    msg = json.dumps(payload)
    for ws in list(clients):
        try:
            await ws.send_text(msg)
        except Exception:
            clients.discard(ws)


def _agent_context() -> dict:
    """Live session context handed to the voice agent so it can answer
    specifically ('how did I do', 'what's my prescription', 'sets left')."""
    prof = tracker.profile if tracker is not None else DEFAULT_PROFILE
    with _session_lock:
        sets_count = len(session_summaries)
        last = session_summaries[-1] if session_summaries else None
    ctx = {
        "phase": tracker.phase if tracker is not None else "WAITING_FOR_START",
        "exercise": tracker.exercise_spec.display_name if tracker is not None else "Squat",
        "prescription": prof.to_dict(),
        "rep_target": tracker.rep_target if tracker is not None else prof.reps_per_set,
        "current_reps": tracker.counter.rep_count if tracker is not None else 0,
        "sets_completed_this_session": sets_count,
        "sets_prescribed": prof.sets,
        "patient_notes": [n["text"] for n in session_notes],
    }
    if last:
        depth = (last.get("analysis") or {}).get("depth") or {}
        ctx["last_set"] = {
            "set_index": last.get("set_index"),
            "score": last.get("set_score"),
            "reps_completed": last.get("reps_completed"),
            "rep_target": last.get("rep_target"),
            "avg_depth_deg": depth.get("mean_deg"),
            "target_hit_rate": depth.get("target_hit_rate"),
            "depth_trend": depth.get("trend"),
        }
    return ctx


async def _handle_voice(text: str) -> None:
    if tracker is None:
        return
    ctx = _agent_context()
    with _session_lock:
        hist = list(conversation)[-6:]
    result = await asyncio.to_thread(ai_agent.converse, text, ctx, hist)
    speech = (result.get("speech") or "").strip()
    action = result.get("action", "none")

    with _session_lock:
        conversation.append({"role": "patient", "text": text})
        if speech:
            conversation.append({"role": "coach", "text": speech})
        del conversation[:-20]  # cap history

    payload = {"type": "agent_reply", "text": speech, "action": action}

    if action == "start_set":
        tracker.start_set()
    elif action == "end_set":
        tracker.request_set_end()
    elif action == "note":
        # Record the patient's own words against the session for the PT handoff.
        with _session_lock:
            session_notes.append({
                "text": text,
                "at": datetime.now(timezone.utc).isoformat(),
                "phase": tracker.phase if tracker is not None else None,
            })
        payload["note_count"] = len(session_notes)
    elif action == "next_set":
        tracker.reset_set()
        bridge.push_profile(tracker.profile, source=tracker.profile.source)
    elif action == "end_session":
        fin = await asyncio.to_thread(_finalize_session)
        payload["report"] = fin
        if not speech:
            payload["text"] = "Here's your session report."

    await _broadcast(payload)


# ---------------------------------------------------------------------------
# WebSocket.
# ---------------------------------------------------------------------------
@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)
    try:
        # Send last known frame / state / profile / summary so fresh clients
        # aren't blank.
        snap = bridge.snapshot()
        if snap["frame_b64"] is not None:
            await websocket.send_text(json.dumps({"type": "frame", "jpeg": snap["frame_b64"]}))
        if snap["profile"] is not None:
            await websocket.send_text(json.dumps({"type": "profile", **snap["profile"]}))
        if snap["state"] is not None:
            await websocket.send_text(json.dumps({"type": "state", "state": snap["state"]}))
        if snap["set_summary"] is not None:
            await websocket.send_text(json.dumps({"type": "set_end", "summary": snap["set_summary"]}))
        if snap["ai_debrief"] is not None:
            await websocket.send_text(json.dumps({"type": "ai_debrief", **snap["ai_debrief"]}))

        while True:
            data = await websocket.receive_text()
            try:
                msg = json.loads(data)
            except json.JSONDecodeError:
                continue
            cmd = msg.get("cmd")
            if cmd == "say" and tracker is not None:
                # Conversational voice turn from the browser's speech recognizer.
                text = (msg.get("text") or "").strip()
                if text:
                    await _handle_voice(text)
            elif cmd == "start_set" and tracker is not None:
                # Voice "start set" / on-screen Start button — begins the
                # countdown from WAITING_FOR_START, or advances after a debrief.
                tracker.start_set()
            elif cmd == "end_set" and tracker is not None:
                tracker.request_set_end()
            elif cmd in ("reset_set", "next_set") and tracker is not None:
                target = msg.get("rep_target")
                tracker.reset_set(rep_target=int(target) if target else None)
                # Profile may have been pending; broadcast the now-active one.
                bridge.push_profile(tracker.profile, source=tracker.profile.source)
            elif cmd == "set_imu" and tracker is not None:
                # IMU sensor-fusion toggle from the check-in screen. When off the
                # tracker is camera-only (occlusion -> "none"); when on the
                # visibility-adaptive Kalman fusion drives the tracking-source panel.
                tracker.set_imu_enabled(bool(msg.get("enabled", True)))
            elif cmd == "select_exercise" and tracker is not None:
                # Switch the graded exercise (squat / push-up). Applied now if no
                # set is in flight, else queued for the next set. The change shows
                # up on the next per-frame state broadcast (which carries it).
                ex_id = (msg.get("id") or msg.get("exercise") or "").strip()
                if ex_id:
                    tracker.select_exercise(ex_id)
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(websocket)
