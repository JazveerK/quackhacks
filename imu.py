"""
imu.py — real MPU6050 IMU interface for SteadyPT (replaces MockIMU on hardware).

Reads the Arduino serial stream and exposes the single interface the rest of the
app expects (CONTEXT.md §4b):

    imu.get_latest() -> {"tilt", "ang_vel", "smoothness", "t", "quality"} | None

Wire format (one CSV line per sample, ~50-100 Hz, 115200 baud, CONTEXT.md §4a):

    ax,ay,az,gx,gy,gz,t

    ax,ay,az : accelerometer, in g
    gx,gy,gz : gyroscope, in deg/s
    t        : Arduino millis() timestamp

Derived signals (see the EQUATION REFERENCE in the task):
  - dt          from the millis timestamps (§1)
  - gyro bias   averaged over ~100 still samples at startup, subtracted after (§4)
  - accel tilt  via atan2 on the thigh axis (§2)
  - tilt        complementary filter, alpha ~0.97 (§5) — the IMU standalone angle
  - ang_vel     angular-velocity magnitude (§6)
  - smoothness  from mean absolute jerk (§6), mapped to [0,1]
  - quality     [0,1] confidence: 1.0 on fresh samples, decaying if the stream stalls

The reader runs on a background daemon thread and is resilient: a missing or
unplugged port never raises out of the constructor or get_latest(); it just
reports low quality while the thread retries the connection. MockIMU (defined in
pose_tracker.py and re-exported here) stays the no-hardware fallback.

Typical usage
-------------
    from imu import IMU, find_imu_port
    imu = IMU(port=find_imu_port())   # or IMU(port="/dev/cu.usbmodem13401")
    sample = imu.get_latest()         # never blocks, never raises
"""

import math
import threading
import time
from collections import deque

try:
    import serial
    from serial.tools import list_ports
    _HAVE_SERIAL = True
except ImportError:  # pyserial not installed — find_imu_port() / MockIMU still work
    serial = None
    list_ports = None
    _HAVE_SERIAL = False

# MockIMU lives in pose_tracker (the no-hardware fallback). Re-export it here so
# callers can do `from imu import IMU, MockIMU` without caring where it's defined.
try:
    from pose_tracker import MockIMU  # noqa: F401
except Exception:  # avoid a hard import cycle if pose_tracker isn't importable
    MockIMU = None  # type: ignore

# ---------------------------------------------------------------------------
# Hardware-orientation constants. The MPU6050 is mounted on the mid-thigh; which
# physical axis points "up" the thigh (and which spins as the knee bends) depends
# on how the board is taped on. These are isolated up top so they're a one-line
# flip after a quick test on a real leg — NO other code needs to change.
# ---------------------------------------------------------------------------
TILT_AXIS = "y"        # accel axis aligned with the thigh when standing ("x"|"y"|"z")
GYRO_AXIS = "x"        # gyro axis whose rotation changes the thigh tilt ("x"|"y"|"z")
GYRO_SIGN = 1.0        # flip to -1.0 if the gyro integrates tilt the wrong way

# Filter / signal tuning.
COMP_ALPHA = 0.97      # complementary-filter weight on the gyro (§5)
CALIBRATION_SAMPLES = 100   # still samples averaged for the startup gyro bias (§4)
STILL_GYRO_THRESHOLD = 8.0  # |gyro| (deg/s) below which a sample counts as "still"
JERK_WINDOW = 12       # samples in the rolling mean-absolute-jerk window
JERK_SCALE = 40.0      # mean |jerk| (g/s) that maps to ~0.37 smoothness (exp decay)
STALL_SEC = 0.5        # no fresh sample for this long -> quality decays to 0
NOMINAL_DT = 0.02      # fallback dt (~50 Hz) when the millis delta looks bad


def find_imu_port():
    """Return the most likely Arduino serial device, or None if none is found.

    Matches the usual USB-serial names across macOS/Linux. The first match wins;
    set PF_IMU_PORT explicitly if several boards are plugged in.
    """
    if not _HAVE_SERIAL:
        return None
    candidates = []
    for p in list_ports.comports():
        dev = (p.device or "")
        name = f"{dev} {p.description or ''} {p.manufacturer or ''}".lower()
        if any(tok in dev for tok in ("usbmodem", "usbserial", "ttyACM", "ttyUSB", "wchusbserial")):
            candidates.append(dev)
        elif any(tok in name for tok in ("arduino", "ch340", "cp210", "mpu", "usb serial")):
            candidates.append(dev)
    return candidates[0] if candidates else None


