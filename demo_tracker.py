"""
SteadyPT — demo_tracker.py

A camera-less stand-in for PoseTracker, used when PF_DEMO is set (e.g. on a
cloud host with no webcam — Cloud Run, Render, etc.). It drives the exact same
callbacks the real tracker does (on_state / on_set_end / on_ai_debrief /
push_profile) from the synthetic squat set in `mock_state`, so the live
dashboard, debrief, and clinician views all animate on a public submission link
without OpenCV, MediaPipe, or any hardware.

It implements the subset of the PoseTracker interface that server.py calls:
attributes `profile`, `exercise_spec`, `rep_target`, `counter`, `phase`, and the
control methods start_set / next_set / request_set_end / reset_set /
set_profile / load_exercise_spec / select_exercise / set_imu_enabled / stop /
run. The lifecycle mirrors the real one:

    WAITING_FOR_START -> COUNTDOWN -> SET_ACTIVE -> DEBRIEF -> (loop)

so the frontend's Start / End / Next buttons behave normally. With no input it
auto-advances on a loop so the link is self-demoing for a hands-off judge.
"""

from __future__ import annotations

import threading
import time
from typing import Callable, Optional

from profile import PTProfile, DEFAULT_PROFILE
from exercise_spec import ExerciseSpec, DEFAULT_EXERCISE
import mock_state

# Hands-off pacing: how long to idle / hold the debrief before auto-advancing
# so the public link plays on a loop with nobody clicking.
AUTO_START_SEC = 6.0
COUNTDOWN_SEC = 3.0
DEBRIEF_HOLD_SEC = 12.0
IDLE_FPS = 12


class _Counter:
    """Minimal stand-in for RepCounter — server only reads `.rep_count`."""

    def __init__(self) -> None:
        self.rep_count = 0


class DemoTracker:
    def __init__(
        self,
        on_state: Optional[Callable[[dict], None]] = None,
        on_set_end: Optional[Callable[[dict], None]] = None,
        on_ai_debrief: Optional[Callable[[str], None]] = None,
        on_profile_change: Optional[Callable[[PTProfile, str], None]] = None,
        profile: Optional[PTProfile] = None,
    ):
        self.on_state = on_state or (lambda s: None)
        self.on_set_end = on_set_end or (lambda s: None)
        self.on_ai_debrief = on_ai_debrief or (lambda t: None)
        self.on_profile_change = on_profile_change or (lambda p, src: None)

        self.profile: PTProfile = profile or DEFAULT_PROFILE
        self.exercise_spec: ExerciseSpec = DEFAULT_EXERCISE
        self.rep_target: int = int(self.profile.reps_per_set)
        self.counter = _Counter()
        self.phase = "WAITING_FOR_START"
        self.imu_enabled = True

        self._stop = False
        self._start_requested = False
        self._next_requested = False
        self._end_requested = False

    # ----- external control (mirror PoseTracker) -----
    def start_set(self) -> None:
        if self.phase == "WAITING_FOR_START":
            self._start_requested = True
        elif self.phase in ("DEBRIEF", "SET_END"):
            self._next_requested = True

    def next_set(self) -> None:
        self._next_requested = True

    def request_set_end(self) -> None:
        self._end_requested = True

    def reset_set(self, rep_target: Optional[int] = None) -> None:
        if rep_target is not None:
            self.rep_target = int(rep_target)
        elif self.profile is not None:
            self.rep_target = int(self.profile.reps_per_set)
        self._next_requested = True

    def set_profile(self, profile: PTProfile) -> None:
        self.profile = profile.clamp() if hasattr(profile, "clamp") else profile
        self.rep_target = int(self.profile.reps_per_set)

    def load_exercise_spec(self, spec: ExerciseSpec) -> None:
        self.exercise_spec = spec

    def select_exercise(self, exercise_id: str) -> None:
        try:
            from exercise_spec import get as _get
            self.exercise_spec = _get(exercise_id)
        except Exception:
            pass

    def set_imu_enabled(self, enabled: bool) -> None:
        self.imu_enabled = bool(enabled)

    def stop(self) -> None:
        self._stop = True

    # ----- per-frame emit helpers -----
    def _emit(self, **overrides) -> None:
        state = {
            "phase": self.phase,
            "angle": 170.0,
            "rep_count": self.counter.rep_count,
            "rep_target": self.rep_target,
            "rom_min": 170.0,
            "rom_max": 172.0,
            "depth_state": "shallow",
            "form_flags": [],
            "tempo": 0.0,
            "imu_quality": 0.96,
            "landmark_visibility": 0.92,
            "tracking_source": "camera",
            "rep_depths": [],
            "setup_status": {"ok": True, "severity": "good", "code": "ok",
                             "hint": "Tracking — go."},
            "profile": self.profile.to_dict(),
        }
        state.update(overrides)
        self.on_state(state)

    def _sleep_steps(self, seconds: float, fps: int = IDLE_FPS) -> bool:
        """Sleep `seconds`, returning True early if a transition is requested."""
        steps = max(1, int(seconds * fps))
        for _ in range(steps):
            if self._stop or self._start_requested or self._next_requested:
                return True
            time.sleep(1.0 / fps)
        return False

    # ----- main loop -----
    def run(self) -> None:
        self.on_profile_change(self.profile, getattr(self.profile, "source", "demo"))
        while not self._stop:
            # --- WAITING_FOR_START: idle "ready" frames; auto-start after a beat.
            self.phase = "WAITING_FOR_START"
            self.counter.rep_count = 0
            self._start_requested = False
            self._next_requested = False
            self._end_requested = False
            waited = 0.0
            while not self._stop and not self._start_requested and waited < AUTO_START_SEC:
                self._emit(setup_status={"ok": True, "severity": "good",
                                         "code": "ok", "hint": "Ready when you are."})
                time.sleep(1.0 / IDLE_FPS)
                waited += 1.0 / IDLE_FPS
            if self._stop:
                break

            # --- COUNTDOWN.
            self.phase = "COUNTDOWN"
            self._start_requested = False
            for n in (3, 2, 1):
                if self._stop:
                    break
                self._emit(phase="COUNTDOWN", countdown=n,
                           setup_status={"ok": True, "severity": "good",
                                         "code": "ok", "hint": f"Starting in {n}..."})
                time.sleep(COUNTDOWN_SEC / 3.0)
            if self._stop:
                break

            # --- SET_ACTIVE: stream the synthetic squat set.
            self.phase = "SET_ACTIVE"
            self._end_requested = False
            for state in mock_state.state_stream(rep_target=self.rep_target):
                if self._stop or self._end_requested:
                    break
                state = dict(state)
                state["phase"] = self.phase if state.get("phase") != "SET_END" else "SET_END"
                self.counter.rep_count = state.get("rep_count", self.counter.rep_count)
                self.on_state(state)
            if self._stop:
                break

            # --- DEBRIEF: emit the set summary + AI debrief, then hold.
            self.phase = "DEBRIEF"
            summary = mock_state.sample_set_summary(rep_target=self.rep_target)
            self.on_set_end(summary)
            debrief = summary.get("ai_debrief") or summary.get("templated_debrief")
            if debrief:
                self.on_ai_debrief(debrief)
            self._emit(phase="DEBRIEF", rep_count=summary.get("reps_completed", 0))
            self._sleep_steps(DEBRIEF_HOLD_SEC)
            # Loop back to WAITING (auto-advance) or honor an explicit next.
