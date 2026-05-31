"""
Headless smoke tests for the SteadyPT rep counter.

No webcam, no MediaPipe — synthesizes knee-angle traces and feeds them into
SquatCounter directly. This is the layer where the "10 phantom reps while
standing" bug lived, so this is what we want to lock down.

Run:
    .venv/bin/python smoke.py
"""

from __future__ import annotations

import math
import sys
import time

import pose_tracker
from pose_tracker import (
    SquatCounter,
    PoseTracker,
    DEBOUNCE_FRAMES,
    DOWN_ENTER_DEG,
    UP_ENTER_DEG,
    PARALLEL_DEG,
    MIN_REP_SEC,
    MAX_REP_SEC,
    MIN_CAM_FRAC,
    FAST_REP_SEC,
    NO_POSE_SETUP_SEC,
    LM,
)

FPS = 30
DT = 1.0 / FPS


# ---------------------------------------------------------------------------
# Trace generators. Each is a function t -> angle_deg, or None when the
# trace is finished.
# ---------------------------------------------------------------------------
def squat_wave(
    num_reps: int,
    descent_s: float = 1.2,
    hold_s: float = 0.3,
    ascent_s: float = 1.2,
    rest_s: float = 0.5,
    top_deg: float = 175.0,
    bot_deg: float = 85.0,
):
    period = descent_s + hold_s + ascent_s + rest_s
    total = period * num_reps

    def f(t: float):
        if t > total:
            return None
        local = t % period
        if local < descent_s:
            return top_deg - (top_deg - bot_deg) * (local / descent_s)
        local -= descent_s
        if local < hold_s:
            return bot_deg
        local -= hold_s
        if local < ascent_s:
            return bot_deg + (top_deg - bot_deg) * (local / ascent_s)
        return top_deg
    return f


def flat(angle: float, duration_s: float):
    def f(t: float):
        return None if t > duration_s else angle
    return f


def noisy(angle: float, amplitude: float, duration_s: float, freq: float = 1.0):
    def f(t: float):
        if t > duration_s:
            return None
        return angle + amplitude * math.sin(2 * math.pi * freq * t)
    return f


def run_trace(angle_at_time) -> SquatCounter:
    counter = SquatCounter()
    t = 0.0
    while True:
        a = angle_at_time(t)
        if a is None:
            return counter
        counter.update(a, t)
        t += DT


# ---------------------------------------------------------------------------
# Assertion helpers.
# ---------------------------------------------------------------------------
results: list[bool] = []

def check(name: str, ok: bool, expected, actual):
    sigil = "PASS" if ok else "FAIL"
    print(f"  [{sigil}] {name:<48} expected={expected!s:<14} actual={actual!s}")
    results.append(ok)


# ---------------------------------------------------------------------------
# Tests.
# ---------------------------------------------------------------------------
def t1_clean_deep():
    print("\n[1] 10 clean deep squats (3.2s each, min 85°)")
    c = run_trace(squat_wave(10))
    check("rep_count == 10", c.rep_count == 10, 10, c.rep_count)
    check("no shallow flags", c.flag_counts["shallow"] == 0, 0, c.flag_counts["shallow"])
    check("no too_fast flags", c.flag_counts["too_fast"] == 0, 0, c.flag_counts["too_fast"])
    if c.rep_depths:
        check("min depth below parallel", min(c.rep_depths) < PARALLEL_DEG,
              f"<{PARALLEL_DEG}°", f"{min(c.rep_depths):.1f}°")


def t2_shallow():
    print("\n[2] 5 shallow squats (bottom 105°, above parallel)")
    c = run_trace(squat_wave(5, bot_deg=105.0))
    check("rep_count == 5", c.rep_count == 5, 5, c.rep_count)
    check("shallow flag >= 5", c.flag_counts["shallow"] >= 5,
          ">=5", c.flag_counts["shallow"])


def t3_standing_still():
    print("\n[3] 10s standing still at 175°")
    c = run_trace(flat(175.0, 10.0))
    check("rep_count == 0", c.rep_count == 0, 0, c.rep_count)


def t4_noisy_idle():
    print("\n[4] 10s noisy idle (170° ± 8°)")
    c = run_trace(noisy(170.0, 8.0, 10.0, freq=0.7))
    check("rep_count == 0", c.rep_count == 0, 0, c.rep_count)


