"""
PhysioFusion — mock_state.py

A fake data generator for the UI (Agent C) so the dashboard can be built and
demoed without the camera, IMU, or pose core.

Per-frame state matches CONTEXT.md section 4c (incl. the `setup_status` field).
Per-set summary matches CONTEXT.md section 4d (incl. the `analysis` sub-object
and the `templated_debrief` fallback string).

Use:
    from mock_state import state_stream, sample_set_summary

    for state in state_stream():
        await ws.send_json({"type": "state", "state": state})
        await asyncio.sleep(0.03)   # ~30 fps

    summary = sample_set_summary()
"""

from __future__ import annotations

import math
import time


TARGET_DEPTH_DEG = 95
PARALLEL_DEG = 100


def _depth_state(angle: float) -> str:
    if angle <= TARGET_DEPTH_DEG:
        return "below_parallel"
    if angle <= PARALLEL_DEG:
        return "at_parallel"
    return "shallow"


def _setup_ok() -> dict:
    return {"ok": True, "severity": "good", "code": "ok",
            "hint": "Tracking — go."}


def _setup_occluded() -> dict:
    return {"ok": False, "severity": "warning", "code": "legs_out_of_frame",
            "hint": "Step back so your full body is in the camera."}


def _lerp(a: float, b: float, n: int):
    for k in range(n):
        yield a + (b - a) * (k / (n - 1))


# ---------------------------------------------------------------------------
# Per-frame stream.
# ---------------------------------------------------------------------------
def state_stream(rep_target: int = 10, fps: int = 30):
    """Yield per-frame state dicts that simulate a full squat set.

    Includes an occlusion window mid-set (rep 5) where `tracking_source` flips
    to "imu" and `setup_status.code` becomes "legs_out_of_frame" — use this to
    build and visually verify the tracking-source panel + setup-hint banner.
    """
    rep_depths: list[float] = []
    rep_count = 0
    # Shallower mins later in the set => fatigue story.
    planned_mins = [88, 89, 90, 91, 93, 96, 99, 103, 107, 110][:rep_target]
    rom_max = 172.0
    tempo = 1.6
    frame_dt = 1.0 / fps

    for i, min_angle in enumerate(planned_mins):
        steps_down = list(_lerp(170, min_angle, 8))
        steps_up = list(_lerp(min_angle, 170, 8))
        occluded_rep = (i == 4)

        for j, angle in enumerate(steps_down + steps_up):
            in_descent = j < len(steps_down)
            occluded = occluded_rep and 3 <= j <= 11   # mid-rep window

            flags: list[str] = []
            if in_descent and 95 < angle < 140 and min_angle > 95:
                flags.append("shallow")

            rom_min = round(min(rep_depths), 1) if rep_depths else round(angle, 1)

            yield {
                "phase": "SET_ACTIVE",
                "angle": round(angle, 1),
                "rep_count": rep_count,
                "rep_target": rep_target,
                "rom_min": rom_min,
                "rom_max": rom_max,
                "depth_state": _depth_state(angle),
                "form_flags": flags,
                "tempo": tempo,
                "imu_quality": 0.96,
                "landmark_visibility": 0.15 if occluded else 0.92,
                "tracking_source": "imu" if occluded else "camera",
                "rep_depths": list(rep_depths),
                "setup_status": _setup_occluded() if occluded else _setup_ok(),
            }
            time.sleep(frame_dt)

        rep_count += 1
        rep_depths.append(round(min_angle, 1))

    # Set-end frame.
    final_rom_min = round(min(rep_depths), 1) if rep_depths else 170.0
    yield {
        "phase": "SET_END",
        "angle": 170.0,
        "rep_count": rep_count,
        "rep_target": rep_target,
        "rom_min": final_rom_min,
        "rom_max": rom_max,
        "depth_state": _depth_state(170.0),
        "form_flags": [],
        "tempo": tempo,
        "imu_quality": 0.96,
        "landmark_visibility": 0.92,
        "tracking_source": "camera",
        "rep_depths": list(rep_depths),
        "setup_status": _setup_ok(),
    }


# ---------------------------------------------------------------------------
# Per-set summary (4d).
# ---------------------------------------------------------------------------
def _mean(xs):
    return sum(xs) / len(xs) if xs else 0.0


def _stddev(xs):
    if len(xs) < 2:
        return 0.0
    m = _mean(xs)
    return math.sqrt(sum((x - m) ** 2 for x in xs) / (len(xs) - 1))


