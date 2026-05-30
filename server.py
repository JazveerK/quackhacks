"""
PhysioFusion local server.

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

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from pose_tracker import PoseTracker, MockIMU
from profile import PTProfile, DEFAULT_PROFILE
import ai_agent
import bq

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


def _new_session() -> None:
    """Reset to a fresh session_id + counters. Called by POST /session/end
    after the closing session row is written."""
    global SESSION_ID, SESSION_STARTED_AT, set_index, session_summaries
    with _session_lock:
        SESSION_ID = uuid.uuid4().hex[:8]
        SESSION_STARTED_AT = datetime.now(timezone.utc)
        set_index = 0
        session_summaries = []


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


def _start_tracker() -> None:
    global tracker, tracker_thread
    camera_index = int(os.environ.get("PF_CAMERA", "0"))
    tracker = PoseTracker(
        imu_source=MockIMU(),
        on_state=bridge.push_state,
        on_set_end=_on_set_end,
        on_frame=bridge.push_frame,
        on_ai_debrief=bridge.push_ai_debrief,
        camera_index=camera_index,
        show_window=False,
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


if STATIC_DIR.exists():
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
        })


@app.post("/session/end")
async def end_session():
    """Finalize the current session: write the session row to BigQuery, call
    Gemini for a PT-facing progress report, then rotate to a fresh session.

    Returns the PT report text (or None) plus the aggregates. Safe to call
    with zero sets — just resets the counter.
    """
    with _session_lock:
        sid = SESSION_ID
        started_at = SESSION_STARTED_AT
        user_id = SESSION_USER_ID
        summaries = list(session_summaries)
    if not summaries:
        _new_session()
        return JSONResponse({
            "session_id": sid, "sets_count": 0, "total_reps": 0,
            "report": None, "reason": "no sets in this session",
        })

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

    # Write the session row (best-effort).
    bq.insert_session(
        session_id=sid, user_id=user_id, started_at=started_at,
        sets_count=sets_count, total_reps=total_reps,
        avg_depth=avg_depth, adherence_flag=adherence_flag,
    )

    # Gemini progress report (gracefully degrades to None).
    active_profile = tracker.profile if tracker is not None else DEFAULT_PROFILE
    report = ai_agent.generate_session_report(active_profile, summaries)

    # Rotate to a fresh session_id so subsequent sets start clean.
    _new_session()

    return JSONResponse({
        "session_id": sid,
        "user_id": user_id,
        "sets_count": sets_count,
        "total_reps": total_reps,
        "avg_depth": avg_depth,
        "adherence_flag": adherence_flag,
        "report": report,
    })


@app.get("/sets/recent")
async def sets_recent(limit: int = 50):
    """Most recent N sets from BigQuery, latest first. Powers View B trends.

    Returns an empty list if BQ isn't configured — the UI can fall back to
    the in-memory `/session` summaries.
    """
    rows = bq.query_recent_sets(limit=max(1, min(int(limit), 500)))
    return JSONResponse({"rows": rows, "bq_available": bq.is_available()})


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
            if cmd == "end_set" and tracker is not None:
                tracker.request_set_end()
            elif cmd == "reset_set" and tracker is not None:
                target = msg.get("rep_target")
                tracker.reset_set(rep_target=int(target) if target else None)
                # Profile may have been pending; broadcast the now-active one.
                bridge.push_profile(tracker.profile, source=tracker.profile.source)
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(websocket)