def t5_single_spurious_dip():
    print("\n[5] One spurious frame to 100° (below DOWN_ENTER_DEG)")
    def trace(t: float):
        if t > 5.0:
            return None
        if 2.000 <= t <= 2.001:
            return 100.0
        return 175.0
    c = run_trace(trace)
    check("rep_count == 0 (debounced)", c.rep_count == 0, 0, c.rep_count)


def t6_too_brief_dip():
    print(f"\n[6] 2-frame dip past threshold (< DEBOUNCE_FRAMES={DEBOUNCE_FRAMES})")
    counter = SquatCounter()
    t = 0.0
    for _ in range(30):
        counter.update(175.0, t); t += DT
    for _ in range(DEBOUNCE_FRAMES - 1):
        counter.update(100.0, t); t += DT
    for _ in range(30):
        counter.update(175.0, t); t += DT
    check("rep_count == 0 (below debounce)", counter.rep_count == 0, 0, counter.rep_count)


def t7_impossibly_fast():
    print(f"\n[7] Rep completing in ~0.2s (< MIN_REP_SEC={MIN_REP_SEC}s) — voided")
    counter = SquatCounter()
    t = 0.0
    # enter down phase
    for _ in range(DEBOUNCE_FRAMES):
        counter.update(100.0, t); t += DT
    # immediately back up
    for _ in range(DEBOUNCE_FRAMES):
        counter.update(170.0, t); t += DT
    check("rep_count == 0 (too fast voided)", counter.rep_count == 0, 0, counter.rep_count)


def t8_fast_but_legit():
    print(f"\n[8] 3 reps, tempo ~1.3s (>= MIN_REP_SEC, < FAST_REP_SEC={FAST_REP_SEC}s)")
    c = run_trace(squat_wave(3, descent_s=0.5, hold_s=0.3, ascent_s=0.5, rest_s=0.4))
    check("rep_count == 3", c.rep_count == 3, 3, c.rep_count)
    check("too_fast flag >= 3", c.flag_counts["too_fast"] >= 3,
          ">=3", c.flag_counts["too_fast"])


def t9_source_switch_pause():
    print("\n[9] Source-switch guard (pause_streaks resets a near-trigger streak)")
    counter = SquatCounter()
    t = 0.0
    # build a partial down_streak (one short of trigger)
    for _ in range(DEBOUNCE_FRAMES - 1):
        counter.update(100.0, t); t += DT
    counter.pause_streaks()        # simulate camera<->IMU handoff
    counter.update(100.0, t); t += DT   # would have crossed debounce without pause
    counter.update(170.0, t); t += DT
    check("rep_count == 0 (streak cleared)", counter.rep_count == 0, 0, counter.rep_count)


# ---------------------------------------------------------------------------
# Helper: drive a single realistic squat through the counter.
# ---------------------------------------------------------------------------
def _drive_squat(
    counter: SquatCounter, t0: float, *,
    descent_s: float = 1.2, hold_s: float = 0.3, ascent_s: float = 1.2,
    rest_s: float = 0.5, top: float = 175.0, bot: float = 90.0,
    source: str = "camera",
) -> float:
    """Drive one squat into `counter` starting at time t0. Returns new time."""
    t = t0
    n = lambda s: max(1, int(s * FPS))
    # standing rest at top
    for _ in range(n(rest_s)):
        counter.update(top, t, source); t += DT
    # descent
    steps = n(descent_s)
    for i in range(steps):
        a = top - (top - bot) * (i + 1) / steps
        counter.update(a, t, source); t += DT
    # bottom hold
    for _ in range(n(hold_s)):
        counter.update(bot, t, source); t += DT
    # ascent
    for i in range(steps):
        a = bot + (top - bot) * (i + 1) / n(ascent_s)
        counter.update(a, t, source); t += DT
    # back to standing
    for _ in range(n(rest_s)):
        counter.update(top, t, source); t += DT
    return t


