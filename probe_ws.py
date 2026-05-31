"""
Live end-to-end probe for the rep counter.

Connects to the running server's /ws, forces a set to START (button path,
bypasses framing gates), then prints one compact line per state frame so we can
see EXACTLY what the backend reports while you squat:

    phase  src     angle  depth     reps  vis   setup

If reps never increments while `depth` reaches "parallel"/"deep", the counter
logic is at fault. If depth never leaves "shallow", the angle/camera path is at
fault. If setup is non-ok, framing/guard is blocking.

Run (server must already be running):
    .venv/bin/python probe_ws.py
Then do ~3 slow, deep squats during the 30s window.
"""
import asyncio, json, sys, time
import websockets

URL = "ws://127.0.0.1:8000/ws"
DURATION = 30.0


async def main():
    try:
        ws = await websockets.connect(URL, max_size=None)
    except Exception as e:
        print(f"[probe] could not connect to {URL}: {e}")
        print("[probe] is the server running? (.venv/bin/python run.py)")
        sys.exit(1)

    print(f"[probe] connected. forcing start_set; squat now for ~{int(DURATION)}s\n")
    await ws.send(json.dumps({"cmd": "start_set"}))

    t_end = time.time() + DURATION
    last = None
    max_reps = 0
    seen_depths = set()
    seen_phases = set()
    print(f"{'phase':<16} {'src':<7} {'angle':>6} {'depth':<9} {'reps':>4} {'vis':>5}  setup")
    print("-" * 70)
    while time.time() < t_end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=2.0)
        except asyncio.TimeoutError:
            print("[probe] (no message in 2s — is the camera delivering frames?)")
            continue
        msg = json.loads(raw)
        if msg.get("type") != "state":
            continue
        s = msg["state"]
        phase = s.get("phase")
        src = s.get("tracking_source")
        angle = s.get("angle")
        depth = s.get("depth_state")
        reps = s.get("rep_count")
        vis = s.get("landmark_visibility")
        setup = (s.get("setup_status") or {}).get("code")
        max_reps = max(max_reps, reps or 0)
        seen_depths.add(depth)
        seen_phases.add(phase)
        line = f"{phase:<16} {str(src):<7} {str(angle):>6} {str(depth):<9} {str(reps):>4} {str(vis):>5}  {setup}"
        if line != last:        # only print on change — keeps it readable
            print(line)
            last = line
    await ws.close()

    print("\n" + "=" * 70)
    print(f"[probe] DONE. max reps counted: {max_reps}")
    print(f"[probe] phases seen:  {sorted(p for p in seen_phases if p)}")
    print(f"[probe] depths seen:  {sorted(d for d in seen_depths if d)}")
    if max_reps == 0:
        if "SET_ACTIVE" not in seen_phases:
            print("[probe] DIAGNOSIS: set never went SET_ACTIVE — start/lifecycle gate.")
        elif seen_depths <= {"shallow", None}:
            print("[probe] DIAGNOSIS: depth never passed 'shallow' — angle/camera path "
                  "(knee angle not reaching parallel). Check camera can see your full "
                  "side profile, or the depth threshold.")
        else:
            print("[probe] DIAGNOSIS: reached depth but no rep — counter gate / debounce.")
    else:
        print("[probe] reps counted fine over the wire — if the UI shows 0, it's a "
              "frontend display bug, not the tracker.")


if __name__ == "__main__":
    asyncio.run(main())
