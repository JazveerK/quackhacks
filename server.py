"""
PhysioFusion local server.

Runs the PoseTracker on a daemon thread, broadcasts per-frame state JSON and
JPEG frames to all WebSocket clients, and accepts a few control commands
(end_set, reset_set) coming back from the dashboard.

Run:
    uvicorn server:app --reload --host 127.0.0.1 --port 8000

Then open http://127.0.0.1:8000 in a browser.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import queue
import threading
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from pose_tracker import PoseTracker, MockIMU

STATIC_DIR = Path(__file__).parent / "static"

# ---------------------------------------------------------------------------
# Tracker bridge. Producer (cv2 thread) -> async consumer (broadcast loop).
# ---------------------------------------------------------------------------
class TrackerBridge:
    """Thread-safe bag holding the most recent state + frame."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._state: dict | None = None
        self._frame_b64: str | None = None
        self._set_summary: dict | None = None
        self._frame_seq = 0
        self._state_seq = 0
        self._summary_seq = 0

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

    def snapshot(self) -> tuple[dict | None, str | None, dict | None, int, int, int]:
        with self._lock:
            return (
                self._state,
                self._frame_b64,
                self._set_summary,
                self._state_seq,
                self._frame_seq,
                self._summary_seq,
            )


bridge = TrackerBridge()
tracker: PoseTracker | None = None
tracker_thread: threading.Thread | None = None
clients: set[WebSocket] = set()


def _start_tracker() -> None:
    global tracker, tracker_thread
    rep_target = int(os.environ.get("PF_REP_TARGET", "10"))
    camera_index = int(os.environ.get("PF_CAMERA", "0"))
    tracker = PoseTracker(
        imu_source=MockIMU(),
        on_state=bridge.push_state,
        on_set_end=bridge.push_set_summary,
        on_frame=bridge.push_frame,
        rep_target=rep_target,
        camera_index=camera_index,
        show_window=False,
    )

    def _run():
        try:
            tracker.run()
        except Exception as e:
            print(f"[server] tracker thread crashed: {e}")

    tracker_thread = threading.Thread(target=_run, daemon=True, name="pose-tracker")
    tracker_thread.start()


async def _broadcast_loop() -> None:
    last_state_seq = -1
    last_frame_seq = -1
    last_summary_seq = -1
    while True:
        state, frame_b64, summary, s_seq, f_seq, sm_seq = bridge.snapshot()

        msgs: list[str] = []
        if f_seq != last_frame_seq and frame_b64 is not None:
            last_frame_seq = f_seq
            msgs.append(json.dumps({"type": "frame", "jpeg": frame_b64}))
        if s_seq != last_state_seq and state is not None:
            last_state_seq = s_seq
            msgs.append(json.dumps({"type": "state", "state": state}))
        if sm_seq != last_summary_seq and summary is not None:
            last_summary_seq = sm_seq
            msgs.append(json.dumps({"type": "set_end", "summary": summary}))

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
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.websocket("/ws")
async def ws_endpoint(websocket: WebSocket):
    await websocket.accept()
    clients.add(websocket)
    try:
        # Send last known state/frame immediately so a fresh client isn't blank.
        state, frame_b64, summary, *_ = bridge.snapshot()
        if frame_b64 is not None:
            await websocket.send_text(json.dumps({"type": "frame", "jpeg": frame_b64}))
        if state is not None:
            await websocket.send_text(json.dumps({"type": "state", "state": state}))
        if summary is not None:
            await websocket.send_text(json.dumps({"type": "set_end", "summary": summary}))

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
    except WebSocketDisconnect:
        pass
    finally:
        clients.discard(websocket)