def t10_eccentric_concentric_split():
    print("\n[10] Eccentric (descent) vs concentric (ascent+hold) timing")
    counter = SquatCounter()
    _drive_squat(counter, 0.0, descent_s=1.0, hold_s=0.3, ascent_s=1.0)
    check("rep_count == 1", counter.rep_count == 1, 1, counter.rep_count)
    if counter.rep_count:
        ecc = counter.rep_eccentric[0]
        con = counter.rep_concentric[0]
        check("eccentric ~ 1.0s (in 0.6..1.3)", 0.6 <= ecc <= 1.3, "0.6..1.3s", f"{ecc:.2f}s")
        check("concentric ~ 1.3s (in 1.0..1.6)", 1.0 <= con <= 1.6, "1.0..1.6s", f"{con:.2f}s")
        check("cam_frac == 1.0", counter.rep_cam_frac[0] == 1.0, 1.0, counter.rep_cam_frac[0])


def t11_imu_dominated_rep_voided():
    print(f"\n[11] Rep with > {1 - MIN_CAM_FRAC:.0%} IMU frames during down phase -> voided")
    counter = SquatCounter()
    t = 0.0
    # standing
    for _ in range(int(0.5 * FPS)):
        counter.update(175.0, t, "camera"); t += DT
    # descent (camera) — this just gets us into down phase
    steps = int(1.0 * FPS)
    for i in range(steps):
        a = 175.0 - (175 - 90) * (i + 1) / steps
        counter.update(a, t, "camera"); t += DT
    # long bottom hold with IMU source (simulating occlusion mid-rep)
    for _ in range(int(3.0 * FPS)):
        counter.update(90.0, t, "imu"); t += DT
    # ascent (camera)
    for i in range(steps):
        a = 90.0 + (175 - 90) * (i + 1) / steps
        counter.update(a, t, "camera"); t += DT
    for _ in range(int(0.5 * FPS)):
        counter.update(175.0, t, "camera"); t += DT
    check("rep_count == 0", counter.rep_count == 0, 0, counter.rep_count)
    check("voided_reps == 1", counter.voided_reps == 1, 1, counter.voided_reps)


def t12_force_reset_to_up():
    print("\n[12] force_reset_to_up abandons in-progress rep cleanly")
    counter = SquatCounter()
    t = 0.0
    # enter down phase
    for _ in range(int(0.5 * FPS)):
        counter.update(175.0, t, "camera"); t += DT
    for i in range(int(1.0 * FPS)):
        counter.update(90.0, t, "camera"); t += DT
    # user sat down — assert we're in down phase, then force reset
    check("in 'down' before reset", counter.current_phase() == "down", "down", counter.current_phase())
    counter.force_reset_to_up()
    check("back to 'up' after reset", counter.current_phase() == "up", "up", counter.current_phase())
    check("rep_count still 0", counter.rep_count == 0, 0, counter.rep_count)
    # And a clean rep after reset should count.
    _drive_squat(counter, t, descent_s=1.0, hold_s=0.3, ascent_s=1.0)
    check("rep_count == 1 after fresh rep", counter.rep_count == 1, 1, counter.rep_count)