def _accel_tilt_deg(ax, ay, az):
    """Thigh tilt from gravity via atan2 (§2): ~0 standing, ~90 thigh horizontal.

    The chosen axis aligns with gravity when standing (tilt 0) and is
    perpendicular to gravity when the thigh is horizontal (tilt 90).
    """
    if TILT_AXIS == "x":
        return math.degrees(math.atan2(math.sqrt(ay * ay + az * az), ax))
    if TILT_AXIS == "z":
        return math.degrees(math.atan2(math.sqrt(ax * ax + ay * ay), az))
    # default "y"
    return math.degrees(math.atan2(math.sqrt(ax * ax + az * az), ay))


def _pick_gyro(gx, gy, gz):
    """The single bias-corrected gyro component that drives the tilt integration."""
    if GYRO_AXIS == "y":
        return gy
    if GYRO_AXIS == "z":
        return gz
    return gx


class IMU:
    """Threaded MPU6050 reader exposing the §4b ``get_latest()`` interface.

    Parameters
    ----------
    port : str | None
        Serial device, e.g. '/dev/cu.usbmodem13401'. If None, the reader idles
        and ``get_latest()`` returns None until a port is set / found.
    baud : int
        Must match the firmware (default 115200).
    """

    def __init__(self, port, baud=115200, alpha=COMP_ALPHA,
                 calibration_samples=CALIBRATION_SAMPLES):
        self.port = port
        self.baud = baud
        self.alpha = alpha
        self.calibration_samples = calibration_samples

        self._lock = threading.Lock()
        self._latest = None             # last snapshot dict (§4b), or None pre-data
        self._t0 = time.time()          # host time origin for the "t" field
        self._last_rx = 0.0             # host time of the last parsed sample
        self._gyro_bias = (0.0, 0.0, 0.0)
        self._calibrated = False
        self._tilt = 0.0                # complementary-filter state
        self._accel_hist = deque(maxlen=JERK_WINDOW)  # (t_host, accel_vec) for jerk

        self._running = True
        self._thread = threading.Thread(target=self._read_loop, name="IMU", daemon=True)
        self._thread.start()

    # ------------------------------------------------------------------ #
    # Public API (§4b)
    # ------------------------------------------------------------------ #
    def get_latest(self):
        """Latest sample dict, or None if no data yet. Never blocks/raises.

        Returns {"tilt", "ang_vel", "smoothness", "t", "quality"}. The "quality"
        field is recomputed on read so it decays as the stream goes stale even if
        no new sample has arrived.
        """
        with self._lock:
            if self._latest is None:
                return None
            snap = dict(self._latest)
            last_rx = self._last_rx
        # Quality decays with time since the last fresh sample.
        stale = time.time() - last_rx
        snap["quality"] = max(0.0, min(1.0, 1.0 - stale / STALL_SEC))
        return snap

    def close(self):
        self._running = False
        if self._thread.is_alive():
            self._thread.join(timeout=2.0)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()

    # ------------------------------------------------------------------ #
    # Background thread
    # ------------------------------------------------------------------ #
    def _read_loop(self):
        if not _HAVE_SERIAL:
            print("[IMU] pyserial not installed; no hardware reads (use MockIMU).")
            return
        ser = None
        last_ms = None
        while self._running:
            if ser is None:
                if not self.port:
                    time.sleep(0.5)
                    continue
                try:
                    ser = serial.Serial(self.port, self.baud, timeout=1)
                    time.sleep(2.0)            # Arduino auto-resets on connect
                    ser.reset_input_buffer()
                    self._calibrate(ser)
                    last_ms = None
                except (serial.SerialException, OSError) as e:
                    print(f"[IMU] connect failed on {self.port}: {e}; retrying...")
                    ser = None
                    time.sleep(1.0)
                    continue

            try:
                raw = ser.readline()
            except (serial.SerialException, OSError):
                self._handle_disconnect(ser)
                ser = None
                last_ms = None
                continue

            sample = _parse_line(raw)
            if sample is None:
                continue
            ax, ay, az, gx, gy, gz, ms = sample

            # dt from the Arduino clock (§1); fall back to nominal on wrap/drops.
            if last_ms is not None:
                dt = (ms - last_ms) / 1000.0
                if dt <= 0.0 or dt > 0.5:
                    dt = NOMINAL_DT
            else:
                dt = NOMINAL_DT
            last_ms = ms

            self._update(ax, ay, az, gx, gy, gz, dt)

    def _calibrate(self, ser):
        """Average ~N still samples to estimate gyro bias, then subtract it (§4)."""
        print("[IMU] Calibrating gyro bias — hold the sensor still...")
        sums = [0.0, 0.0, 0.0]
        count = 0
        deadline = time.time() + 10.0
        while count < self.calibration_samples and time.time() < deadline:
            if not self._running:
                return
            sample = _parse_line(ser.readline())
            if sample is None:
                continue
            _, _, _, gx, gy, gz, _ = sample
            if math.sqrt(gx * gx + gy * gy + gz * gz) > STILL_GYRO_THRESHOLD:
                continue  # moved during calibration — skip
            sums[0] += gx
            sums[1] += gy
            sums[2] += gz
            count += 1
        bias = tuple(s / count for s in sums) if count else (0.0, 0.0, 0.0)
        with self._lock:
            self._gyro_bias = bias
            self._calibrated = True
            self._tilt = 0.0
        if count:
            print(f"[IMU] Calibrated on {count} samples. Bias (deg/s): "
                  f"[{bias[0]:.3f}, {bias[1]:.3f}, {bias[2]:.3f}]")
        else:
            print("[IMU] Warning: no still samples seen; using zero bias.")

    def _update(self, ax, ay, az, gx, gy, gz, dt):
        """One filter step: complementary tilt, ang_vel, smoothness (§5, §6)."""
        with self._lock:
            bx, by, bz = self._gyro_bias
            tilt = self._tilt

        gx_c, gy_c, gz_c = gx - bx, gy - by, gz - bz

        # Accel tilt (absolute reference) + gyro integration -> complementary (§5).
        accel_tilt = _accel_tilt_deg(ax, ay, az)
        gyro_rate = GYRO_SIGN * _pick_gyro(gx_c, gy_c, gz_c)
        tilt = self.alpha * (tilt + gyro_rate * dt) + (1.0 - self.alpha) * accel_tilt

        # Angular-velocity magnitude (§6).
        ang_vel = math.sqrt(gx_c * gx_c + gy_c * gy_c + gz_c * gz_c)

        # Smoothness from mean absolute jerk = d(accel)/dt over a rolling window (§6).
        now = time.time()
        self._accel_hist.append((now, (ax, ay, az)))
        smoothness = self._smoothness()

        snap = {
            "tilt": tilt,
            "ang_vel": ang_vel,
            "smoothness": smoothness,
            "t": now - self._t0,
            "quality": 1.0,   # recomputed (decayed) on read in get_latest()
        }
        with self._lock:
            self._tilt = tilt
            self._latest = snap
            self._last_rx = now

    def _smoothness(self):
        """Map mean absolute jerk over the window to a [0,1] smoothness score."""
        hist = self._accel_hist
        if len(hist) < 3:
            return 1.0
        jerks = []
        for (t0, a0), (t1, a1) in zip(hist, list(hist)[1:]):
            ddt = t1 - t0
            if ddt <= 0:
                continue
            da = math.sqrt(sum((a1[i] - a0[i]) ** 2 for i in range(3)))
            jerks.append(da / ddt)
        if not jerks:
            return 1.0
        mean_jerk = sum(jerks) / len(jerks)
        # Smooth motion -> mean_jerk ~ 0 -> smoothness ~ 1; jerky -> decays to 0.
        return math.exp(-mean_jerk / JERK_SCALE)

    def _handle_disconnect(self, ser):
        try:
            ser.close()
        except Exception:
            pass
        with self._lock:
            self._calibrated = False
        print("[IMU] Serial disconnected; will retry...")
        time.sleep(1.0)


def _parse_line(raw):
    """Decode one serial line into 7 floats, or None if it isn't a valid sample."""
    try:
        line = raw.decode("utf-8", errors="ignore").strip()
    except Exception:
        return None
    if not line:
        return None
    parts = line.split(",")
    if len(parts) != 7:
        return None
    try:
        vals = [float(p) for p in parts]
    except ValueError:
        return None  # header row / partial line / noise
    if not all(math.isfinite(v) for v in vals):
        return None
    return vals


# Backward-compatible alias (older notes referenced IMUReader).
IMUReader = IMU


if __name__ == "__main__":
    # Quick manual check: stream live samples if hardware is present.
    port = find_imu_port()
    print(f"find_imu_port() -> {port!r}")
    if not port:
        print("No IMU port found; nothing to stream.")
    else:
        with IMU(port=port) as imu:
            for _ in range(200):
                time.sleep(0.1)
                print(imu.get_latest())