def sample_set_summary(rep_target: int = 10) -> dict:
    """A per-set summary in the current 4d shape (including `analysis` and
    `templated_debrief`). Hand this to the debrief view to test the layout."""
    depths = [88, 89, 90, 91, 93, 96, 99, 103, 107, 110][:rep_target]
    # Per-rep tempos — slowing down late = fatigue.
    tempos = [round(1.8 + 0.1 * i, 2) for i in range(len(depths))]
    eccentrics = [round(t * 0.45, 2) for t in tempos]
    concentrics = [round(t - e, 2) for t, e in zip(tempos, eccentrics)]

    shallow_idx = [i + 1 for i, d in enumerate(depths) if d > PARALLEL_DEG]
    fast_idx: list[int] = []

    flag_counts = {"shallow": len(shallow_idx), "too_fast": len(fast_idx)}

    mid = len(depths) // 2
    first_half = depths[:mid]
    second_half = depths[mid:]
    first_half_avg = round(_mean(first_half), 1)
    second_half_avg = round(_mean(second_half), 1)
    halves_delta = round(second_half_avg - first_half_avg, 1)

    tempo_mid = len(tempos) // 2
    tempo_delta = round(_mean(tempos[tempo_mid:]) - _mean(tempos[:tempo_mid]), 2)
    tempo_trend = "slowing_down" if tempo_delta > 0.3 else "consistent"
    depth_trend = "declining_late" if halves_delta > 4 else "consistent"

    fatigue_signals: list[str] = []
    if depth_trend == "declining_late":
        fatigue_signals.append("depth_decline")
    if tempo_trend == "slowing_down":
        fatigue_signals.append("tempo_decline")
    fatigue_label = (
        "none" if not fatigue_signals
        else fatigue_signals[0] if len(fatigue_signals) == 1
        else "both"
    )

    ec_ratios = [
        e / c if c > 0 else 0.0 for e, c in zip(eccentrics, concentrics)
    ]
    ec_ratio_mean = round(_mean(ec_ratios), 2)

    reps_at_target = sum(1 for d in depths if d <= TARGET_DEPTH_DEG)
    hit_rate = round(reps_at_target / len(depths), 2) if depths else 0.0

    notes = [
        f"Average knee angle at bottom was {_mean(depths):.0f}° "
        f"(target {TARGET_DEPTH_DEG}°).",
        f"{int(hit_rate * 100)}% of reps reached target "
        f"({reps_at_target} of {len(depths)}).",
        "Depth got shallower in the second half — late-set fatigue pattern.",
        f"{len(shallow_idx)} rep(s) above parallel: rep "
        f"{', '.join(str(i) for i in shallow_idx)}.",
    ]

    templated = (
        f"Completed {len(depths)} of {rep_target} reps. "
        f"Average depth {_mean(depths):.0f}° "
        f"({int(hit_rate * 100)}% of reps at or below target {TARGET_DEPTH_DEG}°). "
        "Depth dropped off in the second half — classic late-set fatigue. "
        "Next set, drop the target by 2 reps and focus on hitting depth on every one."
    )

    return {
        # Legacy 4d (unchanged shape).
        "exercise": "bodyweight_squat",
        "reps_completed": len(depths),
        "rep_target": rep_target,
        "rep_depths_deg": depths,
        "target_depth_deg": TARGET_DEPTH_DEG,
        "depth_trend": depth_trend,
        "form_flag_counts": flag_counts,
        "fatigue_signal": fatigue_label,
        # Rich breakdown for the Gemini debrief.
        "analysis": {
            "set_duration_sec": 41.2,
            "voided_reps": 0,
            "depth": {
                "per_rep_deg": depths,
                "mean_deg": round(_mean(depths), 1),
                "stddev_deg": round(_stddev(depths), 1),
                "min_deg": min(depths),
                "max_deg": max(depths),
                "target_deg": TARGET_DEPTH_DEG,
                "reps_at_or_below_target": reps_at_target,
                "target_hit_rate": hit_rate,
                "trend": depth_trend,
                "first_half_avg_deg": first_half_avg,
                "second_half_avg_deg": second_half_avg,
                "halves_delta_deg": halves_delta,
            },
            "tempo": {
                "per_rep_sec": tempos,
                "eccentric_per_rep_sec": eccentrics,
                "concentric_per_rep_sec": concentrics,
                "mean_sec": round(_mean(tempos), 2),
                "stddev_sec": round(_stddev(tempos), 2),
                "trend": tempo_trend,
                "halves_delta_sec": tempo_delta,
                "eccentric_concentric_ratio_mean": ec_ratio_mean,
            },
            "rom": {"min_deg": min(depths), "max_deg": 175},
            "form": {
                "flag_counts": flag_counts,
                "shallow_rep_indices": shallow_idx,
                "fast_rep_indices": fast_idx,
                "notes": notes,
            },
            "tracking": {
                "camera_frame_ratio": 0.93,
                "imu_frame_ratio": 0.07,
                "occlusion_events": 1,
            },
        },
        "templated_debrief": templated,
    }


if __name__ == "__main__":
    print("Simulating a squat set (Ctrl-C to stop)...\n")
    for s in state_stream(rep_target=10):
        if s["rep_count"] or s["form_flags"] or s["tracking_source"] == "imu":
            print(
                f"rep {s['rep_count']:>2}  angle {s['angle']:>5}  "
                f"src {s['tracking_source']:<6}  vis {s['landmark_visibility']}  "
                f"flags {s['form_flags']}  setup={s['setup_status']['code']}"
            )
    print("\n--- sample per-set summary for the debrief view ---")
    import json
    print(json.dumps(sample_set_summary(), indent=2))