def t13_summary_structure_and_trends():
    print("\n[13] Per-set summary shape: legacy fields + analysis + templated_debrief")
    # Force the legacy thresholds (95°/1.5s) so the test's bot=105° trips the
    # shallow flag regardless of which profile is the package default.
    from profile import PTProfile
    test_profile = PTProfile(
        patient_name="Test", reps_per_set=6, depth_deg=95.0, tempo_sec=1.5,
    )
    tracker = PoseTracker(show_window=False, profile=test_profile)
    tracker._set_start_t = 0.0
    t = 0.0
    # 6 reps; the last 2 are shallow (bot=105) to trigger declining_late + shallow flag
    for i in range(6):
        bot = 90.0 if i < 4 else 105.0
        t = _drive_squat(tracker.counter, t, descent_s=1.0, hold_s=0.3,
                         ascent_s=1.0, rest_s=0.4, bot=bot)
    # Simulate the source aggregates.
    tracker._cam_frame_count = 1000
    tracker._imu_frame_count = 0
    summary = tracker._build_summary(t)

    # Legacy 4d top-level keys.
    for k in ("exercise", "reps_completed", "rep_target", "rep_depths_deg",
              "target_depth_deg", "depth_trend", "form_flag_counts",
              "fatigue_signal"):
        check(f"top-level '{k}'", k in summary, "present",
              "present" if k in summary else "MISSING")

    # Analysis sub-blocks.
    a = summary.get("analysis", {})
    for k in ("set_duration_sec", "voided_reps", "depth", "tempo",
              "rom", "form", "tracking"):
        check(f"analysis.{k}", k in a, "present",
              "present" if k in a else "MISSING")

    # Specific PT-relevant fields the AI agent will reach for.
    depth = a.get("depth", {})
    for k in ("mean_deg", "stddev_deg", "target_hit_rate", "trend",
              "first_half_avg_deg", "second_half_avg_deg", "halves_delta_deg"):
        check(f"depth.{k}", k in depth, "present",
              "present" if k in depth else "MISSING")
    tempo = a.get("tempo", {})
    for k in ("eccentric_per_rep_sec", "concentric_per_rep_sec",
              "mean_sec", "trend", "eccentric_concentric_ratio_mean"):
        check(f"tempo.{k}", k in tempo, "present",
              "present" if k in tempo else "MISSING")

    # Behavior: late-set shallow reps should produce declining_late + shallow flag.
    check("declining_late detected",
          summary["depth_trend"] == "declining_late",
          "declining_late", summary["depth_trend"])
    check("shallow_rep_indices populated",
          len(a["form"]["shallow_rep_indices"]) >= 2,
          ">=2", len(a["form"]["shallow_rep_indices"]))

    # Templated debrief is always a non-empty string.
    td = summary.get("templated_debrief", "")
    check("templated_debrief non-empty", isinstance(td, str) and len(td) > 20,
          ">20 char str", f"{type(td).__name__}({len(td) if isinstance(td, str) else '?'})")


# ---------------------------------------------------------------------------
# Setup classifier tests. Synthetic landmark list (33 entries, MediaPipe size).
# ---------------------------------------------------------------------------
class _SynthLM:
    def __init__(self, x: float = 0.5, y: float = 0.5, vis: float = 0.0) -> None:
        self.x = x; self.y = y; self.visibility = vis


def _synth_pose(side_view: bool = True, full_body: bool = True) -> list:
    """Build a 33-landmark list with shoulders/hips/legs filled in."""
    lms = [_SynthLM() for _ in range(33)]
    if side_view:
        # Shoulders/hips overlapping in x (small spread).
        lms[LM.LEFT_SHOULDER.value]  = _SynthLM(x=0.50, y=0.30, vis=0.9)
        lms[LM.RIGHT_SHOULDER.value] = _SynthLM(x=0.50, y=0.30, vis=0.9)
        lms[LM.LEFT_HIP.value]       = _SynthLM(x=0.50, y=0.55, vis=0.9)
        lms[LM.RIGHT_HIP.value]      = _SynthLM(x=0.50, y=0.55, vis=0.9)
    else:
        # Spread out — front view.
        lms[LM.LEFT_SHOULDER.value]  = _SynthLM(x=0.35, y=0.30, vis=0.9)
        lms[LM.RIGHT_SHOULDER.value] = _SynthLM(x=0.65, y=0.30, vis=0.9)
        lms[LM.LEFT_HIP.value]       = _SynthLM(x=0.40, y=0.55, vis=0.9)
        lms[LM.RIGHT_HIP.value]      = _SynthLM(x=0.60, y=0.55, vis=0.9)
    if full_body:
        for idx in (LM.LEFT_KNEE.value, LM.RIGHT_KNEE.value,
                    LM.LEFT_ANKLE.value, LM.RIGHT_ANKLE.value):
            lms[idx] = _SynthLM(x=0.50, y=0.80, vis=0.9)
    return lms


def t14_setup_no_person():
    print("\n[14] Setup classifier: no pose detected -> 'no_person' (blocking)")
    tr = PoseTracker(show_window=False)
    tr._last_frame_t = time.time()
    # last_pose_t stays None -> treated as "long ago"
    status = tr._classify_setup(None, 0.0, 0.0, False, time.time())
    check("code == no_person", status["code"] == "no_person",
          "no_person", status["code"])
    check("severity == blocking", status["severity"] == "blocking",
          "blocking", status["severity"])


