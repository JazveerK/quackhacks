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

from profile import PTProfile, DEFAULT_PROFILE
from exercise_spec import ExerciseSpec, SQUAT_SPEC, DEFAULT_EXERCISE, get as get_exercise

# ---------------------------------------------------------------------------
# Tunables. The squat-specific ones below now live in exercises.SQUAT and are
# kept here only as module-level fallbacks / for the headless smoke test
# (smoke_reps.py imports DOWN_ENTER_DEG / UP_ENTER_DEG). Per-exercise thresholds
# are read from the active ExerciseSpec at runtime — see RepCounter.
# Side view assumed.
#
# A few of these are *defaults*: TARGET_DEPTH_DEG, PARALLEL_DEG, FAST_REP_SEC,
# REP_TARGET_DEFAULT are overridden at runtime by the active PT profile (see
# PoseTracker.set_profile). The constants below are the fallback values used
# when no profile is loaded.
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
COUNT_DEPTH_MARGIN_DEG = 10     # a rep only counts if it bends to within this many
                                # degrees of "parallel" (target+buffer). Raises the
                                # depth bar so tiny bobs near DOWN_ENTER_DEG don't count.
STILL_ANGLE_BAND = 8            # +/- deg considered "still" at top
STILL_SECONDS = 20.0            # standing-still this long => auto-end (idle fallback).
                                # Primary set-end is a thumbs-up / voice / button;
                                # this only catches "patient walked away" cases.
FLAG_TTL_SEC = 2.5              # how long a form flag stays visible per-frame
VIS_THRESHOLD = 0.6             # avg leg-landmark visibility for camera-trusted
LANDMARK_VIS_FLOOR = 0.4        # every leg landmark must clear this
TORSO_VIS_THRESHOLD = 0.5       # shoulder visibility for "in frame" check
SIDE_VIEW_SPREAD_MAX = 0.30     # shoulder/hip horiz spread / torso height (side-on)
NO_POSE_SETUP_SEC = 2.0         # seconds without any pose -> "step into frame"
STALE_FRAME_SEC = 2.0           # seconds without a fresh camera frame -> error
DEBOUNCE_FRAMES = 3             # consecutive frames past threshold to flip phase
ANGLE_EMA_ALPHA = 0.30          # EMA smoothing for angle (0..1, higher = snappier)

# Set-lifecycle + gesture control.
#
# The set no longer auto-starts: the patient gets into position (guided by
# setup_status), then a thumbs-up (or voice / button) starts a 3-2-1 countdown
# into SET_ACTIVE. A thumbs-up held during the set ends it; during DEBRIEF it
# advances to the next set. Gestures are confirmed over consecutive frames with
# a cooldown so a stray frame can't fire them.
COUNTDOWN_SEC = 3.0             # 3-2-1 countdown after the start trigger
GESTURE_CONFIRM_FRAMES = 6      # consecutive thumbs-up frames to START / advance
END_GESTURE_CONFIRM_FRAMES = 14 # stricter hold to END a live set (avoid accidents)
GESTURE_COOLDOWN_SEC = 2.0      # ignore repeat gestures within this window

# MediaPipe drawing styles. Cyan dots, lighter blue connections for visibility.
import mediapipe.python.solutions.drawing_utils as _du
_LANDMARK_STYLE = _du.DrawingSpec(color=(180, 255, 0), thickness=3, circle_radius=4)
_CONNECTION_STYLE = _du.DrawingSpec(color=(255, 200, 80), thickness=2)

# MediaPipe landmark indices (Pose).
mp_pose = mp.solutions.pose
mp_draw = mp.solutions.drawing_utils
LM = mp_pose.PoseLandmark

# MediaPipe Hands — used only for the thumbs-up start/end/advance gesture.
mp_hands = mp.solutions.hands
HLM = mp_hands.HandLandmark

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


def detect_thumbs_up(landmarks) -> bool:
    """Heuristic thumbs-up from a single hand's 21 normalized landmarks.

    `landmarks` is a sequence indexable by HandLandmark value, each with
    `.x`/`.y` in [0,1] (image coords; y grows downward). Orientation-agnostic
    for left/right hands and mirror flips:

    - Thumb is extended roughly vertically (tip clearly above the MCP), and
    - the other four fingers are curled (each tip below — larger y than — its
      PIP joint), for at least 3 of 4 fingers.

    Returns False on any malformed input.
    """
    try:
        def y(i): return landmarks[i].y
        def x(i): return landmarks[i].x

        thumb_tip, thumb_ip, thumb_mcp = HLM.THUMB_TIP, HLM.THUMB_IP, HLM.THUMB_MCP
        wrist = HLM.WRIST

        # Thumb pointing up: tip above the IP above the MCP, and tip well above
        # the wrist (at least ~15% of frame height).
        thumb_up = (
            y(thumb_tip) < y(thumb_ip) < y(thumb_mcp)
            and (y(wrist) - y(thumb_tip)) > 0.15
        )
        if not thumb_up:
            return False

        # Other fingers curled: fingertip lower (larger y) than its PIP joint.
        finger_tips = (HLM.INDEX_FINGER_TIP, HLM.MIDDLE_FINGER_TIP,
                       HLM.RING_FINGER_TIP, HLM.PINKY_TIP)
        finger_pips = (HLM.INDEX_FINGER_PIP, HLM.MIDDLE_FINGER_PIP,
                       HLM.RING_FINGER_PIP, HLM.PINKY_PIP)
        curled = sum(
            1 for tip, pip in zip(finger_tips, finger_pips) if y(tip) > y(pip)
        )
        # The thumb should also stick out from the curled fist horizontally a
        # touch — guards against an open flat hand read as "all tips high".
        return curled >= 3
    except Exception:
        return False


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


