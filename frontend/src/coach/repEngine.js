/**
 * repEngine.js — Client-side squat rep counter + set scorer.
 *
 * A JS port of the core of pose_tracker.py (RepCounter + PoseTracker._compute_score)
 * so live tracking can run entirely in the browser — no Python server, no webcam
 * on the server. Feed it a smoothed knee angle per frame; it counts reps with
 * hysteresis + a depth gate, records per-rep depth/tempo, and scores the set.
 *
 * Squat = a "min" exercise: a good rep drives the knee angle DOWN (toward the
 * target), then back UP to standing.
 */

const DEBOUNCE_FRAMES = 3
const TRIGGER_DEG = 150      // cross below => descending
const RETURN_DEG = 156       // cross back above => rep complete / standing
const STANDING_DEG = 162     // at/above this counts as "at rest"
const FAST_REP_SEC = 1.2     // faster than this => too_fast flag
const MIN_REP_SEC = 0.5      // faster than this is noise — void it
const MAX_REP_SEC = 15.0

export class RepEngine {
  constructor({ targetDepthDeg = 95, repTarget = 10, parallelBufferDeg = 10, countMarginDeg = 25 } = {}) {
    this.targetDepthDeg = targetDepthDeg
    this.repTarget = repTarget
    this.parallelDeg = targetDepthDeg + parallelBufferDeg          // edge of "good depth"
    this.countDepthDeg = this.parallelDeg + countMarginDeg         // must pass this to count
    this.reset()
  }

  reset() {
    this.phase = "up"            // "up" | "down"
    this.repCount = 0
    this.repDepths = []          // deepest (min) knee angle per rep
    this.repTempos = []          // seconds per rep
    this.repFlags = []           // per-rep flag arrays
    this.romMin = 180
    this.romMax = 0
    this._minThisRep = 180
    this._startT = 0
    this._tLastStanding = 0
    this._downStreak = 0
    this._upStreak = 0
    this.lastVoidReason = null
  }

  setConfig({ targetDepthDeg, repTarget }) {
    if (targetDepthDeg != null) {
      this.targetDepthDeg = targetDepthDeg
      this.parallelDeg = targetDepthDeg + 10
      this.countDepthDeg = this.parallelDeg + 25
    }
    if (repTarget != null) this.repTarget = repTarget
  }

  /**
   * Feed one frame. `angle` = smoothed knee angle (deg). `now` = seconds.
   * Returns { repCompleted, flags } for this frame.
   */
  update(angle, now) {
    this.romMin = Math.min(this.romMin, angle)
    this.romMax = Math.max(this.romMax, angle)
    let repCompleted = false
    let flags = []

    if (angle >= STANDING_DEG) this._tLastStanding = now

    if (this.phase === "up") {
      if (angle < TRIGGER_DEG && this._tLastStanding > 0) this._downStreak++
      else this._downStreak = 0
      if (this._downStreak >= DEBOUNCE_FRAMES) {
        this.phase = "down"
        this._startT = this._tLastStanding > 0 ? this._tLastStanding : now
        this._minThisRep = angle
        this._downStreak = 0
        this._upStreak = 0
      }
    } else {
      // descending / bottom
      if (angle < this._minThisRep) this._minThisRep = angle
      if (angle > RETURN_DEG) this._upStreak++
      else this._upStreak = 0
      if (this._upStreak >= DEBOUNCE_FRAMES) {
        const depth = this._minThisRep
        const tempo = now - this._startT
        const valid =
          tempo >= MIN_REP_SEC && tempo <= MAX_REP_SEC && depth <= this.countDepthDeg
        if (valid) {
          this.repCount++
          this.repDepths.push(Math.round(depth * 10) / 10)
          this.repTempos.push(Math.round(tempo * 100) / 100)
          if (depth > this.parallelDeg) flags.push("shallow")
          if (tempo < FAST_REP_SEC) flags.push("too_fast")
          this.repFlags.push(flags)
          repCompleted = true
        } else {
          this.lastVoidReason = depth > this.countDepthDeg ? "shallow" : "too_fast"
        }
        this.phase = "up"
        this._minThisRep = 180
        this._downStreak = 0
        this._upStreak = 0
      }
    }
    return { repCompleted, flags }
  }

  depthState(angle) {
    if (angle <= this.targetDepthDeg) return "below_parallel"
    if (angle <= this.parallelDeg) return "at_parallel"
    return "shallow"
  }

  // ── Set scoring — ported from PoseTracker._compute_score ──────────────
  score() {
    const depths = this.repDepths
    if (!depths.length) {
      return {
        overall: 0, grade: "—",
        components: { depth: 0, consistency: 0, tempo: 0, completion: 0 },
        headline: "No valid reps tracked.",
      }
    }
    const n = depths.length
    const mean = depths.reduce((a, b) => a + b, 0) / n
    const std =
      n < 2 ? 0 : Math.sqrt(depths.reduce((a, d) => a + (d - mean) ** 2, 0) / (n - 1))
    const hitRate = depths.filter((d) => d <= this.targetDepthDeg).length / n
    const fastCount = this.repTempos.filter((t) => t < FAST_REP_SEC).length

    const over = Math.max(0, mean - this.targetDepthDeg)
    const closeness = Math.max(0, 1 - over / 25)
    const depth01 = 0.6 * hitRate + 0.4 * closeness
    const consistency01 = Math.max(0, 1 - std / 15)
    const tempo01 = Math.max(0, 1 - fastCount / n)
    const completion01 = this.repTarget ? Math.min(1, n / this.repTarget) : 1

    let overall = Math.round(
      100 * (0.4 * depth01 + 0.2 * consistency01 + 0.2 * tempo01 + 0.2 * completion01)
    )
    overall = Math.max(0, Math.min(100, overall))
    const grade =
      overall >= 90 ? "A" : overall >= 80 ? "B" : overall >= 70 ? "C" : overall >= 60 ? "D" : "F"
    let headline
    if (overall >= 90) headline = "Excellent set — depth, control, and consistency all on point."
    else if (overall >= 80) headline = "Strong set with solid depth and control."
    else if (overall >= 70) headline = "Good work — a few reps to clean up."
    else if (overall >= 60) headline = "Fair set — depth or control slipped on several reps."
    else headline = "Tough set — focus on hitting depth with control next time."

    return {
      overall, grade,
      components: {
        depth: Math.round(depth01 * 100),
        consistency: Math.round(consistency01 * 100),
        tempo: Math.round(tempo01 * 100),
        completion: Math.round(completion01 * 100),
      },
      headline,
      mean: Math.round(mean * 10) / 10,
      std: Math.round(std * 10) / 10,
      hitRate: Math.round(hitRate * 100) / 100,
    }
  }
}