def t15_setup_legs_out_of_frame():
    print("\n[15] Setup classifier: shoulders OK, legs low-vis -> 'legs_out_of_frame'")
    tr = PoseTracker(show_window=False)
    tr._last_frame_t = time.time()
    landmarks = _synth_pose(side_view=True, full_body=False)
    status = tr._classify_setup(landmarks, leg_vis=0.1, leg_vis_min=0.0,
                                camera_trusted=False, now=time.time())
    check("code == legs_out_of_frame",
          status["code"] == "legs_out_of_frame",
          "legs_out_of_frame", status["code"])


def t16_setup_front_view():
    print("\n[16] Setup classifier: full body but front-facing -> 'not_side_view'")
    tr = PoseTracker(show_window=False)
    tr._last_frame_t = time.time()
    landmarks = _synth_pose(side_view=False, full_body=True)
    status = tr._classify_setup(landmarks, leg_vis=0.85, leg_vis_min=0.7,
                                camera_trusted=True, now=time.time())
    check("code == not_side_view",
          status["code"] == "not_side_view",
          "not_side_view", status["code"])


def t17_setup_ok():
    print("\n[17] Setup classifier: side-on full body, good vis -> 'ok'")
    tr = PoseTracker(show_window=False)
    tr._last_frame_t = time.time()
    landmarks = _synth_pose(side_view=True, full_body=True)
    status = tr._classify_setup(landmarks, leg_vis=0.85, leg_vis_min=0.7,
                                camera_trusted=True, now=time.time())
    check("code == ok", status["code"] == "ok", "ok", status["code"])
    check("severity == good", status["severity"] == "good", "good", status["severity"])


# ---------------------------------------------------------------------------
# Profile binding (the PT prescription overrides backend defaults).
# ---------------------------------------------------------------------------
def t18_profile_drives_thresholds():
    print("\n[18] Profile drives target_depth_deg / rep_target on construction")
    from profile import PTProfile
    p = PTProfile(reps_per_set=8, depth_deg=110.0, tempo_sec=2.5)
    tr = PoseTracker(show_window=False, profile=p)
    check("rep_target == 8", tr.rep_target == 8, 8, tr.rep_target)
    check("target_depth_deg == 110", tr.target_depth_deg == 110.0, 110.0, tr.target_depth_deg)
    check("fast_rep_sec == 2.5", tr.fast_rep_sec == 2.5, 2.5, tr.fast_rep_sec)
    check("parallel_deg == 115 (target+5)", tr.parallel_deg == 115.0, 115.0, tr.parallel_deg)


def t19_depth_state_follows_profile():
    print("\n[19] depth_state classification follows the profile's target")
    from profile import PTProfile
    # Generic-default tracker: 95° target. 98° is at_parallel (in [95, 100]).
    tr_generic = PoseTracker(
        show_window=False,
        profile=PTProfile(reps_per_set=10, depth_deg=95.0, tempo_sec=1.5),
    )
    check("95° target: 98° -> at_parallel",
          tr_generic._depth_state(98.0) == "at_parallel",
          "at_parallel", tr_generic._depth_state(98.0))
    check("95° target: 110° -> shallow",
          tr_generic._depth_state(110.0) == "shallow",
          "shallow", tr_generic._depth_state(110.0))
    # Wider-prescription tracker: 120° target. 110° is now below_parallel.
    tr_wide = PoseTracker(
        show_window=False,
        profile=PTProfile(reps_per_set=10, depth_deg=120.0, tempo_sec=1.5),
    )
    check("120° target: 110° -> below_parallel",
          tr_wide._depth_state(110.0) == "below_parallel",
          "below_parallel", tr_wide._depth_state(110.0))
    check("120° target: 130° -> shallow",
          tr_wide._depth_state(130.0) == "shallow",
          "shallow", tr_wide._depth_state(130.0))