def _spec_tempo_default(spec: ExerciseSpec) -> float:
    """The too-fast threshold for a spec: the first tempo rule's min_sec, or the
    module default when a rule doesn't pin one (e.g. the squat, which gets it
    from the PT profile at runtime instead)."""
    for r in spec.form_rules:
        if r.type == "tempo" and r.min_sec is not None:
            return float(r.min_sec)
    return FAST_REP_SEC


class RepCounter:
    """Counts reps, tracks per-rep ROM, emits per-rep form flags.

    Generic over an `ExerciseSpec`. The rep state machine, ROM gate, and form
    rules all read from the spec, and every comparison is direction-aware via a
    sign (`sgn`): for a "min" exercise (squat / curl) a good rep drives the angle
    DOWN; for a "max" exercise (arm raise / leg extension) it drives the angle
    UP. `progress = sgn * angle` always increases as the rep advances, so one
    machine grades both. Run with `SQUAT_SPEC`, the behaviour is identical to the
    original hard-coded squat counter.

    Per-rep records (parallel arrays indexed by rep number):
        rep_depths        — the rep's extreme driving angle, deg
        rep_tempos        — total seconds (eccentric + concentric)
        rep_eccentric     — active-phase seconds (rep_start -> extreme)
        rep_concentric    — return seconds (extreme -> rep_end)
        rep_flags         — list of form flags raised on that rep
        rep_cam_frac      — fraction of rep frames that were camera-tracked
        rep_end_t         — clock time the rep completed
    """

    def __init__(
        self,
        spec: ExerciseSpec = SQUAT_SPEC,
        target_depth_deg: Optional[float] = None,
        fast_rep_sec: Optional[float] = None,
        parallel_buffer_deg: Optional[float] = None,
    ):
        self.spec = spec
        rd = spec.rep_definition
        # +1 when a good rep means a LARGER angle (raise), -1 when SMALLER (squat).
        self.sgn = 1.0 if spec.rom_metric == "max" else -1.0
        self.start_angle = rd.start_angle_deg
        self.trigger_angle = rd.trigger_angle_deg
        self.return_angle = rd.return_angle_deg

        # target overrides the spec default when provided (squat uses the PT
        # profile's depth); tempo likewise.
        self.target_depth_deg = float(
            target_depth_deg if target_depth_deg is not None else rd.target_angle_deg
        )
        self.fast_rep_sec = float(
            fast_rep_sec if fast_rep_sec is not None else _spec_tempo_default(spec)
        )
        buffer = (parallel_buffer_deg if parallel_buffer_deg is not None
                  else spec.parallel_buffer_deg)
        # "parallel" = edge of the good-rep band; "count" = how far past it a rep
        # must go to count at all. Both move in the active direction via sgn.
        self.parallel_deg = self.target_depth_deg - self.sgn * float(buffer)
        self.count_depth_deg = self.parallel_deg - self.sgn * spec.count_margin_deg
        # The value a rep's running extreme starts at (worst possible progress).
        self._extreme_init = 180.0 if self.sgn < 0 else 0.0

        self._s = _RepState()
        self._s.min_angle_this_rep = self._extreme_init
        self.rep_count = 0
        self.rep_depths: list[float] = []
        self.rep_tempos: list[float] = []
        self.rep_eccentric: list[float] = []
        self.rep_concentric: list[float] = []
        self.rep_flags: list[list[str]] = []
        self.rep_cam_frac: list[float] = []
        self.rep_end_t: list[float] = []
        self.flag_counts: dict[str, int] = {r.name: 0 for r in spec.form_rules}
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
        self._s.min_angle_this_rep = self._extreme_init
        self._down_streak = 0
        self._up_streak = 0

    def update(self, angle: float, now: float, source: str = "camera") -> list[str]:
        """Feed one frame's smoothed angle. Returns flags newly raised this frame.

        `source` is the tracking source ("camera" or "imu") for THIS frame.
        Per-rep camera fraction drives a rep-validity check at completion. All
        comparisons go through `sgn` so the machine is direction-agnostic.
        """
        flags: list[str] = []
        s = self._s
        sgn = self.sgn

        # Track the most-recent resting frame so we can attribute the full active
        # phase (not just the part past the trigger) as eccentric time. "At rest"
        # = progress at or below the start position.
        if sgn * angle <= sgn * self.start_angle:
            self._t_last_standing = now

        if s.phase == "up":
            # Enter the active phase once we pass the trigger toward the peak.
            if sgn * angle > sgn * self.trigger_angle:
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
        else:  # "down" / active phase
            # Track per-frame source attribution for this rep.
            if source == "camera":
                s.cam_frames += 1
            else:
                s.imu_frames += 1

            # Update the running extreme (most-progressed angle this rep).
            if sgn * angle > sgn * s.min_angle_this_rep:
                s.min_angle_this_rep = angle
                s.t_at_min = now
            # Complete the rep once we cross back past the return threshold.
            if sgn * angle < sgn * self.return_angle:
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

                # Validity gates. A rep must be a plausible tempo, mostly
                # camera-tracked, AND actually progress past the count gate (not a
                # twitch just past the trigger).
                valid = (
                    MIN_REP_SEC <= tempo <= MAX_REP_SEC
                    and cam_frac >= MIN_CAM_FRAC
                    and sgn * depth >= sgn * self.count_depth_deg
                )
                if valid:
                    self.rep_count += 1
                    self.rep_depths.append(round(depth, 1))
                    self.rep_tempos.append(round(tempo, 2))
                    self.rep_eccentric.append(round(eccentric, 2))
                    self.rep_concentric.append(round(concentric, 2))
                    self.rep_cam_frac.append(round(cam_frac, 2))
                    self.rep_end_t.append(now)
                    rep_flags = self._eval_form(depth, tempo)
                    for f in rep_flags:
                        self.flag_counts[f] = self.flag_counts.get(f, 0) + 1
                    self.rep_flags.append(rep_flags)
                    flags = list(rep_flags)
                else:
                    self.voided_reps += 1
                # Reset rep state regardless.
                s.phase = "up"
                s.min_angle_this_rep = self._extreme_init
                s.cam_frames = 0
                s.imu_frames = 0
                self._down_streak = 0
                self._up_streak = 0
        return flags

    def _eval_form(self, depth: float, tempo: float) -> list[str]:
        """Per-rep form flags from the spec's form_rules (direction-aware)."""
        sgn = self.sgn
        out: list[str] = []
        for rule in self.spec.form_rules:
            if rule.type == "tempo":
                thr = rule.min_sec if rule.min_sec is not None else self.fast_rep_sec
                if tempo < thr:
                    out.append(rule.name)
            elif rule.type == "shallow":
                if sgn * depth < sgn * self.parallel_deg:
                    out.append(rule.name)
            elif rule.type == "target_not_reached":
                if sgn * depth < sgn * self.target_depth_deg:
                    out.append(rule.name)
            elif rule.type == "rom":
                if rule.threshold_deg is not None and sgn * depth < sgn * rule.threshold_deg:
                    out.append(rule.name)
        return out

    def current_phase(self) -> str:
        return self._s.phase

    def current_rep_start(self) -> float:
        return self._s.rep_start_t

    def last_tempo(self) -> float:
        return self.rep_tempos[-1] if self.rep_tempos else 0.0


