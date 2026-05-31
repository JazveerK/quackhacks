"""
Headless smoke test for the generalized ("any exercise") engine.

Proves:
  1) SQUAT_SPEC through the generic RepCounter behaves like the old SquatCounter.
  2) A "max" exercise (lateral arm raise) counts reps through the SAME engine.
  3) Half-reps below the count gate don't count.
  4) An Exercise Spec validates from a plain dict; the LLM generator falls back
     safely with no API key.
  5) PoseTracker / ExerciseTracker wire a non-squat spec without a camera.

Run:  .venv/bin/python smoke_exercises.py
"""
from __future__ import annotations

from exercise_spec import ExerciseSpec, SQUAT_SPEC, LATERAL_ARM_RAISE_SPEC, options
import spec_generator
from pose_tracker import RepCounter, SquatCounter, PoseTracker, ExerciseTracker

FPS = 30.0
DT = 1.0 / FPS


def feed_cycle(counter, t0, rest, peak, rise_s=1.2, hold_s=0.2, fall_s=1.2):
    """Feed one rep: rest -> peak -> rest, frame by frame. Direction-agnostic —
    works for a squat (peak < rest) and an arm raise (peak > rest)."""
    t = t0
    for _ in range(3):
        counter.update(rest, t, "camera"); t += DT
    n = int(rise_s * FPS)
    for i in range(n):
        counter.update(rest + (peak - rest) * (i + 1) / n, t, "camera"); t += DT
    for _ in range(int(hold_s * FPS)):
        counter.update(peak, t, "camera"); t += DT
    n = int(fall_s * FPS)
    for i in range(n):
        counter.update(peak + (rest - peak) * (i + 1) / n, t, "camera"); t += DT
    for _ in range(5):
        counter.update(rest, t, "camera"); t += DT
    return t


def main() -> int:
    ok = True
    print("exercises:", [o["id"] for o in options()])

    # 1) SQUAT_SPEC through RepCounter == SquatCounter (3 deep squats).
    c1, c2 = RepCounter(SQUAT_SPEC), SquatCounter()
    t = 0.0
    for b in [90, 92, 95]:
        t = feed_cycle(c1, t, 172, b)
    t = 0.0
    for b in [90, 92, 95]:
        t = feed_cycle(c2, t, 172, b)
    print("SQUAT_SPEC:", c1.rep_count, c1.rep_depths, "| SquatCounter:", c2.rep_count, c2.rep_depths)
    if not (c1.rep_count == c2.rep_count == 3 and c1.rep_depths == c2.rep_depths):
        print("  !! squat equivalence FAILED"); ok = False

    # 2) Lateral arm raise (rom_metric=max) counts via the SAME engine.
    c3 = RepCounter(LATERAL_ARM_RAISE_SPEC)
    t = 0.0
    for peak in [92, 90, 88]:
        t = feed_cycle(c3, t, 15, peak)
    print("arm-raise reps:", c3.rep_count, "ranges:", [round(d) for d in c3.rep_depths])
    if c3.rep_count != 3:
        print("  !! arm-raise count FAILED"); ok = False

    # 3) Half raises (peak 50, below trigger 60) must NOT count.
    c4 = RepCounter(LATERAL_ARM_RAISE_SPEC)
    t = 0.0
    for peak in [50, 50]:
        t = feed_cycle(c4, t, 15, peak)
    print("half arm-raise reps (want 0):", c4.rep_count)
    if c4.rep_count != 0:
        print("  !! half-raise gate FAILED"); ok = False

    # 4) Spec validates from a dict; generator falls back safely without a key.
    example = {
        "name": "standing lateral arm raise", "view": "front", "rom_metric": "max",
        "primary_joint": {"name": "shoulder_abduction",
                          "landmarks": ["HIP", "SHOULDER", "ELBOW"], "side": "both"},
        "rep_definition": {"start_angle_deg": 20, "trigger_angle_deg": 60,
                           "target_angle_deg": 90, "return_angle_deg": 30},
        "form_rules": [{"name": "too_fast", "type": "tempo", "min_sec": 0.8},
                       {"name": "incomplete", "type": "target_not_reached"}],
        "cues": {"go_further": "raise higher", "good": "good height",
                 "too_fast": "slow it down", "countdown": ["two more", "last one"]},
        "rep_target": 12,
    }
    sp = ExerciseSpec.from_dict(example)
    print("from_dict:", sp.id, sp.rom_metric, "| depth_label:", sp.to_ui()["depth_label"])
    res = spec_generator.generate_spec_from_docs("lateral arm raise to shoulder height, 12 reps")
    print("generate_spec_from_docs:", res["source"], "| error:", res["error"])
    if res["source"] not in ("generated", "default"):
        print("  !! generator returned an unexpected source"); ok = False

    # 5) Loading a spec OBJECT (the doc-upload path) wires a non-squat exercise.
    #    Arm raise is NOT a preset, so this mirrors how it'll be loaded live.
    pt = ExerciseTracker(LATERAL_ARM_RAISE_SPEC)
    print("ExerciseTracker:", pt.exercise_spec.id, "sgn", pt._sgn, "target", pt.target_depth_deg,
          "parallel", pt.parallel_deg)
    if not (pt.exercise_spec.id == "lateral_arm_raise" and pt._sgn == 1.0 and pt.target_depth_deg == 90):
        print("  !! ExerciseTracker spec wiring FAILED"); ok = False
    pts = PoseTracker()
    if pts.exercise_spec.id != "bodyweight_squat" or pts._sgn != -1.0:
        print("  !! default squat wiring FAILED"); ok = False

    # 6) Presets are squat + push-up only; arm raise must come from documentation.
    preset_ids = [o["id"] for o in options()]
    print("presets:", preset_ids)
    if preset_ids != ["bodyweight_squat", "pushup"]:
        print("  !! unexpected presets"); ok = False

    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