def t20_set_profile_is_queued_until_reset():
    print("\n[20] set_profile() is queued; doesn't change live thresholds mid-set")
    from profile import PTProfile
    tr = PoseTracker(
        show_window=False,
        profile=PTProfile(reps_per_set=10, depth_deg=95.0, tempo_sec=1.5),
    )
    check("initial target_depth_deg == 95", tr.target_depth_deg == 95.0, 95.0, tr.target_depth_deg)
    tr.set_profile(PTProfile(reps_per_set=5, depth_deg=120.0, tempo_sec=3.0))
    # Pending: live values UNCHANGED.
    check("after set_profile, target unchanged", tr.target_depth_deg == 95.0, 95.0, tr.target_depth_deg)
    check("after set_profile, rep_target unchanged", tr.rep_target == 10, 10, tr.rep_target)
    # reset_set applies it.
    tr.reset_set()
    check("after reset_set, target swapped", tr.target_depth_deg == 120.0, 120.0, tr.target_depth_deg)
    check("after reset_set, rep_target swapped", tr.rep_target == 5, 5, tr.rep_target)
    check("after reset_set, profile updated", tr.profile.reps_per_set == 5, 5, tr.profile.reps_per_set)


# ---------------------------------------------------------------------------
# ai_agent fallback paths — both functions return None cleanly without a key.
# ---------------------------------------------------------------------------
def t21_ai_agent_no_key_is_silent():
    print("\n[21] ai_agent: no GEMINI_API_KEY -> None, no exception")
    import os
    saved = os.environ.pop("GEMINI_API_KEY", None)
    try:
        import ai_agent
        from profile import DEFAULT_PROFILE
        r1 = ai_agent.parse_prescription("3x10 squats at 95 degrees")
        r2 = ai_agent.generate_debrief(DEFAULT_PROFILE, {"reps_completed": 0})
        check("parse_prescription -> None", r1 is None, None, r1)
        check("generate_debrief -> None", r2 is None, None, r2)
    finally:
        if saved is not None:
            os.environ["GEMINI_API_KEY"] = saved


def t22_summary_has_ai_debrief_slot():
    print("\n[22] Per-set summary always carries an `ai_debrief` slot (None on first emit)")
    tr = PoseTracker(show_window=False)
    tr._set_start_t = 0.0
    summary = tr._build_summary(0.0)
    check("'ai_debrief' key present", "ai_debrief" in summary, "present",
          "present" if "ai_debrief" in summary else "MISSING")
    check("'ai_debrief' is None on initial emit", summary["ai_debrief"] is None,
          None, summary["ai_debrief"])
    check("'profile' present in summary", "profile" in summary, "present",
          "present" if "profile" in summary else "MISSING")


# ---------------------------------------------------------------------------
# BigQuery — fail-closed behavior without Application Default Credentials.
# ---------------------------------------------------------------------------
def t23_bq_no_auth_is_silent():
    print("\n[23] bq: without Application Default Credentials -> falsy, no exception")
    import bq
    # Reset memoization in case prior tests / imports cached a client.
    bq._client = None
    bq._init_attempted = False
    available = bq.is_available()
    inserted = bq.insert_set("s1", 1, {"rep_depths_deg": [90, 92, 88]})
    rows = bq.query_recent_sets(limit=5)
    # Either auth is configured (Cloud Shell, or `gcloud auth application-default
    # login` already ran) and writes/reads work, or it isn't and we get the
    # graceful fallback. Both are valid; we only assert "no exception, no crash".
    check("is_available returned a bool", isinstance(available, bool),
          "bool", type(available).__name__)
    check("insert_set returned a bool", isinstance(inserted, bool),
          "bool", type(inserted).__name__)
    check("query_recent_sets returned a list", isinstance(rows, list),
          "list", type(rows).__name__)


def t24_bq_fatigue_score_mapping():
    print("\n[24] bq._fatigue_score maps fatigue_signal labels deterministically")
    import bq
    cases = [
        ("none", 0.0), ("depth_decline", 0.5),
        ("tempo_decline", 0.5), ("both", 1.0), ("garbage", 0.0),
    ]
    for sig, expected in cases:
        got = bq._fatigue_score({"fatigue_signal": sig})
        check(f"{sig!r} -> {expected}", got == expected, expected, got)


