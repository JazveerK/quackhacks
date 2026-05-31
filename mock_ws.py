"""Standalone mock WebSocket server for UI preview.
Streams fake squat data so the dashboard can be previewed without
the camera, IMU, or full backend dependencies.

Usage:
    cd frontend && npx vite build   # build to ../static/
    .venv/bin/python mock_ws.py
    # open http://localhost:8000
"""

import asyncio
import json
import math
import time
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

STATIC_DIR = Path(__file__).parent / "static"

app = FastAPI()

PROFILE = {
    "patient_name": "Sam",
    "condition": "post-ACL repair, left knee, 6 weeks",
    "sets": 3,
    "reps_per_set": 8,
    "depth_deg": 100.0,
    "tempo_sec": 3.0,
    "focus": "controlled eccentric; quad re-engagement",
    "contraindications": ["no valgus collapse", "no pain in L knee"],
    "source": "default",
}


def make_summary(reps=8):
    depths = [88, 89, 90, 91, 93, 96, 99, 103][:reps]
    return {
        "exercise": "bodyweight_squat",
        "reps_completed": len(depths),
        "rep_target": reps,
        "rep_depths_deg": depths,
        "target_depth_deg": 95,
        "depth_trend": "declining_late",
        "form_flag_counts": {"shallow": 2, "too_fast": 0},
        "fatigue_signal": "depth_decline",
        "analysis": {
            "set_duration_sec": 32.0,
            "voided_reps": 0,
            "depth": {
                "per_rep_deg": depths,
                "mean_deg": round(sum(depths) / len(depths), 1),
                "stddev_deg": 5.1,
                "min_deg": min(depths),
                "max_deg": max(depths),
                "target_deg": 95,
                "reps_at_or_below_target": sum(1 for d in depths if d <= 95),
                "target_hit_rate": round(sum(1 for d in depths if d <= 95) / len(depths), 2),
                "trend": "declining_late",
                "first_half_avg_deg": round(sum(depths[: len(depths) // 2]) / (len(depths) // 2), 1),
                "second_half_avg_deg": round(sum(depths[len(depths) // 2 :]) / (len(depths) - len(depths) // 2), 1),
                "halves_delta_deg": 6.5,
            },
            "tempo": {
                "per_rep_sec": [2.0] * len(depths),
                "eccentric_per_rep_sec": [0.9] * len(depths),
                "concentric_per_rep_sec": [1.1] * len(depths),
                "mean_sec": 2.0,
                "stddev_sec": 0.2,
                "trend": "consistent",
                "halves_delta_sec": 0.1,
                "eccentric_concentric_ratio_mean": 0.82,
            },
            "rom": {"min_deg": min(depths), "max_deg": 175},
            "form": {
                "flag_counts": {"shallow": 2, "too_fast": 0},
                "shallow_rep_indices": [7, 8],
                "fast_rep_indices": [],
                "notes": ["5 of 8 reps at or below target."],
            },
            "tracking": {
                "camera_frame_ratio": 0.91,
                "imu_frame_ratio": 0.09,
                "occlusion_events": 1,
            },
        },
        "templated_debrief": (
            "Completed 8 of 8 reps. Average depth 93 degrees "
            "(63% at target 95 degrees). Depth dropped off in the second half. "
            "Next set, try 6 reps and focus on hitting depth on every one."
        ),
        "profile": PROFILE,
        "ai_debrief": (
            "Nice work Sam. You hit depth on 5 of 8 reps, and your "
            "eccentric stayed solid early. The last two reps came up a bit "
            "shy of target. Next set, drop to 6 reps and hold one count "
            "at the bottom."
        ),
    }


@app.get("/")
async def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/profile")
async def get_profile():
    return JSONResponse({"profile": PROFILE, "source": "default"})


# Serve built assets
if (STATIC_DIR / "assets").exists():
    app.mount("/assets", StaticFiles(directory=str(STATIC_DIR / "assets")), name="assets")


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()

    # Send initial profile
    await ws.send_text(json.dumps({"type": "profile", "profile": PROFILE, "source": "default"}))

    t0 = time.time()
    reps = 0
    rep_depths = []
    phase = "SET_ACTIVE"
    rep_target = 8
    set_ended = False

    try:
        while True:
            # Check for incoming commands (non-blocking)
            try:
                data = await asyncio.wait_for(ws.receive_text(), timeout=0.04)
                msg = json.loads(data)
                if msg.get("cmd") == "end_set" and not set_ended:
                    set_ended = True
                    phase = "SET_END"
                elif msg.get("cmd") == "reset_set":
                    t0 = time.time()
                    reps = 0
                    rep_depths = []
                    phase = "SET_ACTIVE"
                    set_ended = False
            except asyncio.TimeoutError:
                pass

            if set_ended:
                summary = make_summary(max(reps, 1))
                await ws.send_text(json.dumps({"type": "set_end", "summary": summary}))
                phase = "DEBRIEF"
                await ws.send_text(json.dumps({
                    "type": "state",
                    "state": {
                        "phase": phase, "angle": 170, "rep_count": reps,
                        "rep_target": rep_target, "rom_min": 88, "rom_max": 175,
                        "depth_state": "shallow", "form_flags": [], "tempo": 2.0,
                        "imu_quality": 0.95, "landmark_visibility": 0.9,
                        "tracking_source": "camera", "rep_depths": list(rep_depths),
                        "setup_status": {"ok": True, "severity": "good", "code": "ok", "hint": "Tracking."},
                        "profile": PROFILE,
                    },
                }))
                await asyncio.sleep(1.5)
                await ws.send_text(json.dumps({
                    "type": "ai_debrief",
                    "text": summary["ai_debrief"],
                    "summary_seq": 1,
                }))
                # Stay in debrief until reset
                while True:
                    try:
                        data = await asyncio.wait_for(ws.receive_text(), timeout=0.1)
                        msg = json.loads(data)
                        if msg.get("cmd") == "reset_set":
                            t0 = time.time()
                            reps = 0
                            rep_depths = []
                            phase = "SET_ACTIVE"
                            set_ended = False
                            break
                    except asyncio.TimeoutError:
                        pass
                continue

            t = time.time() - t0
            cycle = t * (2 * math.pi / 4)
            angle = 130 + 45 * math.sin(cycle)

            prev_reps = reps
            reps = min(int(t // 4), rep_target)
            if reps > prev_reps and reps <= rep_target:
                rep_depths.append(round(85 + (reps - 1) * 2.5, 1))

            # Occlusion simulation: every 12s, flip to IMU for 3s
            occluded = (int(t) % 12) >= 9

            if reps >= rep_target and not set_ended:
                set_ended = True
                phase = "SET_END"
                continue

            flags = []
            if 100 < angle < 120 and reps >= 5:
                flags = ["shallow"]

            depth_state = "below_parallel" if angle < 95 else "at_parallel" if angle < 100 else "shallow"

            state = {
                "phase": phase,
                "angle": round(angle, 1),
                "rep_count": reps,
                "rep_target": rep_target,
                "rom_min": min(rep_depths) if rep_depths else round(angle, 1),
                "rom_max": 175.0,
                "depth_state": depth_state,
                "form_flags": flags,
                "tempo": 2.0,
                "imu_quality": 0.95,
                "landmark_visibility": 0.15 if occluded else 0.88,
                "tracking_source": "imu" if occluded else "camera",
                "rep_depths": list(rep_depths),
                "setup_status": {
                    "ok": not occluded,
                    "severity": "warning" if occluded else "good",
                    "code": "legs_out_of_frame" if occluded else "ok",
                    "hint": "Step back so your full body is in the camera." if occluded else "Tracking — go.",
                },
                "profile": PROFILE,
            }

            await ws.send_text(json.dumps({"type": "state", "state": state}))
            await asyncio.sleep(1 / 25)

    except WebSocketDisconnect:
        pass


if __name__ == "__main__":
    import uvicorn
    print("Mock server at http://127.0.0.1:8000")
    print("Open http://localhost:8000 in your browser")
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")
