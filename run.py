"""
Launcher for the PhysioFusion local server.

On macOS, AVFoundation requires the camera-permission dialog to be shown from
the main thread. uvicorn's pose-tracker runs on a background thread, so we
pre-flight cv2.VideoCapture from the main thread here (which fires the dialog
the first time), then set OPENCV_AVFOUNDATION_SKIP_AUTH=1 so the worker thread
can open the camera without trying to spin a UI run loop.
"""

from __future__ import annotations

import os
import sys
import time

import cv2

PORT = int(os.environ.get("PF_PORT", "8000"))
CAMERA = int(os.environ.get("PF_CAMERA", "0"))


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
    if sys.platform == "darwin":
        if not preflight_camera(CAMERA):
            print("[run] camera pre-flight failed.")
            print("      Open System Settings → Privacy & Security → Camera, "
                  "enable access for your Terminal (or Python), then retry.")
            return 2
        os.environ["OPENCV_AVFOUNDATION_SKIP_AUTH"] = "1"
        print("[run] camera OK; starting server on "
              f"http://127.0.0.1:{PORT}")

    import uvicorn   # imported after env var is set
    uvicorn.run("server:app", host="127.0.0.1", port=PORT, log_level="info")
    return 0


if __name__ == "__main__":
    sys.exit(main())