def t25_bq_next_recommendation_uses_analysis():
    print("\n[25] bq._next_recommendation reads from analysis trend fields")
    import bq
    s1 = {"analysis": {"depth": {"trend": "declining_late", "target_hit_rate": 0.6},
                       "tempo": {"trend": "consistent"}}}
    s2 = {"analysis": {"depth": {"trend": "consistent", "target_hit_rate": 0.5},
                       "tempo": {"trend": "slowing_down"}}}
    s3 = {"analysis": {"depth": {"trend": "consistent", "target_hit_rate": 0.95},
                       "tempo": {"trend": "consistent"}}}
    check("declining_late -> drop reps", "drop 2 reps" in bq._next_recommendation(s1),
          "drop 2 reps...", bq._next_recommendation(s1))
    check("slowing_down -> drop tempo", "drop tempo" in bq._next_recommendation(s2),
          "drop tempo...", bq._next_recommendation(s2))
    check("on-target -> hold/add", "hold" in bq._next_recommendation(s3),
          "hold...", bq._next_recommendation(s3))


def t26_session_report_no_key_is_silent():
    print("\n[26] ai_agent.generate_session_report: no key -> None")
    import os, ai_agent
    from profile import DEFAULT_PROFILE
    saved = os.environ.pop("GEMINI_API_KEY", None)
    try:
        out = ai_agent.generate_session_report(DEFAULT_PROFILE, [{"reps_completed": 8}])
        check("None when no key", out is None, None, out)
        empty = ai_agent.generate_session_report(DEFAULT_PROFILE, [])
        check("None when no rows", empty is None, None, empty)
    finally:
        if saved is not None:
            os.environ["GEMINI_API_KEY"] = saved


# ---------------------------------------------------------------------------
# Thumbs-up gesture detection (start / end / advance trigger).
# ---------------------------------------------------------------------------
class _SynthHand:
    def __init__(self, x: float, y: float) -> None:
        self.x = x; self.y = y


def _thumbs_up_hand() -> list:
    """21 hand landmarks shaped like a thumbs-up (y grows downward)."""
    from pose_tracker import HLM
    h = [_SynthHand(0.5, 0.5) for _ in range(21)]
    h[HLM.WRIST.value]      = _SynthHand(0.50, 0.90)
    h[HLM.THUMB_MCP.value]  = _SynthHand(0.45, 0.60)
    h[HLM.THUMB_IP.value]   = _SynthHand(0.44, 0.45)
    h[HLM.THUMB_TIP.value]  = _SynthHand(0.43, 0.28)
    # Four fingers curled: tip BELOW (larger y than) its PIP joint.
    for pip, tip in ((HLM.INDEX_FINGER_PIP, HLM.INDEX_FINGER_TIP),
                     (HLM.MIDDLE_FINGER_PIP, HLM.MIDDLE_FINGER_TIP),
                     (HLM.RING_FINGER_PIP, HLM.RING_FINGER_TIP),
                     (HLM.PINKY_PIP, HLM.PINKY_TIP)):
        h[pip.value] = _SynthHand(0.55, 0.55)
        h[tip.value] = _SynthHand(0.55, 0.66)
    return h


def _fist_hand() -> list:
    """Closed fist — thumb also curled, so NOT a thumbs-up."""
    h = _thumbs_up_hand()
    from pose_tracker import HLM
    h[HLM.THUMB_TIP.value] = _SynthHand(0.50, 0.66)   # thumb tip down
    return h


def t27_thumbs_up_detection():
    print("\n[27] Thumbs-up gesture: clear thumbs-up detected, fist rejected")
    from pose_tracker import detect_thumbs_up
    check("thumbs-up -> True", detect_thumbs_up(_thumbs_up_hand()) is True,
          True, detect_thumbs_up(_thumbs_up_hand()))
    check("fist -> False", detect_thumbs_up(_fist_hand()) is False,
          False, detect_thumbs_up(_fist_hand()))
    check("malformed -> False", detect_thumbs_up([]) is False,
          False, detect_thumbs_up([]))


