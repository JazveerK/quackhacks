"""
PhysioFusion backend core — Agent B.

Pose tracking + squat rep state machine + camera/IMU fusion + per-set summary.

Owns the data contracts in section 4c (per-frame state) and 4d (per-set summary)
of the project brief. Does NOT import the WebSocket server or the real IMU module:
Agent C injects a state callback; Agent A injects an IMU source.

Usage:
    tracker = PoseTracker(
        imu_source=my_imu,         # any obj with .get_latest() -> dict|None
        on_state=ws_broadcast,     # called every frame with 4c JSON-able dict
        on_set_end=gemini_debrief, # called once at set end with 4d summary
        rep_target=10,
    )
    tracker.run()                  # blocks; opens webcam, runs MediaPipe
"""

from __future__ import annotations

import math
import time
from collections import deque
from dataclasses import dataclass, field
from typing import Callable, Optional

import cv2
import mediapipe as mp
import numpy as np

# ---------------------------------------------------------------------------
# Tunables. Squat-specific. Side view assumed.
# ---------------------------------------------------------------------------
REP_TARGET_DEFAULT = 10
TARGET_DEPTH_DEG = 95           # at/below this knee angle counts as parallel
PARALLEL_DEG = 100              # >= this on the deepest point => shallow
DOWN_ENTER_DEG = 115            # crossing below => entering descent/bottom
UP_ENTER_DEG = 155              # crossing above => back to standing (rep done)
STANDING_DEG = 160              # for stillness detection
FAST_REP_SEC = 1.5              # full rep faster than this => too_fast
MIN_REP_SEC = 0.7               # anything faster than this is noise, void it
MAX_REP_SEC = 15.0              # anything slower than this is paused/abandoned
STUCK_DOWN_SEC = 20.0           # stuck in 'down' this long => force reset (sat down)
MIN_CAM_FRAC = 0.5              # rep must be >= this fraction camera-tracked to count
STILL_ANGLE_BAND = 8            # +/- deg considered "still" at top
STILL_SECONDS = 4.0             # standing-still this long => end set
FLAG_TTL_SEC = 2.5              # how long a form flag stays visible per-frame
VIS_THRESHOLD = 0.6             # avg leg-landmark visibility for camera-trusted
LANDMARK_VIS_FLOOR = 0.4        # every leg landmark must clear this
TORSO_VIS_THRESHOLD = 0.5       # shoulder visibility for "in frame" check
SIDE_VIEW_SPREAD_MAX = 0.30     # shoulder/hip horiz spread / torso height (side-on)
NO_POSE_SETUP_SEC = 2.0         # seconds without any pose -> "step into frame"
STALE_FRAME_SEC = 2.0           # seconds without a fresh camera frame -> error
DEBOUNCE_FRAMES = 3             # consecutive frames past threshold to flip phase
ANGLE_EMA_ALPHA = 0.30          # EMA smoothing for angle (0..1, higher = snappier)

# MediaPipe drawing styles. Cyan dots, lighter blue connections for visibility.
import mediapipe.python.solutions.drawing_utils as _du
_LANDMARK_STYLE = _du.DrawingSpec(color=(180, 255, 0), thickness=3, circle_radius=4)
_CONNECTION_STYLE = _du.DrawingSpec(color=(255, 200, 80), thickness=2)

# MediaPipe landmark indices (Pose).
mp_pose = mp.solutions.pose
mp_draw = mp.solutions.drawing_utils
LM = mp_pose.PoseLandmark

LEFT_HIP, LEFT_KNEE, LEFT_ANKLE = LM.LEFT_HIP.value, LM.LEFT_KNEE.value, LM.LEFT_ANKLE.value
RIGHT_HIP, RIGHT_KNEE, RIGHT_ANKLE = LM.RIGHT_HIP.value, LM.RIGHT_KNEE.value, LM.RIGHT_ANKLE.value


# ---------------------------------------------------------------------------
# IMU fallback. Agent A owns the real one; this lets the backend run alone.
# ---------------------------------------------------------------------------
class MockIMU:
    """Steady healthy signal so the backend runs without hardware."""

    def __init__(self):
        self._t0 = time.time()

    def get_latest(self) -> Optional[dict]:
        return {
            "tilt": 25.0,
            "ang_vel": 0.0,
            "smoothness": 0.95,
            "t": time.time() - self._t0,
            "quality": 0.95,
        }


# ---------------------------------------------------------------------------
# Geometry.
# ---------------------------------------------------------------------------
def angle_deg(a: tuple, b: tuple, c: tuple) -> float:
    """Angle at vertex b given points a-b-c, in degrees, 0..180."""
    ax, ay = a
    bx, by = b
    cx, cy = c
    v1 = (ax - bx, ay - by)
    v2 = (cx - bx, cy - by)
    n1 = math.hypot(*v1)
    n2 = math.hypot(*v2)
    if n1 == 0 or n2 == 0:
        return 180.0
    cosv = (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)
    cosv = max(-1.0, min(1.0, cosv))
    return math.degrees(math.acos(cosv))