class SquatCounter(RepCounter):
    """Back-compat squat counter (smoke_reps.py and older callers use this).

    Equivalent to ``RepCounter(SQUAT, ...)`` — defaults preserve the original
    squat behaviour byte-for-byte.
    """

    def __init__(
        self,
        target_depth_deg: float = TARGET_DEPTH_DEG,
        fast_rep_sec: float = FAST_REP_SEC,
        parallel_buffer_deg: float = 5.0,
    ):
        super().__init__(
            SQUAT_SPEC,
            target_depth_deg=target_depth_deg,
            fast_rep_sec=fast_rep_sec,
            parallel_buffer_deg=parallel_buffer_deg,
        )


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
        rep_target: Optional[int] = None,
        camera_index: int = 0,
        show_window: bool = True,
        jpeg_quality: int = 70,
        preferred_side: Optional[str] = None,
        profile: Optional[PTProfile] = None,
        on_ai_debrief: Optional[Callable[[str], None]] = None,
        on_profile_change: Optional[Callable[[PTProfile], None]] = None,
        require_start_gesture: bool = True,
        enable_gesture: bool = False,
        exercise: Optional[str] = None,
    ):
        self.imu = imu_source or MockIMU()
        self.on_state = on_state or (lambda s: None)
        self.on_set_end = on_set_end or (lambda summary: None)
        self.on_frame = on_frame or (lambda jpeg: None)
        self.on_ai_debrief = on_ai_debrief or (lambda text: None)
        self.on_profile_change = on_profile_change or (lambda p: None)
        self.camera_index = camera_index
        self.show_window = show_window
        self.jpeg_quality = jpeg_quality
        # Optional hint: which side faces the camera ("left" | "right" | None).
        # None means auto-pick the more-visible leg per frame.
        self.preferred_side = preferred_side
        self._stop = False

        # Profile-driven runtime targets. If no profile passed, use the demo
        # persona (Sam) so the dashboard has a story before any PT upload.
        # An explicit rep_target arg (if given) wins over the profile's value
        # so existing callers / tests stay unaffected.
        self.profile: PTProfile = profile or DEFAULT_PROFILE
        # Active exercise (drives which joint angle is graded + the thresholds).
        # Independent of the profile for now; selected via select_exercise().
        self.exercise_spec: ExerciseSpec = get_exercise(exercise) if exercise else DEFAULT_EXERCISE
        self._joint_idx = self._resolve_joint(self.exercise_spec)
        # Pending exercise switch — applied on the next reset_set() so the rules
        # don't change mid-set (mirrors _pending_profile).
        self._pending_exercise: Optional[ExerciseSpec] = None
        self._sgn: float = -1.0
        self.target_depth_deg: float = self.profile.depth_deg
        self.fast_rep_sec: float = self.profile.tempo_sec
        self.parallel_deg: float = self.target_depth_deg + 5.0
        # Override target / tempo / parallel / sign from the active exercise spec.
        self._apply_exercise_targets()
        self.rep_target: int = (
            int(rep_target) if rep_target is not None else self.profile.reps_per_set
        )
        # Pending profile takes effect on the next reset_set() — keeps thresholds
        # stable inside the in-flight set so reps that already started don't
        # change rules mid-stream.
        self._pending_profile: Optional[PTProfile] = None

        # Set lifecycle. With require_start_gesture, the set waits for an explicit
        # start (voice / button — and a thumbs-up too if enable_gesture) before
        # counting; otherwise it behaves like the original always-on tracker.
        #   WAITING_FOR_START -> COUNTDOWN -> SET_ACTIVE -> SET_END -> DEBRIEF
        # enable_gesture toggles the thumbs-up hand gesture. Default off: the
        # app drives start/end/advance via the voice agent + on-screen buttons.
        self.require_start_gesture = require_start_gesture
        self.enable_gesture = enable_gesture
        self.phase = "WAITING_FOR_START" if require_start_gesture else "SET_ACTIVE"
        self.counter = self._fresh_counter()
        self.rom_min = 180.0
        self.rom_max = 0.0
        self._active_flags: dict[str, float] = {}   # flag -> expiry epoch
        self._still_since: Optional[float] = None
        self._set_end_requested = False
        self._set_emitted = False
        self._smoothed_angle: Optional[float] = None
        self._last_source: Optional[str] = None

        # Gesture + countdown state.
        self._start_requested = False          # external start (voice / button)
        self._next_requested = False           # external advance during DEBRIEF
        self._thumb_frames = 0                 # consecutive thumbs-up frames
        self._thumbs_up_now = False            # this frame's raw detection
        self._last_gesture_t = 0.0             # cooldown anchor
        self._countdown_start: Optional[float] = None

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

    # ----- external control (manual buttons / voice from UI) -----
    def request_set_end(self) -> None:
        self._set_end_requested = True

    def start_set(self) -> None:
        """External trigger to start the set (voice 'start set' / Start button).

        Honored from WAITING_FOR_START (begins the countdown) and from DEBRIEF
        (advances to the next set, then waits for its start). Ignored mid-set.
        """
        if self.phase == "WAITING_FOR_START":
            self._start_requested = True
        elif self.phase in ("DEBRIEF", "SET_END"):
            self._next_requested = True

    def next_set(self) -> None:
        """External trigger to advance to the next set after a debrief."""
        self._next_requested = True

    def stop(self) -> None:
        self._stop = True

    def set_profile(self, profile: PTProfile) -> None:
        """Queue a new PT profile. Takes effect on the next `reset_set()`."""
        self._pending_profile = profile.clamp()

    def select_exercise(self, exercise_id: str) -> None:
        """Switch the active exercise (e.g. 'pushup').

        Applied immediately when no set is in flight (WAITING_FOR_START / DEBRIEF
        / SET_END) so the dashboard updates right away; otherwise queued for the
        next reset_set() so a live set's rules don't change underneath the user.
        """
        spec = get_exercise(exercise_id)
        if spec.id == self.exercise_spec.id and self._pending_exercise is None:
            return
        if self.phase in ("SET_ACTIVE", "COUNTDOWN"):
            self._pending_exercise = spec
        else:
            self._apply_exercise(spec)

    def load_exercise_spec(self, spec: ExerciseSpec) -> None:
        """Install a spec OBJECT directly (e.g. one an LLM just generated from PT
        documentation), rather than looking it up by id in the registry. Queued
        if a set is live, applied immediately otherwise."""
        if self.phase in ("SET_ACTIVE", "COUNTDOWN"):
            self._pending_exercise = spec
        else:
            self._apply_exercise(spec)

    def _apply_exercise(self, spec: ExerciseSpec) -> None:
        """Make `spec` the active exercise and rebuild the rep counter. Only safe
        when no reps are mid-flight (start of a set)."""
        self.exercise_spec = spec
        self._joint_idx = self._resolve_joint(spec)
        self._pending_exercise = None
        self._apply_exercise_targets()
        self.counter = self._fresh_counter()
        self.rom_min = 180.0
        self.rom_max = 0.0
        self._active_flags.clear()
        self._smoothed_angle = None
        self._last_source = None

    def _apply_exercise_targets(self) -> None:
        """Set the runtime target / tempo / parallel / sign from the active spec.

        The squat keeps reading its depth + tempo from the PT profile (so an
        uploaded prescription still drives it); other exercises use the spec's
        own rep_definition. `parallel_deg` and `_sgn` mirror the rep counter so
        the live depth_state badge matches how reps are graded.
        """
        spec = self.exercise_spec
        self._sgn = 1.0 if spec.rom_metric == "max" else -1.0
        if spec.id == SQUAT_SPEC.id:
            self.target_depth_deg = self.profile.depth_deg
            self.fast_rep_sec = self.profile.tempo_sec
        else:
            self.target_depth_deg = spec.rep_definition.target_angle_deg
            self.fast_rep_sec = _spec_tempo_default(spec)
        self.parallel_deg = self.target_depth_deg - self._sgn * spec.parallel_buffer_deg

    @staticmethod
    def _resolve_joint(spec: ExerciseSpec) -> list:
        """Resolve the spec's primary joint to a list of candidate landmark-index
        triples. For side='both' there are two (left + right) and the tracker
        picks the more visible one per frame; for 'left'/'right' there is one."""
        def idx(name: str) -> int:
            return getattr(LM, name).value
        bases = spec.primary_joint.bases()          # [a, vertex, c]
        side = spec.primary_joint.side
        sides = ["LEFT", "RIGHT"] if side == "both" else [side.upper()]
        candidates: list = []
        for sd in sides:
            try:
                candidates.append(tuple(idx(f"{sd}_{b}") for b in bases))
            except AttributeError:
                continue
        if not candidates:   # last-resort fallback so the tracker never crashes
            candidates = [
                (LEFT_HIP, LEFT_KNEE, LEFT_ANKLE),
                (RIGHT_HIP, RIGHT_KNEE, RIGHT_ANKLE),
            ]
        return candidates

    def _fresh_counter(self) -> "RepCounter":
        return RepCounter(
            self.exercise_spec,
            target_depth_deg=self.target_depth_deg,
            fast_rep_sec=self.fast_rep_sec,
            parallel_buffer_deg=self.exercise_spec.parallel_buffer_deg,
        )

    def reset_set(self, rep_target: Optional[int] = None) -> None:
        # Apply any pending exercise switch so the new set grades the right move.
        if self._pending_exercise is not None:
            self.exercise_spec = self._pending_exercise
            self._joint_idx = self._resolve_joint(self.exercise_spec)
            self._pending_exercise = None
        # Apply any pending profile first so the new set runs on new targets.
        if self._pending_profile is not None:
            self.profile = self._pending_profile
            self.target_depth_deg = self.profile.depth_deg
            self.fast_rep_sec = self.profile.tempo_sec
            self.parallel_deg = self.target_depth_deg + 5.0
            # Profile's reps_per_set wins unless the caller explicitly passed one.
            if rep_target is None:
                self.rep_target = int(self.profile.reps_per_set)
            self._pending_profile = None
        # Re-derive target / tempo / parallel / sign for the (possibly new)
        # exercise + profile combination before building the fresh counter.
        self._apply_exercise_targets()
        if rep_target is not None:
            self.rep_target = int(rep_target)
        # New sets wait for a start gesture (unless the tracker is in always-on
        # mode for legacy callers / tests).
        self.phase = "WAITING_FOR_START" if self.require_start_gesture else "SET_ACTIVE"
        self.counter = self._fresh_counter()
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
        # Gesture / countdown reset.
        self._start_requested = False
        self._next_requested = False
        self._thumb_frames = 0
        self._countdown_start = None

    # ----- per-frame pipeline -----
    def _extract_limb(self, landmarks) -> tuple[float, float, tuple, tuple, tuple]:
        """Pick the most-visible candidate of the active exercise's driving joint.

        Returns (avg_visibility, min_visibility, a, b, c) where a-b-c is the
        joint triple (vertex = b). `self._joint_idx` is a list of candidate
        index-triples (two for a 'both' spec, one for left/right). We pick the
        most-visible candidate per frame; min_visibility still lets us reject
        predicted/occluded landmarks even when the average looks acceptable.
        """
        def read(tri):
            pts, viss = [], []
            for i in tri:
                lm = landmarks[i]
                pts.append((lm.x, lm.y))
                viss.append(lm.visibility)
            return (sum(viss) / 3.0, min(viss), pts[0], pts[1], pts[2])

        candidates = self._joint_idx
        # Honor an explicit camera-facing side hint when there are two sides.
        if self.preferred_side == "left" and len(candidates) >= 1:
            return read(candidates[0])
        if self.preferred_side == "right" and len(candidates) >= 1:
            return read(candidates[-1])

        best = None
        for tri in candidates:
            cand = read(tri)
            if best is None or cand[0] > best[0]:
                best = cand
        return best

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

    def _depth_state(self, angle: float) -> str:
        # Direction-aware via sgn: "below_parallel" = reached target (good),
        # "at_parallel" = within the buffer band, "shallow" = not there yet.
        s = self._sgn
        if s * angle >= s * self.target_depth_deg:
            return "below_parallel"
        if s * angle >= s * self.parallel_deg:
            return "at_parallel"
        return "shallow"

    def _check_set_end(self, angle: float, now: float) -> bool:
        if self._set_end_requested:
            return True
        if self.counter.rep_count >= self.rep_target:
            return True
        # Stillness: resting at the start position, not moving for STILL_SECONDS.
        rest = self.exercise_spec.rep_definition.start_angle_deg
        if self._sgn * angle <= self._sgn * rest and self.counter.current_phase() == "up":
            if self._still_since is None:
                self._still_since = now
            elif now - self._still_since >= STILL_SECONDS and self.counter.rep_count > 0:
                return True
        else:
            self._still_since = None
        return False

    def _gesture_confirmed(self, frames_needed: int, now: float) -> bool:
        """True once the thumbs-up has been held `frames_needed` frames and the
        cooldown since the last fired gesture has elapsed. Fires once, then
        resets the held-frame counter so a fresh hold is required next time."""
        if (self._thumb_frames >= frames_needed
                and now - self._last_gesture_t >= GESTURE_COOLDOWN_SEC):
            self._last_gesture_t = now
            self._thumb_frames = 0
            return True
        return False

    # ----- set scoring -----
    def _compute_score(
        self, *, depths: list[float], hit_rate: float, depth_mean: float,
        depth_std: float, reps_completed: int, fast_count: int,
    ) -> dict:
        """A 0-100 set score with a letter grade and per-component breakdown.

        Components (each 0-100):
          depth        — hit-rate at/below target, plus partial credit for how
                          close the average bottom was to the prescribed depth.
          consistency  — tight rep-to-rep depth (low stddev) scores high.
          tempo        — fraction of reps that were NOT too fast (controlled).
          completion   — reps completed vs the prescribed rep target.
        """
        if not depths:
            return {
                "overall": 0, "grade": "—",
                "components": {"depth": 0, "consistency": 0,
                               "tempo": 0, "completion": 0},
                "headline": "No valid reps tracked.",
            }
        n = len(depths)
        # Depth: 60% hit-rate, 40% closeness of the average to target (full
        # credit at/below target, fading to 0 by ~25° shallow).
        over = max(0.0, depth_mean - self.target_depth_deg)
        closeness = max(0.0, 1.0 - over / 25.0)
        depth01 = 0.6 * hit_rate + 0.4 * closeness
        # Consistency: 0° stddev -> 1.0, >=15° -> 0.0.
        consistency01 = max(0.0, 1.0 - depth_std / 15.0)
        # Tempo control: penalize too-fast reps.
        tempo01 = max(0.0, 1.0 - fast_count / n)
        # Completion vs prescription.
        completion01 = (
            min(1.0, reps_completed / self.rep_target) if self.rep_target else 1.0
        )
        overall = round(
            100 * (0.40 * depth01 + 0.20 * consistency01
                   + 0.20 * tempo01 + 0.20 * completion01)
        )
        overall = max(0, min(100, overall))
        grade = (
            "A" if overall >= 90 else "B" if overall >= 80
            else "C" if overall >= 70 else "D" if overall >= 60 else "F"
        )
        if overall >= 90:
            headline = "Excellent set — depth, control, and consistency all on point."
        elif overall >= 80:
            headline = "Strong set with solid depth and control."
        elif overall >= 70:
            headline = "Good work — a few reps to clean up."
        elif overall >= 60:
            headline = "Fair set — depth or control slipped on several reps."
        else:
            headline = "Tough set — focus on hitting depth with control next time."
        return {
            "overall": overall,
            "grade": grade,
            "components": {
                "depth": round(depth01 * 100),
                "consistency": round(consistency01 * 100),
                "tempo": round(tempo01 * 100),
                "completion": round(completion01 * 100),
            },
            "headline": headline,
        }

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
        reps_at_target = sum(1 for d in depths if d <= self.target_depth_deg)
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

        # Set score (0-100 + grade + component breakdown).
        score = self._compute_score(
            depths=depths, hit_rate=hit_rate, depth_mean=depth_mean,
            depth_std=depth_std, reps_completed=c.rep_count,
            fast_count=c.flag_counts.get("too_fast", 0),
        )

        # Top-level keeps the legacy 4d shape — Agent C wired against it.
        return {
            "exercise": self.exercise_spec.id,
            "exercise_ui": self.exercise_spec.to_ui(),
            "reps_completed": c.rep_count,
            "rep_target": self.rep_target,
            "rep_depths_deg": depths,
            "target_depth_deg": self.target_depth_deg,
            "depth_trend": legacy_depth_trend,
            "form_flag_counts": dict(c.flag_counts),
            "fatigue_signal": fatigue_label,
            "set_score": score["overall"],
            "score": score,
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
                    "target_deg": self.target_depth_deg,
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
            # Active PT profile + AI debrief slot. `ai_debrief` is filled
            # asynchronously after the summary is emitted; null on first
            # emission and stays null if Gemini errors / no key.
            "profile": self.profile.to_dict(),
            "ai_debrief": None,
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
            f"Average {self.exercise_spec.angle_noun} at bottom was {depth_mean:.0f}° "
            f"(target {self.target_depth_deg:.0f}°)."
        )
        notes.append(
            f"{int(hit_rate * 100)}% of reps reached the target depth "
            f"({sum(1 for d in depths if d <= self.target_depth_deg)} of {len(depths)})."
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
                f"{len(fast_idx)} rep(s) faster than {self.fast_rep_sec:.1f}s: "
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
            f"({int(hit_rate * 100)}% of reps at or below target {self.target_depth_deg:.0f}°)."
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
        # Lightweight Hands model for the thumbs-up start/end/advance gesture.
        # Only created when gestures are enabled — the default voice-driven app
        # leaves it off (saves CPU; start/end come from the voice agent).
        hands = None
        if self.enable_gesture:
            hands = mp_hands.Hands(
                model_complexity=0,
                max_num_hands=1,
                min_detection_confidence=0.6,
                min_tracking_confidence=0.5,
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
                    self._process_frame(frame, pose, hands)
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
            if hands is not None:
                hands.close()
            if self.show_window:
                cv2.destroyAllWindows()

    def _process_frame(self, frame, pose, hands=None) -> None:
        now = time.time()
        self._last_frame_t = now

        h, w = frame.shape[:2]
        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        result = pose.process(rgb)

        # ---- Thumbs-up gesture (debounced) ----
        self._thumbs_up_now = False
        if hands is not None:
            try:
                hres = hands.process(rgb)
                if hres.multi_hand_landmarks:
                    self._thumbs_up_now = any(
                        detect_thumbs_up(hl.landmark)
                        for hl in hres.multi_hand_landmarks
                    )
            except Exception as e:
                print(f"[pose_tracker] hands error: {e}")
        self._thumb_frames = self._thumb_frames + 1 if self._thumbs_up_now else 0

        leg_vis = 0.0
        leg_vis_min = 0.0
        cam_angle: Optional[float] = None
        landmarks = None
        if result.pose_landmarks:
            landmarks = result.pose_landmarks.landmark
            self._last_pose_t = now
            leg_vis, leg_vis_min, ja, jb, jc = self._extract_limb(landmarks)
            a_px = (ja[0] * w, ja[1] * h)
            b_px = (jb[0] * w, jb[1] * h)
            c_px = (jc[0] * w, jc[1] * h)
            cam_angle = angle_deg(a_px, b_px, c_px)
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
        # IMU fusion only applies to exercises whose spec opts in (the squat's
        # thigh tilt). For others the IMU mapping isn't meaningful, so we stay on
        # camera and fall back to "none" on occlusion.
        imu_angle = (
            imu_tilt_to_knee_angle(float(imu_sample.get("tilt", 0.0)))
            if imu_sample and self.exercise_spec.use_imu_fusion else None
        )

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

        # ---- Lifecycle transitions (gesture / countdown / external) ----
        countdown_remaining: Optional[float] = None
        if self.phase == "WAITING_FOR_START":
            # Start on a thumbs-up held while correctly positioned, or on an
            # external start (voice / button — allowed regardless of framing).
            gesture_start = (
                bool(setup_status.get("ok"))
                and self._gesture_confirmed(GESTURE_CONFIRM_FRAMES, now)
            )
            if gesture_start or self._start_requested:
                self._start_requested = False
                self._thumb_frames = 0
                self.phase = "COUNTDOWN"
                self._countdown_start = now
        elif self.phase == "COUNTDOWN":
            elapsed = now - (self._countdown_start or now)
            countdown_remaining = max(0.0, COUNTDOWN_SEC - elapsed)
            if elapsed >= COUNTDOWN_SEC:
                self.phase = "SET_ACTIVE"
                self._set_start_t = now
                self._still_since = None
                self.counter.pause_streaks()
        elif self.phase in ("DEBRIEF", "SET_END"):
            # Advance to the next set on a thumbs-up or external "next".
            if (self._gesture_confirmed(GESTURE_CONFIRM_FRAMES, now)
                    or self._next_requested):
                self._next_requested = False
                self.reset_set()

        # ---- ROM + reps (only while the set is live) ----
        new_flags: list[str] = []
        if self.phase == "SET_ACTIVE":
            if self._set_start_t is None:
                self._set_start_t = now
            self.rom_min = min(self.rom_min, angle)
            self.rom_max = max(self.rom_max, angle)
            # Camera drives the rep state machine. IMU keeps the depth gauge
            # alive during occlusion but won't increment reps on its own.
            if tracking_source == "camera":
                new_flags = self.counter.update(angle, now, source="camera")
            else:
                self.counter.pause_streaks()
        active_flags = self._update_active_flags(new_flags, now)

        # ---- Stuck-in-down recovery (user sat down / walked off mid-rep). ----
        if (
            self.phase == "SET_ACTIVE"
            and self.counter.current_phase() == "down"
            and now - self.counter.current_rep_start() > STUCK_DOWN_SEC
        ):
            self.counter.force_reset_to_up()

        # ---- End the live set: thumbs-up hold, rep target, stillness, button ----
        if self.phase == "SET_ACTIVE":
            if self._gesture_confirmed(END_GESTURE_CONFIRM_FRAMES, now):
                self._set_end_requested = True
            if self._check_set_end(angle, now):
                self.phase = "SET_END"

        self._emit_state(
            angle=angle, tracking_source=tracking_source,
            leg_vis=leg_vis, imu_quality=imu_quality,
            active_flags=active_flags, setup_status=setup_status,
            countdown=countdown_remaining,
        )

        # ---- Set-end summary fires once. ----
        if self.phase == "SET_END" and not self._set_emitted:
            self._set_emitted = True
            summary = self._build_summary(now)
            try:
                self.on_set_end(summary)
            except Exception as e:
                print(f"[pose_tracker] on_set_end error: {e}")
            # Async Gemini call so the frame loop doesn't block 1-3s on it.
            self._spawn_ai_debrief(summary, self.profile)
            self.phase = "DEBRIEF"

    def _spawn_ai_debrief(self, summary: dict, profile: PTProfile) -> None:
        """Run the AI debrief Gemini call on a daemon thread.

        Fires `on_ai_debrief(text)` when the call succeeds. Silent if Gemini
        is unavailable — the UI still has `summary.templated_debrief` as the
        always-on fallback (reliability rule, CONTEXT §8).
        """
        import threading

        def _work():
            try:
                # Local import so a missing google-generativeai install
                # doesn't break import-time of pose_tracker.
                from ai_agent import generate_debrief
                text = generate_debrief(profile, summary)
            except Exception as e:
                print(f"[pose_tracker] ai_debrief error: {e}")
                return
            if not text:
                return
            try:
                self.on_ai_debrief(text)
            except Exception as e:
                print(f"[pose_tracker] on_ai_debrief callback error: {e}")

        t = threading.Thread(target=_work, daemon=True, name="ai-debrief")
        t.start()

    def _emit_state(
        self, *, angle: Optional[float], tracking_source: str,
        leg_vis: float, imu_quality: float,
        active_flags: list[str], setup_status: dict,
        countdown: Optional[float] = None,
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
            "exercise": self.exercise_spec.id,
            "exercise_ui": self.exercise_spec.to_ui(),
            "target_depth_deg": round(self.target_depth_deg, 1),
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
            "profile": self.profile.to_dict(),
            # Gesture + lifecycle hints for the dashboard.
            "gesture": "thumbs_up" if self._thumbs_up_now else None,
            "thumb_progress": round(
                min(1.0, self._thumb_frames / GESTURE_CONFIRM_FRAMES), 2
            ),
            "countdown": (
                int(math.ceil(countdown)) if countdown is not None and countdown > 0
                else (0 if countdown is not None else None)
            ),
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


class ExerciseTracker(PoseTracker):
    """Generic, spec-driven tracker. Takes an `ExerciseSpec` OBJECT directly
    (e.g. one generated from PT documentation) rather than a registry id, then
    runs the exact same real-time engine as the squat — no LLM on the rep path.

        tracker = ExerciseTracker(spec, imu_source=imu, on_state=..., on_set_end=...)

    With `SQUAT_SPEC` it is behaviourally identical to the original squat tracker.
    """

    def __init__(self, spec: ExerciseSpec, imu_source=None,
                 on_state=None, on_set_end=None, **kwargs):
        super().__init__(imu_source=imu_source, on_state=on_state,
                         on_set_end=on_set_end, **kwargs)
        self.load_exercise_spec(spec)


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