def t28_set_score():
    print("\n[28] Set score: present, bounded, and a clean set beats a sloppy one")
    from profile import PTProfile
    p = PTProfile(reps_per_set=6, depth_deg=95.0, tempo_sec=1.5)

    # Clean deep set: 6 reps at 88°, controlled tempo.
    good = PoseTracker(show_window=False, profile=p)
    good._set_start_t = 0.0
    t = 0.0
    for _ in range(6):
        t = _drive_squat(good.counter, t, descent_s=1.2, hold_s=0.3,
                         ascent_s=1.2, rest_s=0.4, bot=88.0)
    good._cam_frame_count = 1000
    gs = good._build_summary(t)

    # Sloppy set: only 3 of 6 reps, all shallow at 115°.
    bad = PoseTracker(show_window=False, profile=p)
    bad._set_start_t = 0.0
    t = 0.0
    for _ in range(3):
        t = _drive_squat(bad.counter, t, descent_s=1.2, hold_s=0.3,
                         ascent_s=1.2, rest_s=0.4, bot=115.0)
    bad._cam_frame_count = 1000
    bs = bad._build_summary(t)

    check("'set_score' top-level", "set_score" in gs, "present",
          "present" if "set_score" in gs else "MISSING")
    check("'score' block present", isinstance(gs.get("score"), dict),
          "dict", type(gs.get("score")).__name__)
    check("score in 0..100", 0 <= gs["set_score"] <= 100, "0..100", gs["set_score"])
    for k in ("depth", "consistency", "tempo", "completion"):
        check(f"component '{k}'", k in gs["score"]["components"], "present",
              "present" if k in gs["score"]["components"] else "MISSING")
    check("clean set scores higher than sloppy set",
          gs["set_score"] > bs["set_score"],
          f">{bs['set_score']}", gs["set_score"])


def t29_voice_agent_fallback():
    print("\n[29] Voice agent: keyword fallback maps intent; actions validated")
    import os, ai_agent
    saved = os.environ.pop("GEMINI_API_KEY", None)
    try:
        r_start = ai_agent.converse("okay coach I'm ready let's go", {"phase":"WAITING_FOR_START"})
        r_end   = ai_agent.converse("alright I think I'm done", {"phase":"SET_ACTIVE"})
        r_next  = ai_agent.converse("next set please", {"phase":"DEBRIEF"})
        r_chat  = ai_agent.converse("what's the weather like", {"phase":"WAITING_FOR_START"})
        check("'ready, let's go' -> start_set", r_start["action"]=="start_set", "start_set", r_start["action"])
        check("'I'm done' -> end_set", r_end["action"]=="end_set", "end_set", r_end["action"])
        check("'next set' -> next_set", r_next["action"]=="next_set", "next_set", r_next["action"])
        check("chatter -> none", r_chat["action"]=="none", "none", r_chat["action"])
        for r in (r_start, r_end, r_next, r_chat):
            check("action in AGENT_ACTIONS", r["action"] in ai_agent.AGENT_ACTIONS, "valid", r["action"])
        check("empty text -> none", ai_agent.converse("", {})["action"]=="none",
              "none", ai_agent.converse("", {})["action"])
    finally:
        if saved is not None:
            os.environ["GEMINI_API_KEY"] = saved


# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------
def main() -> int:
    print("SteadyPT rep-counter smoke tests")
    print(f"  FPS={FPS} DEBOUNCE_FRAMES={DEBOUNCE_FRAMES} "
          f"DOWN<{DOWN_ENTER_DEG}° UP>{UP_ENTER_DEG}° "
          f"MIN_REP_SEC={MIN_REP_SEC}s")
    print("=" * 72)
    for fn in (t1_clean_deep, t2_shallow, t3_standing_still, t4_noisy_idle,
               t5_single_spurious_dip, t6_too_brief_dip, t7_impossibly_fast,
               t8_fast_but_legit, t9_source_switch_pause,
               t10_eccentric_concentric_split, t11_imu_dominated_rep_voided,
               t12_force_reset_to_up, t13_summary_structure_and_trends,
               t14_setup_no_person, t15_setup_legs_out_of_frame,
               t16_setup_front_view, t17_setup_ok,
               t18_profile_drives_thresholds, t19_depth_state_follows_profile,
               t20_set_profile_is_queued_until_reset,
               t21_ai_agent_no_key_is_silent, t22_summary_has_ai_debrief_slot,
               t23_bq_no_auth_is_silent, t24_bq_fatigue_score_mapping,
               t25_bq_next_recommendation_uses_analysis,
               t26_session_report_no_key_is_silent,
               t27_thumbs_up_detection, t28_set_score,
               t29_voice_agent_fallback):
        fn()
    print("=" * 72)
    passed = sum(results)
    total = len(results)
    print(f"OVERALL: {passed}/{total} {'ALL PASS' if passed == total else 'FAILURES'}")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(main())