def imu_tilt_to_knee_angle(tilt_deg: float) -> float:
    """Map thigh tilt (vs gravity) to knee angle. Placeholder mapping.

    Standing: thigh vertical -> tilt ~0 -> knee ~180.
    Parallel: thigh horizontal -> tilt ~90 -> knee ~90.
    Agent A's calibration may replace this with a learned map.
    """
    return max(60.0, min(180.0, 180.0 - tilt_deg))


# ---------------------------------------------------------------------------
# Rep state machine. Hysteresis between down/up to avoid bounce.
# ---------------------------------------------------------------------------
DESCENT_START_DEG = 165             # angle below which we consider descent started


@dataclass
class _RepState:
    phase: str = "up"               # "up" | "down"
    rep_start_t: float = 0.0        # when down phase entered (stuck-down check)
    t_descent_start: float = 0.0    # when body started lowering (eccentric calc)
    min_angle_this_rep: float = 180.0
    t_at_min: float = 0.0           # time the deepest point was reached
    cam_frames: int = 0             # camera-sourced frames during this rep
    imu_frames: int = 0             # imu-sourced frames during this rep


class SquatCounter:
    """Counts reps, tracks per-rep depth, emits per-rep form flags.

    Per-rep records (parallel arrays indexed by rep number):
        rep_depths        — min knee angle (deg)
        rep_tempos        — total seconds (eccentric + concentric)
        rep_eccentric     — descent seconds (rep_start -> deepest point)
        rep_concentric    — ascent + hold seconds (deepest point -> rep_end)
        rep_flags         — list of form flags raised on that rep
        rep_cam_frac      — fraction of rep frames that were camera-tracked
        rep_end_t         — clock time the rep completed
    """

    def __init__(self):
        self._s = _RepState()
        self.rep_count = 0
        self.rep_depths: list[float] = []
        self.rep_tempos: list[float] = []
        self.rep_eccentric: list[float] = []
        self.rep_concentric: list[float] = []
        self.rep_flags: list[list[str]] = []
        self.rep_cam_frac: list[float] = []
        self.rep_end_t: list[float] = []
        self.flag_counts: dict[str, int] = {"shallow": 0, "too_fast": 0}
        self.voided_reps = 0
        self._down_streak = 0
        self._up_streak = 0
        self._t_last_standing: float = 0.0

    def pause_streaks(self) -> None:
        """Call when input is untrustworthy (e.g., tracking source changed)."""
        self._down_streak = 0
        self._up_streak = 0

    def force_reset_to_up(self) -> None:
        """Abandon the current rep without counting. Used when stuck in 'down'
        for too long (user sat down, walked off, etc.)."""
        self._s = _RepState()
        self._down_streak = 0
        self._up_streak = 0

    def update(self, angle: float, now: float, source: str = "camera") -> list[str]:
        """Feed one frame's smoothed angle. Returns flags newly raised this frame.

        `source` is the tracking source ("camera" or "imu") for THIS frame.
        Per-rep camera fraction drives a rep-validity check at completion.
        """
        flags: list[str] = []
        s = self._s

        # Track most-recent "standing" frame so we can attribute the full
        # descent (not just the part below DOWN_ENTER_DEG) as eccentric time.
        if angle >= DESCENT_START_DEG:
            self._t_last_standing = now

        if s.phase == "up":
            if angle < DOWN_ENTER_DEG:
                self._down_streak += 1
            else:
                self._down_streak = 0
            if self._down_streak >= DEBOUNCE_FRAMES:
                s.phase = "down"
                s.rep_start_t = now
                s.t_descent_start = (
                    self._t_last_standing if self._t_last_standing > 0 else now
                )
                s.min_angle_this_rep = angle
                s.t_at_min = now
                s.cam_frames = 0
                s.imu_frames = 0
                self._down_streak = 0
                self._up_streak = 0
        else:  # "down"
            # Track per-frame source attribution for this rep.
            if source == "camera":
                s.cam_frames += 1
            else:
                s.imu_frames += 1

            if angle < s.min_angle_this_rep:
                s.min_angle_this_rep = angle
                s.t_at_min = now
            if angle > UP_ENTER_DEG:
                self._up_streak += 1
            else:
                self._up_streak = 0
            if self._up_streak >= DEBOUNCE_FRAMES:
                depth = s.min_angle_this_rep
                descent_start = s.t_descent_start or s.rep_start_t
                tempo = now - descent_start
                eccentric = max(0.0, s.t_at_min - descent_start)
                concentric = max(0.0, now - s.t_at_min)
                total_frames = s.cam_frames + s.imu_frames
                cam_frac = s.cam_frames / total_frames if total_frames else 0.0

                # Validity gates.
                valid = (
                    MIN_REP_SEC <= tempo <= MAX_REP_SEC
                    and cam_frac >= MIN_CAM_FRAC
                )
                if valid:
                    self.rep_count += 1
                    self.rep_depths.append(round(depth, 1))
                    self.rep_tempos.append(round(tempo, 2))
                    self.rep_eccentric.append(round(eccentric, 2))
                    self.rep_concentric.append(round(concentric, 2))
                    self.rep_cam_frac.append(round(cam_frac, 2))
                    self.rep_end_t.append(now)
                    rep_flags: list[str] = []
                    if depth > PARALLEL_DEG:
                        rep_flags.append("shallow")
                        self.flag_counts["shallow"] += 1
                    if tempo < FAST_REP_SEC:
                        rep_flags.append("too_fast")
                        self.flag_counts["too_fast"] += 1
                    self.rep_flags.append(rep_flags)
                    flags = list(rep_flags)
                else:
                    self.voided_reps += 1
                # Reset rep state regardless.
                s.phase = "up"
                s.min_angle_this_rep = 180.0
                s.cam_frames = 0
                s.imu_frames = 0
                self._down_streak = 0
                self._up_streak = 0
        return flags

    def current_phase(self) -> str:
        return self._s.phase

    def current_rep_start(self) -> float:
        return self._s.rep_start_t

    def last_tempo(self) -> float:
        return self.rep_tempos[-1] if self.rep_tempos else 0.0


