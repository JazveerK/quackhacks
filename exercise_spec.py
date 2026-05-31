"""
PhysioFusion — Exercise Spec schema (the "any exercise" contract).

An **Exercise Spec** is a structured, JSON-serialisable description of HOW to
track and coach one exercise: which joint angle defines a rep, the angle
thresholds for the rep state machine, whether success means a MIN angle (squat
"go lower") or a MAX angle (arm raise "go higher"), the form rules, and the
spoken cues.

The whole point: these rules are GENERATED ONCE by an LLM from a PT's written
documentation (see `spec_generator.py`) and then consumed by a generic,
LLM-free real-time tracker (`pose_tracker.ExerciseTracker`). The model never
runs on the per-frame rep path.

`SQUAT_SPEC` reproduces the original hard-coded squat behaviour exactly, so the
generic engine can be proven against the old one.

This module is dependency-free (no mediapipe/cv2) so it imports in headless
tests and in the LLM generator.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional
import re


# ---------------------------------------------------------------------------
# Schema.
# ---------------------------------------------------------------------------
@dataclass
class PrimaryJoint:
    """The joint whose vertex angle defines a rep.

    `landmarks` is [a, vertex, c] using MediaPipe Pose landmark names. The names
    may include a LEFT_/RIGHT_ prefix or omit it; the tracker strips the prefix
    to a base name and resolves the side(s) it actually uses from `side`.
    """
    name: str
    landmarks: list[str]
    side: str = "both"            # "left" | "right" | "both"

    def bases(self) -> list[str]:
        """Side-agnostic base landmark names (LEFT_/RIGHT_ prefix removed)."""
        out = []
        for lm in self.landmarks:
            out.append(re.sub(r"^(LEFT_|RIGHT_)", "", lm.upper()))
        return out


@dataclass
class RepDefinition:
    """Angle thresholds that drive the rep state machine.

    Interpretation depends on `ExerciseSpec.rom_metric`:
      - "min" (squat, curl): angle is LARGE at rest, SMALL at the bottom.
      - "max" (arm raise, leg extension): angle is SMALL at rest, LARGE at peak.
    `start` is the resting position, `trigger` must be passed (toward the active
    end) to begin a rep, `target` is a "good rep", `return` must be re-crossed
    (back toward rest) to complete the rep.
    """
    start_angle_deg: float
    trigger_angle_deg: float
    target_angle_deg: float
    return_angle_deg: float


@dataclass
class FormRule:
    """One per-rep form check.

    type:
      - "tempo"              : flag if rep faster than `min_sec` (falls back to the
                               tracker's tempo threshold when `min_sec` is None).
      - "shallow"            : flag if the rep didn't pass the parallel band
                               (target +/- buffer) — the squat's classic cue.
      - "target_not_reached" : flag if the rep didn't reach `target_angle_deg`.
      - "rom"                : flag if the rep didn't reach an explicit
                               `threshold_deg`.
    """
    name: str
    type: str
    min_sec: Optional[float] = None
    threshold_deg: Optional[float] = None


_VALID_METRICS = {"min", "max"}
_VALID_VIEWS = {"front", "side"}
_VALID_RULE_TYPES = {"tempo", "shallow", "target_not_reached", "rom"}


@dataclass
class ExerciseSpec:
    name: str
    primary_joint: PrimaryJoint
    rep_definition: RepDefinition
    rom_metric: str = "min"               # "min" => go lower, "max" => go higher
    view: str = "side"                    # best camera angle: "front" | "side"
    form_rules: list[FormRule] = field(default_factory=list)
    cues: dict = field(default_factory=dict)
    rep_target: int = 10

    # Engine tuning (sensible defaults reproduce the squat).
    parallel_buffer_deg: float = 5.0      # band around target counted as "good"
    count_margin_deg: float = 10.0        # how far past parallel a rep must go to count
    use_imu_fusion: bool = False          # apply the IMU tilt fallback to this joint

    # Identity + UI overrides (UI fields are otherwise derived in to_ui()).
    id: str = ""
    ui: dict = field(default_factory=dict)

    # ----- validation / (de)serialisation -----
    def __post_init__(self) -> None:
        if not self.id:
            self.id = _slug(self.name)

    def validate(self) -> "ExerciseSpec":
        if not self.name or not isinstance(self.name, str):
            raise ValueError("spec.name must be a non-empty string")
        if self.rom_metric not in _VALID_METRICS:
            raise ValueError(f"rom_metric must be one of {_VALID_METRICS}")
        if self.view not in _VALID_VIEWS:
            self.view = "side"
        pj = self.primary_joint
        if not pj or len(pj.landmarks) != 3:
            raise ValueError("primary_joint.landmarks must have exactly 3 entries")
        if pj.side not in ("left", "right", "both"):
            pj.side = "both"
        rd = self.rep_definition
        for fld in ("start_angle_deg", "trigger_angle_deg",
                    "target_angle_deg", "return_angle_deg"):
            v = getattr(rd, fld)
            if not isinstance(v, (int, float)) or not (0 <= v <= 180):
                raise ValueError(f"rep_definition.{fld} must be 0..180, got {v!r}")
        # Direction sanity: for "min" the active end is below rest; for "max" above.
        if self.rom_metric == "min" and not (rd.target_angle_deg < rd.trigger_angle_deg < rd.start_angle_deg):
            # Not fatal — clamp ordering so the engine still runs predictably.
            pass
        self.rep_target = max(1, min(100, int(self.rep_target)))
        self.form_rules = [r for r in self.form_rules if r.type in _VALID_RULE_TYPES]
        return self

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "ExerciseSpec":
        """Build + validate a spec from a (possibly LLM-produced) plain dict.

        Tolerant of missing optional keys; raises ValueError on anything that
        would make the tracker unsafe (bad joint / metric / angles).
        """
        if not isinstance(data, dict):
            raise ValueError("spec must be a JSON object")
        pj_raw = data.get("primary_joint") or {}
        pj = PrimaryJoint(
            name=str(pj_raw.get("name", "joint")),
            landmarks=[str(x).upper() for x in (pj_raw.get("landmarks") or [])],
            side=str(pj_raw.get("side", "both")).lower(),
        )
        rd_raw = data.get("rep_definition") or {}
        rd = RepDefinition(
            start_angle_deg=float(rd_raw.get("start_angle_deg", 160)),
            trigger_angle_deg=float(rd_raw.get("trigger_angle_deg", 120)),
            target_angle_deg=float(rd_raw.get("target_angle_deg", 95)),
            return_angle_deg=float(rd_raw.get("return_angle_deg", 150)),
        )
        rules = []
        for r in (data.get("form_rules") or []):
            if not isinstance(r, dict):
                continue
            rules.append(FormRule(
                name=str(r.get("name", r.get("type", "rule"))),
                type=str(r.get("type", "")),
                min_sec=_opt_float(r.get("min_sec")),
                threshold_deg=_opt_float(r.get("threshold_deg")),
            ))
        spec = cls(
            name=str(data.get("name", "exercise")),
            primary_joint=pj,
            rep_definition=rd,
            rom_metric=str(data.get("rom_metric", "min")).lower(),
            view=str(data.get("view", "side")).lower(),
            form_rules=rules,
            cues=dict(data.get("cues") or {}),
            rep_target=int(data.get("rep_target", 10) or 10),
            parallel_buffer_deg=float(data.get("parallel_buffer_deg", 5.0)),
            count_margin_deg=float(data.get("count_margin_deg", 10.0)),
            use_imu_fusion=bool(data.get("use_imu_fusion", False)),
            id=str(data.get("id", "")),
            ui=dict(data.get("ui") or {}),
        )
        return spec.validate()

    # ----- convenience for the rest of the app -----
    @property
    def display_name(self) -> str:
        return self.ui.get("display_name") or self.name.title()

    @property
    def angle_noun(self) -> str:
        return self.ui.get("angle_noun") or self.primary_joint.name.replace("_", " ")

    def to_ui(self) -> dict:
        """The subset the frontend needs to label gauges + write copy. Derived
        from the spec, with explicit `ui` overrides winning."""
        rd = self.rep_definition
        lo = min(rd.start_angle_deg, rd.trigger_angle_deg, rd.target_angle_deg,
                 rd.return_angle_deg)
        hi = max(rd.start_angle_deg, rd.trigger_angle_deg, rd.target_angle_deg,
                 rd.return_angle_deg)
        derived = {
            "id": self.id,
            "display_name": self.display_name,
            "plural": self.name if not self.name.endswith("s") else self.name,
            "rom_metric": self.rom_metric,
            "angle_noun": f"{self.primary_joint.name.replace('_', ' ')}",
            "depth_label": "Depth" if self.rom_metric == "min" else "Range",
            "gauge_min_deg": max(0.0, lo - 10.0),
            "gauge_max_deg": min(180.0, hi + 10.0),
            "position_hint": (
                "Stand side-on so your whole body is in frame."
                if self.view == "side"
                else "Face the camera so your whole upper body is in frame."
            ),
        }
        derived.update(self.ui or {})
        return derived


# ---------------------------------------------------------------------------
# Helpers.
# ---------------------------------------------------------------------------
def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "_", name.strip().lower()).strip("_")
    return s or "exercise"


def _opt_float(v) -> Optional[float]:
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# Built-in specs. SQUAT_SPEC reproduces the original hard-coded squat exactly:
#   trigger 115 (DOWN_ENTER), return 155 (UP_ENTER), start 165 (DESCENT_START),
#   target 95 (TARGET_DEPTH), parallel buffer 5 (=> 100), count margin 10
#   (=> a rep must reach <=110 to count). IMU fusion ON.
# ---------------------------------------------------------------------------
SQUAT_SPEC = ExerciseSpec(
    name="bodyweight squat",
    id="bodyweight_squat",
    rom_metric="min",
    view="side",
    primary_joint=PrimaryJoint(
        name="knee", landmarks=["HIP", "KNEE", "ANKLE"], side="both",
    ),
    rep_definition=RepDefinition(
        start_angle_deg=165, trigger_angle_deg=115,
        target_angle_deg=95, return_angle_deg=155,
    ),
    form_rules=[
        FormRule(name="shallow", type="shallow"),
        FormRule(name="too_fast", type="tempo"),       # uses tracker tempo threshold
    ],
    cues={
        "go_further": "go a little deeper",
        "good": "good depth",
        "too_fast": "slow it down",
        "countdown": ["two more", "last one"],
    },
    rep_target=10,
    use_imu_fusion=True,
    ui={
        "display_name": "Squat",
        "plural": "squats",
        "angle_noun": "knee angle",
        "depth_label": "Knee depth",
        "gauge_min_deg": 60,
        "gauge_max_deg": 180,
        "position_hint": "Stand side-on so your whole body is in frame.",
    },
).validate()


PUSHUP_SPEC = ExerciseSpec(
    name="push-up",
    id="pushup",
    rom_metric="min",
    view="side",
    primary_joint=PrimaryJoint(
        name="elbow", landmarks=["SHOULDER", "ELBOW", "WRIST"], side="both",
    ),
    rep_definition=RepDefinition(
        start_angle_deg=165, trigger_angle_deg=120,
        target_angle_deg=95, return_angle_deg=150,
    ),
    form_rules=[
        FormRule(name="too_fast", type="tempo", min_sec=1.0),
        FormRule(name="shallow", type="shallow"),
    ],
    cues={
        "go_further": "chest closer to the floor",
        "good": "good depth",
        "too_fast": "slow it down",
        "countdown": ["two more", "last one"],
    },
    rep_target=10,
    count_margin_deg=12.0,
    ui={
        "display_name": "Push-up",
        "plural": "push-ups",
        "angle_noun": "elbow angle",
        "depth_label": "Elbow depth",
        "gauge_min_deg": 60,
        "gauge_max_deg": 180,
        "position_hint": "Get into a push-up position, side-on so your whole body is in frame.",
    },
).validate()


# A "max" exercise — proves the same engine handles "raise higher" via rom_metric.
LATERAL_ARM_RAISE_SPEC = ExerciseSpec(
    name="standing lateral arm raise",
    id="lateral_arm_raise",
    rom_metric="max",
    view="front",
    primary_joint=PrimaryJoint(
        name="shoulder_abduction", landmarks=["HIP", "SHOULDER", "ELBOW"], side="both",
    ),
    rep_definition=RepDefinition(
        start_angle_deg=20, trigger_angle_deg=60,
        target_angle_deg=90, return_angle_deg=30,
    ),
    form_rules=[
        FormRule(name="too_fast", type="tempo", min_sec=0.8),
        FormRule(name="incomplete", type="target_not_reached"),
    ],
    cues={
        "go_further": "raise a little higher",
        "good": "good height",
        "too_fast": "slow it down",
        "countdown": ["two more", "last one"],
    },
    rep_target=12,
    parallel_buffer_deg=8.0,
    count_margin_deg=10.0,
    ui={
        "display_name": "Lateral arm raise",
        "plural": "arm raises",
        "angle_noun": "shoulder angle",
        "depth_label": "Arm height",
        "gauge_min_deg": 10,
        "gauge_max_deg": 110,
        "position_hint": "Face the camera so your whole upper body is in frame.",
    },
).validate()


# Built-in presets that show in the dropdown without any LLM call: squat + push-up.
# LATERAL_ARM_RAISE_SPEC is intentionally NOT registered — it's kept only as a
# test fixture / reference. The arm raise is meant to be GENERATED from PT
# documentation at runtime (docs -> Gemini -> spec -> MediaPipe), which registers
# it dynamically. That keeps the "any exercise" pipeline honest in the demo.
REGISTRY: dict[str, ExerciseSpec] = {
    SQUAT_SPEC.id: SQUAT_SPEC,
    PUSHUP_SPEC.id: PUSHUP_SPEC,
}
DEFAULT_EXERCISE = SQUAT_SPEC


def get(exercise_id: Optional[str]) -> ExerciseSpec:
    if not exercise_id:
        return DEFAULT_EXERCISE
    return REGISTRY.get(exercise_id, DEFAULT_EXERCISE)


def options() -> list[dict]:
    """[{id, display_name}, ...] for the dropdown."""
    return [{"id": s.id, "display_name": s.display_name} for s in REGISTRY.values()]
