"""
Launcher for the SteadyPT local server.

Two jobs before uvicorn starts:

1. Pick the camera. On macOS both the iPhone (Continuity Camera) and the
   MacBook's built-in camera show up as AVFoundation devices addressed by
   index. We list them by name and let you choose, defaulting to index 0.
   Set PF_CAMERA=<n> to skip the prompt (also used for non-interactive runs).

2. Pre-flight it. AVFoundation requires the camera-permission dialog to be
   shown from the main thread, but uvicorn's pose-tracker runs on a background
   thread — so we open cv2.VideoCapture from the main thread here (firing the
   dialog the first time), then set OPENCV_AVFOUNDATION_SKIP_AUTH=1 so the
   worker thread can open the camera without trying to spin a UI run loop.

The resolved index is handed to the server via the PF_CAMERA env var, which
server._start_tracker() reads.
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
from typing import Optional

import cv2

PORT = int(os.environ.get("PF_PORT", "8000"))


def list_macos_cameras() -> list[str]:
    """Best-effort ordered camera names from `system_profiler`.

    The list order matches the AVFoundation device order OpenCV uses for its
    VideoCapture indices, so each name's position doubles as its camera index.
    Returns [] off macOS or on any parse/timeout failure (caller falls back to
    a plain index prompt / default 0).
    """
    if sys.platform != "darwin":
        return []
    try:
        out = subprocess.run(
            ["system_profiler", "SPCameraDataType"],
            capture_output=True, text=True, timeout=10,
        ).stdout
    except Exception:
        return []
    names: list[str] = []
    for line in out.splitlines():
        stripped = line.strip()
        if not stripped.endswith(":"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        # Device names sit one level under the "Camera:" header (4-space
        # indent); their fields ("Model ID:", "Unique ID:") are deeper and the
        # header itself is at column 0.
        if indent == 4:
            names.append(stripped[:-1])
    return names


def _camera_hint(name: str) -> str:
    low = name.lower()
    if "iphone" in low or "continuity" in low:
        return "  (iPhone / Continuity Camera)"
    if "facetime" in low or "macbook" in low or "built-in" in low or "built in" in low:
        return "  (MacBook built-in)"
    return ""


def _iphone_camera_index(cams: list[str]) -> Optional[int]:
    """Index of the iPhone / Continuity Camera in the device list, or None."""
    for i, name in enumerate(cams):
        low = name.lower()
        if "iphone" in low or "continuity" in low:
            return i
    return None


def choose_camera() -> int:
    """Resolve which camera index to use.

    SteadyPT is built around the iPhone (Continuity Camera) because it can be
    placed at your side for a full side-on view; the MacBook's built-in camera
    can't. So we auto-select the iPhone and never prompt. Priority:
      1. an explicit PF_CAMERA env var (escape hatch for non-interactive runs),
      2. the iPhone / Continuity Camera by name,
      3. fall back to index 0 if no iPhone is connected.
    """
    env = os.environ.get("PF_CAMERA")
    if env is not None and env.strip() != "":
        try:
            return int(env)
        except ValueError:
            print(f"[run] PF_CAMERA={env!r} is not an integer; ignoring it.")

    cams = list_macos_cameras()

    idx = _iphone_camera_index(cams)
    if idx is not None:
        print(f"[run] using iPhone camera {idx}: {cams[idx]}{_camera_hint(cams[idx])}")
        return idx

    if cams:
        print(f"[run] no iPhone / Continuity Camera detected — falling back to "
              f"camera 0: {cams[0]}{_camera_hint(cams[0])}")
        print("      Connect your iPhone (same Apple ID, Wi-Fi + Bluetooth on) and "
              "re-run, or set PF_CAMERA=<n> to force a device.")
    return 0


def preflight_camera(index: int) -> bool:
    print(f"[run] pre-flighting camera index {index} on main thread "
          "(may trigger macOS permission prompt)...")
    cap = cv2.VideoCapture(index)
    ok = False
    if cap.isOpened():
        # Give the device a moment, then grab a frame.
        for _ in range(20):
            ok, _ = cap.read()
            if ok:
                break
            time.sleep(0.1)
    cap.release()
    return ok


def main() -> int:
    camera = choose_camera()
    # Hand the resolved index to the server (read in server._start_tracker()).
    os.environ["PF_CAMERA"] = str(camera)

    if sys.platform == "darwin":
        if not preflight_camera(camera):
            print(f"[run] camera pre-flight failed for index {camera}.")
            print("      Open System Settings → Privacy & Security → Camera, "
                  "enable access for your Terminal (or Python), then retry.")
            print("      If you picked the wrong device, re-run and choose a "
                  "different one (or set PF_CAMERA=<n>).")
            return 2
        os.environ["OPENCV_AVFOUNDATION_SKIP_AUTH"] = "1"
        print(f"[run] camera {camera} OK; starting server on "
              f"http://127.0.0.1:{PORT}")

    import uvicorn   # imported after env vars are set
    uvicorn.run("server:app", host="127.0.0.1", port=PORT, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