# ---------------------------------------------------------------------------
# Main tracker.
# ---------------------------------------------------------------------------
class PoseTracker:
    def __init__(
        self,
        imu_source=None,
        on_state: Optional[Callable[[dict], None]] = None,
        on_set_end: Optional[Callable[[dict], None]] = None,
        on_frame: Optional[Callable[[bytes], None]] = None,
        rep_target: int = REP_TARGET_DEFAULT,
        camera_index: int = 0,
        show_window: bool = True,
        jpeg_quality: int = 70,
        preferred_side: Optional[str] = None,
    ):
        self.imu = imu_source or MockIMU()
        self.on_state = on_state or (lambda s: None)
        self.on_set_end = on_set_end or (lambda summary: None)
        self.on_frame = on_frame or (lambda jpeg: None)
        self.rep_target = rep_target
        self.camera_index = camera_index
        self.show_window = show_window
        self.jpeg_quality = jpeg_quality
        # Optional hint: which side faces the camera ("left" | "right" | None).
        # None means auto-pick the more-visible leg per frame.
        self.preferred_side = preferred_side
        self._stop = False

        self.phase = "SET_ACTIVE"
        self.counter = SquatCounter()
        self.rom_min = 180.0
        self.rom_max = 0.0
        self._active_flags: dict[str, float] = {}   # flag -> expiry epoch
        self._still_since: Optional[float] = None
        self._set_end_requested = False
        self._set_emitted = False
        self._smoothed_angle: Optional[float] = None
        self._last_source: Optional[str] = None

        # Setup-status tracking.
        self._last_pose_t: Optional[float] = None
        self._last_frame_t: Optional[float] = None
        self._last_setup: dict = {
            "ok": False, "severity": "info",
            "code": "starting", "hint": "Setting up..."
        }

        # Cross-set aggregates.
        self._set_start_t: Optional[float] = None
        self._cam_frame_count = 0
        self._imu_frame_count = 0
        self._occlusion_events = 0

    # ----- external control (manual end-set button from UI) -----
    def request_set_end(self) -> None:
        self._set_end_requested = True

    def stop(self) -> None:
        self._stop = True

    def reset_set(self, rep_target: Optional[int] = None) -> None:
        if rep_target is not None:
            self.rep_target = rep_target
        self.phase = "SET_ACTIVE"
        self.counter = SquatCounter()
        self.rom_min = 180.0
        self.rom_max = 0.0
        self._active_flags.clear()
        self._still_since = None
        self._set_end_requested = False
        self._set_emitted = False
        self._smoothed_angle = None
        self._last_source = None
        self._set_start_t = None
        self._cam_frame_count = 0
        self._imu_frame_count = 0
        self._occlusion_events = 0

    # ----- per-frame pipeline -----
    def _extract_leg(self, landmarks) -> tuple[float, float, tuple, tuple, tuple]:
        """Pick the more-visible leg.

        Returns (avg_visibility, min_visibility, hip, knee, ankle).
        min_visibility lets us reject predicted/occluded landmarks even when
        the average looks acceptable.
        """
        def pt(idx):
            lm = landmarks[idx]
            return (lm.x, lm.y), lm.visibility

        lh, lhv = pt(LEFT_HIP)
        lk, lkv = pt(LEFT_KNEE)
        la, lav = pt(LEFT_ANKLE)
        rh, rhv = pt(RIGHT_HIP)
        rk, rkv = pt(RIGHT_KNEE)
        ra, rav = pt(RIGHT_ANKLE)

        left_avg = (lhv + lkv + lav) / 3.0
        right_avg = (rhv + rkv + rav) / 3.0
        # Honor an explicit camera-facing side hint if the caller set one.
        if self.preferred_side == "left":
            return left_avg, min(lhv, lkv, lav), lh, lk, la
        if self.preferred_side == "right":
            return right_avg, min(rhv, rkv, rav), rh, rk, ra
        if right_avg >= left_avg:
            return right_avg, min(rhv, rkv, rav), rh, rk, ra
        return left_avg, min(lhv, lkv, lav), lh, lk, la

    def _update_active_flags(self, new_flags: list[str], now: float) -> list[str]:
        for f in new_flags:
            self._active_flags[f] = now + FLAG_TTL_SEC
        expired = [f for f, exp in self._active_flags.items() if exp <= now]
        for f in expired:
            del self._active_flags[f]
        return list(self._active_flags.keys())

    def _classify_setup(
        self,
        landmarks,
        leg_vis: float,
        leg_vis_min: float,
        camera_trusted: bool,
        now: float,
    ) -> dict:
        """Return a setup_status dict shaped: {ok, severity, code, hint}.

        severity: "good" | "info" | "warning" | "blocking".
        code is a stable machine-readable label so the UI can map to icons.
        """
        # Stale camera.
        if self._last_frame_t is not None and now - self._last_frame_t > STALE_FRAME_SEC:
            return {
                "ok": False, "severity": "blocking", "code": "camera_stale",
                "hint": "Camera not delivering frames — check the connection.",
            }

        # No pose at all.
        if landmarks is None:
            since = (now - self._last_pose_t) if self._last_pose_t else NO_POSE_SETUP_SEC
            if since >= NO_POSE_SETUP_SEC:
                return {
                    "ok": False, "severity": "blocking", "code": "no_person",
                    "hint": "Step into the camera's view, sideways to the camera.",
                }
            return {
                "ok": True, "severity": "info", "code": "searching",
                "hint": "Looking for you...",
            }

        # Pose detected — check framing.
        ls = landmarks[LM.LEFT_SHOULDER.value]
        rs = landmarks[LM.RIGHT_SHOULDER.value]
        lh = landmarks[LM.LEFT_HIP.value]
        rh = landmarks[LM.RIGHT_HIP.value]

        upper_in_frame = ls.visibility > TORSO_VIS_THRESHOLD or rs.visibility > TORSO_VIS_THRESHOLD
        legs_in_frame = leg_vis >= VIS_THRESHOLD and leg_vis_min >= LANDMARK_VIS_FLOOR

        if upper_in_frame and not legs_in_frame:
            return {
                "ok": False, "severity": "warning", "code": "legs_out_of_frame",
                "hint": "Step back so your full body is in the camera.",
            }

        if not upper_in_frame and legs_in_frame:
            return {
                "ok": False, "severity": "warning", "code": "torso_out_of_frame",
                "hint": "Tilt the camera up so your torso is in frame.",
            }

        if not upper_in_frame and not legs_in_frame:
            return {
                "ok": False, "severity": "warning", "code": "partial_body",
                "hint": "Position the camera so your whole body is visible.",
            }

        # Side-view check: in side view shoulders/hips overlap heavily in x.
        # In front view they spread out. Normalize spread by torso height.
        sh_spread = abs(ls.x - rs.x)
        hip_spread = abs(lh.x - rh.x)
        torso_h = abs(((ls.y + rs.y) / 2.0) - ((lh.y + rh.y) / 2.0))
        if torso_h > 1e-3:
            spread = max(sh_spread, hip_spread) / torso_h
            if spread > SIDE_VIEW_SPREAD_MAX:
                return {
                    "ok": False, "severity": "warning", "code": "not_side_view",
                    "hint": "Turn sideways to the camera (we need a side view).",
                }

        if not camera_trusted:
            return {
                "ok": False, "severity": "warning", "code": "low_visibility",
                "hint": "Move into better light or step closer to the camera.",
            }

        return {
            "ok": True, "severity": "good", "code": "ok",
            "hint": "Tracking — go.",
        }

    @staticmethod
    def _depth_state(angle: float) -> str:
        if angle <= TARGET_DEPTH_DEG:
            return "below_parallel"
        if angle <= PARALLEL_DEG:
            return "at_parallel"
        return "shallow"

    def _check_set_end(self, angle: float, now: float) -> bool:
        if self._set_end_requested:
            return True
        if self.counter.rep_count >= self.rep_target:
            return True
        # Stillness: standing tall, not moving for STILL_SECONDS.
        if angle >= STANDING_DEG and self.counter.current_phase() == "up":
            if self._still_since is None:
                self._still_since = now
            elif now - self._still_since >= STILL_SECONDS and self.counter.rep_count > 0:
                return True
        else:
            self._still_since = None
        return False

    # ----- summary builders -----
    @staticmethod
    def _mean(xs: list[float]) -> float:
        return sum(xs) / len(xs) if xs else 0.0

    @staticmethod
    def _stddev(xs: list[float]) -> float:
        if len(xs) < 2:
            return 0.0
        m = sum(xs) / len(xs)
        return (sum((x - m) ** 2 for x in xs) / (len(xs) - 1)) ** 0.5

    @staticmethod
    def _halves(xs: list[float]) -> tuple[list[float], list[float]]:
        if len(xs) < 2:
            return xs, []
        mid = len(xs) // 2
        return xs[:mid], xs[mid:]

    def _trend(self, xs: list[float], threshold: float,
               improving_label: str, worsening_label: str) -> tuple[str, float]:
        """Compare first vs second half of `xs`. Returns (label, delta)."""
        if len(xs) < 4:
            return "insufficient_data", 0.0
        early, late = self._halves(xs)
        delta = self._mean(late) - self._mean(early)
        if delta > threshold:
            return worsening_label, delta
        if delta < -threshold:
            return improving_label, delta
        return "consistent", delta

    def _build_summary(self, now: float) -> dict:
        c = self.counter
        depths = list(c.rep_depths)
        tempos = list(c.rep_tempos)
        eccentrics = list(c.rep_eccentric)
        concentrics = list(c.rep_concentric)
        rep_flags = list(c.rep_flags)

        # Depth aggregates.
        depth_mean = self._mean(depths)
        depth_std = self._stddev(depths)
        depth_min = min(depths) if depths else 0.0
        depth_max = max(depths) if depths else 0.0
        reps_at_target = sum(1 for d in depths if d <= TARGET_DEPTH_DEG)
        hit_rate = reps_at_target / len(depths) if depths else 0.0

        depth_trend, depth_delta = self._trend(
            depths, 4.0, "improving", "declining_late"
        )
        # Legacy 4d label uses only "consistent" | "declining_late".
        legacy_depth_trend = (
            "declining_late" if depth_trend == "declining_late" else "consistent"
        )
        d_early, d_late = self._halves(depths)
        first_half_avg = round(self._mean(d_early), 1) if d_early else None
        second_half_avg = round(self._mean(d_late), 1) if d_late else None

        # Tempo aggregates.
        tempo_mean = self._mean(tempos)
        tempo_std = self._stddev(tempos)
        tempo_trend, tempo_delta = self._trend(
            tempos, 0.3, "speeding_up", "slowing_down"
        )
        ecc_concen_ratios = [
            e / cc if cc > 0 else 0.0
            for e, cc in zip(eccentrics, concentrics)
        ]
        ec_ratio_mean = self._mean(ecc_concen_ratios)

        # Per-rep flag indices (1-based for human-friendly summary).
        shallow_idx = [i + 1 for i, fs in enumerate(rep_flags) if "shallow" in fs]
        fast_idx = [i + 1 for i, fs in enumerate(rep_flags) if "too_fast" in fs]

        # Fatigue: any combination of late-set degradation.
        fatigue_signals: list[str] = []
        if depth_trend == "declining_late":
            fatigue_signals.append("depth_decline")
        if tempo_trend == "slowing_down":
            fatigue_signals.append("tempo_decline")
        if not fatigue_signals:
            fatigue_label = "none"
        elif len(fatigue_signals) == 1:
            fatigue_label = fatigue_signals[0]
        else:
            fatigue_label = "both"

        # Tracking source.
        total_src = self._cam_frame_count + self._imu_frame_count
        cam_ratio = self._cam_frame_count / total_src if total_src else 0.0

        # Set duration.
        set_duration = now - self._set_start_t if self._set_start_t else 0.0

        # Notes: human-readable bullets the AI can lean on; also serve as the
        # fallback debrief if Gemini errors.
        notes = self._build_notes(
            depths=depths, depth_mean=depth_mean, hit_rate=hit_rate,
            depth_trend=depth_trend, depth_delta=depth_delta,
            tempo_mean=tempo_mean, tempo_trend=tempo_trend,
            tempo_delta=tempo_delta,
            ec_ratio_mean=ec_ratio_mean,
            shallow_idx=shallow_idx, fast_idx=fast_idx,
            cam_ratio=cam_ratio,
        )
        templated = self._build_templated_debrief(
            reps=len(depths), rep_target=self.rep_target,
            depth_mean=depth_mean, hit_rate=hit_rate,
            depth_trend=depth_trend, fatigue_label=fatigue_label,
            tempo_mean=tempo_mean, tempo_trend=tempo_trend,
        )

        # Top-level keeps the legacy 4d shape — Agent C wired against it.
        return {
            "exercise": "bodyweight_squat",
            "reps_completed": c.rep_count,
            "rep_target": self.rep_target,
            "rep_depths_deg": depths,
            "target_depth_deg": TARGET_DEPTH_DEG,
            "depth_trend": legacy_depth_trend,
            "form_flag_counts": dict(c.flag_counts),
            "fatigue_signal": fatigue_label,
            # Richer breakdown for the AI agent (and the PT view).
            "analysis": {
                "set_duration_sec": round(set_duration, 1),
                "voided_reps": c.voided_reps,
                "depth": {
                    "per_rep_deg": depths,
                    "mean_deg": round(depth_mean, 1),
                    "stddev_deg": round(depth_std, 1),
                    "min_deg": round(depth_min, 1),
                    "max_deg": round(depth_max, 1),
                    "target_deg": TARGET_DEPTH_DEG,
                    "reps_at_or_below_target": reps_at_target,
                    "target_hit_rate": round(hit_rate, 2),
                    "trend": depth_trend,
                    "first_half_avg_deg": first_half_avg,
                    "second_half_avg_deg": second_half_avg,
                    "halves_delta_deg": round(depth_delta, 1),
                },
                "tempo": {
                    "per_rep_sec": tempos,
                    "eccentric_per_rep_sec": eccentrics,
                    "concentric_per_rep_sec": concentrics,
                    "mean_sec": round(tempo_mean, 2),
                    "stddev_sec": round(tempo_std, 2),
                    "trend": tempo_trend,
                    "halves_delta_sec": round(tempo_delta, 2),
                    "eccentric_concentric_ratio_mean": round(ec_ratio_mean, 2),
                },
                "rom": {
                    "min_deg": round(self.rom_min, 1) if self.rom_min < 180 else None,
                    "max_deg": round(self.rom_max, 1) if self.rom_max > 0 else None,
                },
                "form": {
                    "flag_counts": dict(c.flag_counts),
                    "shallow_rep_indices": shallow_idx,
                    "fast_rep_indices": fast_idx,
                    "notes": notes,
                },
                "tracking": {
                    "camera_frame_ratio": round(cam_ratio, 2),
                    "imu_frame_ratio": round(1.0 - cam_ratio, 2),
                    "occlusion_events": self._occlusion_events,
                },
            },
            "templated_debrief": templated,
        }

    def _build_notes(
        self, *, depths, depth_mean, hit_rate, depth_trend, depth_delta,
        tempo_mean, tempo_trend, tempo_delta, ec_ratio_mean,
        shallow_idx, fast_idx, cam_ratio,
    ) -> list[str]:
        notes: list[str] = []
        if not depths:
            notes.append("No completed reps in this set.")
            return notes
        notes.append(
            f"Average knee angle at bottom was {depth_mean:.0f}° "
            f"(target {TARGET_DEPTH_DEG}°)."
        )
        notes.append(
            f"{int(hit_rate * 100)}% of reps reached the target depth "
            f"({sum(1 for d in depths if d <= TARGET_DEPTH_DEG)} of {len(depths)})."
        )
        if depth_trend == "declining_late":
            notes.append(
                f"Depth got shallower by ~{depth_delta:.0f}° between the first "
                "and second half — late-set fatigue pattern."
            )
        elif depth_trend == "improving":
            notes.append(
                f"Depth improved by ~{abs(depth_delta):.0f}° later in the set."
            )
        if shallow_idx:
            notes.append(
                f"{len(shallow_idx)} rep(s) above parallel: rep "
                f"{', '.join(str(i) for i in shallow_idx)}."
            )
        if tempo_mean > 0:
            notes.append(
                f"Average rep tempo was {tempo_mean:.1f}s."
            )
        if tempo_trend == "slowing_down":
            notes.append(
                f"Reps slowed by ~{tempo_delta:.1f}s late in the set "
                "(potential fatigue)."
            )
        if tempo_trend == "speeding_up":
            notes.append(
                f"Reps sped up by ~{abs(tempo_delta):.1f}s late in the set — "
                "watch for loss of control."
            )
        if fast_idx:
            notes.append(
                f"{len(fast_idx)} rep(s) faster than {FAST_REP_SEC}s: "
                f"rep {', '.join(str(i) for i in fast_idx)}."
            )
        if ec_ratio_mean > 0:
            if ec_ratio_mean < 0.7:
                notes.append(
                    f"Eccentric/concentric ratio ~{ec_ratio_mean:.2f} — "
                    "the descent is faster than the ascent (aim for a slower descent)."
                )
            elif ec_ratio_mean > 1.5:
                notes.append(
                    f"Eccentric/concentric ratio ~{ec_ratio_mean:.2f} — "
                    "the descent is much slower than the ascent."
                )
        if cam_ratio < 0.85:
            notes.append(
                f"Camera tracked {int(cam_ratio * 100)}% of frames — the rest "
                "fell back to IMU. Improve framing/lighting for cleaner data."
            )
        return notes

    def _build_templated_debrief(
        self, *, reps, rep_target, depth_mean, hit_rate,
        depth_trend, fatigue_label, tempo_mean, tempo_trend,
    ) -> str:
        """Fallback text the UI shows if the AI debrief is unavailable."""
        if reps == 0:
            return ("No valid reps were tracked in this set. Check framing — "
                    "you should be sideways to the camera with your full body visible.")
        lines: list[str] = []
        lines.append(
            f"Completed {reps} of {rep_target} reps. Average depth {depth_mean:.0f}° "
            f"({int(hit_rate * 100)}% of reps at or below target {TARGET_DEPTH_DEG}°)."
        )
        if depth_trend == "declining_late":
            lines.append(
                "Depth dropped off in the second half — classic late-set fatigue. "
                "Next set, drop the target by 2 reps and focus on hitting depth on every one."
            )
        elif depth_trend == "improving":
            lines.append(
                "Depth got better as you warmed up. Next set, hold today's "
                "ending depth from rep one."
            )
        elif hit_rate < 0.7:
            lines.append(
                "You missed target depth on most reps. Next set, slow the "
                "descent and pause briefly at the bottom of each rep."
            )
        else:
            lines.append(
                "Depth held steady across the set. Next set, keep the same "
                "tempo and add 1-2 reps."
            )
        if tempo_trend == "slowing_down":
            lines.append(f"Reps slowed late in the set (avg {tempo_mean:.1f}s) — fatigue is real.")
        elif tempo_trend == "speeding_up":
            lines.append("Reps sped up — focus on control, not speed.")
        return " ".join(lines)

    # ----- the main loop -----
    def run(self) -> None:
        cap = cv2.VideoCapture(self.camera_index)
        if not cap.isOpened():
            raise RuntimeError(f"Cannot open camera index {self.camera_index}")

        pose = mp_pose.Pose(
            model_complexity=1,
            enable_segmentation=False,
            min_detection_confidence=0.6,
            min_tracking_confidence=0.6,
        )

        try:
            while not self._stop:
                ok, frame = cap.read()
                if not ok:
                    # Camera dropped a frame. If this keeps happening, surface
                    # it to the UI as a setup_status so the user knows.
                    now = time.time()
                    if (
                        self._last_frame_t is not None
                        and now - self._last_frame_t > STALE_FRAME_SEC
                    ):
                        stale = {
                            "ok": False, "severity": "blocking",
                            "code": "camera_stale",
                            "hint": "Camera not delivering frames — check the connection.",
                        }
                        self._emit_state(
                            angle=None, tracking_source="none",
                            leg_vis=0.0, imu_quality=0.0,
                            active_flags=[], setup_status=stale,
                        )
                    time.sleep(0.05)
                    continue
                try:
                    self._process_frame(frame, pose)
                except Exception as e:    # keep the demo alive
                    print(f"[pose_tracker] frame error: {e}")

                # Always push the (possibly skeleton-overlaid) frame downstream.
                try:
                    ok2, buf = cv2.imencode(
                        ".jpg", frame,
                        [int(cv2.IMWRITE_JPEG_QUALITY), self.jpeg_quality],
                    )
                    if ok2:
                        self.on_frame(buf.tobytes())
                except Exception as e:
                    print(f"[pose_tracker] encode error: {e}")

                if self.show_window:
                    cv2.imshow("PhysioFusion (q to quit)", frame)
                    if cv2.waitKey(1) & 0xFF == ord("q"):
                        break
        finally:
            cap.release()
            pose.close()
            if self.show_window:
                cv2.destroyAllWindows()

    def _process_frame(self, frame, pose) -> None:
        now = time.time()
        self._last_frame_t = now
        if self._set_start_t is None:
            self._set_start_t = now

        h, w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        result = pose.process(rgb)

        leg_vis = 0.0
        leg_vis_min = 0.0
        cam_angle: Optional[float] = None
        landmarks = None
        if result.pose_landmarks:
            landmarks = result.pose_landmarks.landmark
            self._last_pose_t = now
            leg_vis, leg_vis_min, hip, knee, ankle = self._extract_leg(landmarks)
            hip_px = (hip[0] * w, hip[1] * h)
            knee_px = (knee[0] * w, knee[1] * h)
            ankle_px = (ankle[0] * w, ankle[1] * h)
            cam_angle = angle_deg(hip_px, knee_px, ankle_px)
            # Always overlay the skeleton — the dashboard renders this JPEG.
            mp_draw.draw_landmarks(
                frame,
                result.pose_landmarks,
                mp_pose.POSE_CONNECTIONS,
                landmark_drawing_spec=_LANDMARK_STYLE,
                connection_drawing_spec=_CONNECTION_STYLE,
            )

        imu_sample = self.imu.get_latest() or {}
        imu_quality = float(imu_sample.get("quality", 0.0))
        imu_angle = imu_tilt_to_knee_angle(float(imu_sample.get("tilt", 0.0))) \
            if imu_sample else None

        camera_trusted = (
            cam_angle is not None
            and leg_vis >= VIS_THRESHOLD
            and leg_vis_min >= LANDMARK_VIS_FLOOR
        )

        # ---- Setup status (camera framing / no-person feedback) ----
        setup_status = self._classify_setup(
            landmarks, leg_vis, leg_vis_min, camera_trusted, now
        )
        self._last_setup = setup_status

        # ---- FUSION: trust camera only when leg landmarks are solidly visible.
        if camera_trusted:
            raw_angle = cam_angle
            tracking_source = "camera"
        elif imu_angle is not None:
            raw_angle = imu_angle
            tracking_source = "imu"
        elif cam_angle is not None:
            raw_angle = cam_angle
            tracking_source = "camera"
        else:
            # Nothing usable — still emit a state so the UI can show the hint.
            self._emit_state(
                angle=None, tracking_source="none",
                leg_vis=leg_vis, imu_quality=imu_quality,
                active_flags=[], setup_status=setup_status,
            )
            return

        # Aggregate source frame counts + count handoff events.
        if tracking_source == "camera":
            self._cam_frame_count += 1
        else:
            self._imu_frame_count += 1
        if self._last_source == "camera" and tracking_source == "imu":
            self._occlusion_events += 1

        # EMA smoothing damps single-frame noise. Reset on source switch so the
        # IMU<->camera handoff doesn't leak a giant step into the state machine.
        if self._last_source != tracking_source or self._smoothed_angle is None:
            self._smoothed_angle = raw_angle
            self.counter.pause_streaks()
        else:
            self._smoothed_angle = (
                ANGLE_EMA_ALPHA * raw_angle
                + (1.0 - ANGLE_EMA_ALPHA) * self._smoothed_angle
            )
        self._last_source = tracking_source
        angle = self._smoothed_angle

        # ---- ROM + reps ----
        self.rom_min = min(self.rom_min, angle)
        self.rom_max = max(self.rom_max, angle)
        new_flags: list[str] = []
        # Camera drives the rep state machine. IMU keeps the depth gauge alive
        # during occlusion but won't increment reps on its own.
        if self.phase == "SET_ACTIVE" and tracking_source == "camera":
            new_flags = self.counter.update(angle, now, source="camera")
        elif self.phase == "SET_ACTIVE":
            self.counter.pause_streaks()
        active_flags = self._update_active_flags(new_flags, now)

        # ---- Stuck-in-down recovery (user sat down / walked off mid-rep). ----
        if (
            self.phase == "SET_ACTIVE"
            and self.counter.current_phase() == "down"
            and now - self.counter.current_rep_start() > STUCK_DOWN_SEC
        ):
            self.counter.force_reset_to_up()

        # ---- Set-end detection ----
        if self.phase == "SET_ACTIVE" and self._check_set_end(angle, now):
            self.phase = "SET_END"

        self._emit_state(
            angle=angle, tracking_source=tracking_source,
            leg_vis=leg_vis, imu_quality=imu_quality,
            active_flags=active_flags, setup_status=setup_status,
        )

        # ---- Set-end summary fires once. ----
        if self.phase == "SET_END" and not self._set_emitted:
            self._set_emitted = True
            summary = self._build_summary(now)
            try:
                self.on_set_end(summary)
            except Exception as e:
                print(f"[pose_tracker] on_set_end error: {e}")
            self.phase = "DEBRIEF"

    def _emit_state(
        self, *, angle: Optional[float], tracking_source: str,
        leg_vis: float, imu_quality: float,
        active_flags: list[str], setup_status: dict,
    ) -> None:
        # depth_state derived from current rep min if descending, else live angle.
        if angle is None:
            depth_state = "shallow"
            display_angle: float = 0.0
        else:
            display_angle = angle
            if self.counter.current_phase() == "down":
                ref = self.counter._s.min_angle_this_rep
            else:
                ref = angle
            depth_state = self._depth_state(ref)
        state = {
            "phase": self.phase,
            "angle": round(display_angle, 1),
            "rep_count": self.counter.rep_count,
            "rep_target": self.rep_target,
            "rom_min": round(self.rom_min, 1) if self.rom_min < 180 else 180.0,
            "rom_max": round(self.rom_max, 1),
            "depth_state": depth_state,
            "form_flags": active_flags,
            "tempo": self.counter.last_tempo(),
            "imu_quality": round(imu_quality, 2),
            "landmark_visibility": round(leg_vis, 2),
            "tracking_source": tracking_source,
            "rep_depths": list(self.counter.rep_depths),
            "setup_status": setup_status,
        }
        try:
            self.on_state(state)
        except Exception as e:
            print(f"[pose_tracker] on_state error: {e}")


