"""
Headless smoke test for squat rep counting.

Drives SquatCounter with a synthetic knee-angle waveform (no camera / MediaPipe)
so we can verify reps count correctly and that the depth gate behaves. Run:

    .venv/bin/python smoke_reps.py
"""
from __future__ import annotations

from pose_tracker import (
    SquatCounter,
    DOWN_ENTER_DEG,
    UP_ENTER_DEG,
)

FPS = 30.0
DT = 1.0 / FPS


def feed_squat(counter: SquatCounter, t0: float, bottom_deg: float,
               descent_s: float = 1.2, hold_s: float = 0.2,
               ascent_s: float = 1.2, top_deg: float = 172.0) -> float:
    """Feed one full squat (top -> bottom -> top) frame by frame.

    Returns the clock time after the rep completes (plus a few standing frames).
    """
    t = t0
    # A few standing frames first so 'up' phase is established / t_last_standing set.
    for _ in range(3):
        counter.update(top_deg, t, source="camera")
        t += DT
    # Descent.
    n = max(1, int(descent_s * FPS))
    for i in range(n):
        ang = top_deg + (bottom_deg - top_deg) * (i + 1) / n
        counter.update(ang, t, source="camera")
        t += DT
    # Hold at bottom.
    for _ in range(max(1, int(hold_s * FPS))):
        counter.update(bottom_deg, t, source="camera")
        t += DT
    # Ascent.
    n = max(1, int(ascent_s * FPS))
    for i in range(n):
        ang = bottom_deg + (top_deg - bottom_deg) * (i + 1) / n
        counter.update(ang, t, source="camera")
        t += DT
    # Stand still a moment.
    for _ in range(5):
        counter.update(top_deg, t, source="camera")
        t += DT
    return t


def run_case(name: str, bottoms: list[float], **kw) -> tuple[int, list[float]]:
    c = SquatCounter()
    t = 0.0
    for b in bottoms:
        t = feed_squat(c, t, b, **kw)
    print(f"  {name}: rep_count={c.rep_count}  voided={c.voided_reps}  "
          f"depths={[round(d) for d in c.rep_depths]}")
    return c.rep_count, c.rep_depths


def main() -> int:
    print(f"thresholds: DOWN_ENTER={DOWN_ENTER_DEG}  UP_ENTER={UP_ENTER_DEG}")
    ok = True

    # 1) Three good deep squats -> should count 3.
    n, _ = run_case("3 deep squats (bottom 90)", [90, 92, 95])
    if n != 3:
        print(f"    !! expected 3, got {n}"); ok = False

    # 2) A clearly deep squat -> counts.
    n, _ = run_case("1 deep squat (bottom 85)", [85])
    if n != 1:
        print(f"    !! expected 1, got {n}"); ok = False

    # 3) Tiny bobs that barely dip below DOWN_ENTER (113) -> must NOT count: they
    #    don't reach squat depth. (Pre-gate this counted 3 — that was the bug.)
    n, depths = run_case("3 shallow bobs (bottom 113)", [113, 113, 113])
    if n != 0:
        print(f"    !! shallow bobs should not count; got {n}"); ok = False

    # 4) Mixed: 2 deep + 1 shallow bob -> want exactly 2, and rep_count must
    #    equal the number of recorded depths (no desync).
    n, depths = run_case("2 deep + 1 shallow", [90, 113, 92])
    if n != 2 or len(depths) != n:
        print(f"    !! expected 2 with matching depths; got {n}, depths={len(depths)}")
        ok = False

    # 5) A partial-but-real squat just inside the gate (bottom 108) -> counts.
    n, _ = run_case("1 partial squat (bottom 108)", [108])
    if n != 1:
        print(f"    !! expected 1, got {n}"); ok = False

    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