# ---------------------------------------------------------------------------
# Integration shims for main.py (Agent C / UI workstream wires these up).
#
# main.py imports:
#     from pose_tracker import SquatTracker, run_camera, MockIMU
# and calls:
#     tracker = SquatTracker(rep_target=10, imu_source=..., on_state=..., on_set_end=...)
#     run_camera(tracker, camera_index=0, side="left")
#
# `SquatTracker` is just an alias so the import names stay readable; `run_camera`
# moves the camera_index + side hint from the constructor to call time.
# ---------------------------------------------------------------------------
SquatTracker = PoseTracker


def run_camera(
    tracker: PoseTracker,
    camera_index: int = 0,
    side: Optional[str] = None,
    show_window: bool = False,
) -> None:
    """Run the tracker against a webcam (blocking).

    `side` is the body side facing the camera ("left" | "right") — forces the
    leg picker rather than auto-detecting per frame. `show_window` defaults to
    False because the dashboard renders frames; flip to True for a local debug
    window.
    """
    tracker.camera_index = camera_index
    if side in ("left", "right"):
        tracker.preferred_side = side
    tracker.show_window = show_window
    tracker.run()


# ---------------------------------------------------------------------------
# Standalone smoke test. Webcam + MockIMU + print callbacks.
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import json

    last_print = [0.0]

    def state_cb(s: dict) -> None:
        # Throttle to ~4 Hz so the terminal stays readable.
        now = time.time()
        if now - last_print[0] < 0.25:
            return
        last_print[0] = now
        print(
            f"phase={s['phase']:<10} "
            f"src={s['tracking_source']:<6} "
            f"angle={s['angle']:>5.1f} "
            f"reps={s['rep_count']}/{s['rep_target']} "
            f"vis={s['landmark_visibility']:.2f} "
            f"flags={s['form_flags']}"
        )

    def set_end_cb(summary: dict) -> None:
        print("\n=== SET END ===")
        print(json.dumps(summary, indent=2))
        print("================\n")

    tracker = PoseTracker(
        on_state=state_cb,
        on_set_end=set_end_cb,
        rep_target=5,
        show_window=True,
    )
    tracker.run()
