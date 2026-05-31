/**
 * usePoseMatch.js — Landmarks + target → match state + hold-to-confirm machine.
 *
 * Takes a 33-point landmark array and a target depth angle,
 * returns match progress, coaching text, and hold confirmation state.
 */

import { useState, useRef, useCallback, useEffect } from "react"
import {
  kneeAngle,
  matchProgress,
  bestSideLandmarks,
  createSmoother,
} from "./poseMath"

const DEFAULT_OPTS = {
  holdMs: 1200,          // ms to hold at target to confirm
  standingAngle: 172,    // "legs straight" reference
  minVisibility: 0.6,    // min avg landmark visibility
  exitAngle: 15,         // degrees above target to reset hold
}

/**
 * @param {object} opts — tuning knobs (see DEFAULT_OPTS)
 * @returns {object} { update, state }
 *   - update(landmarks, targetDepthDeg): call per frame
 *   - state: { progress, angle, coaching, holdPct, confirmed, visible }
 */
export function usePoseMatch(opts = {}) {
  const cfg = { ...DEFAULT_OPTS, ...opts }

  const [state, setState] = useState({
    progress: 0,
    angle: 180,
    coaching: "Stand in frame",
    holdPct: 0,
    confirmed: false,
    visible: false,
  })

  const holdStart = useRef(null)
  const smoother = useRef(createSmoother(0.35))
  const confirmedRef = useRef(false)

  const update = useCallback(
    (landmarks, targetDepthDeg) => {
      if (!landmarks || landmarks.length < 33) {
        setState((s) => ({
          ...s,
          visible: false,
          coaching: "Stand in frame",
          progress: 0,
          holdPct: 0,
        }))
        holdStart.current = null
        return
      }

      const side = bestSideLandmarks(landmarks, cfg.minVisibility)
      if (!side.visible) {
        setState((s) => ({
          ...s,
          visible: false,
          coaching: "Move so your full body is visible",
          progress: 0,
          holdPct: 0,
        }))
        holdStart.current = null
        return
      }

      const rawAngle = kneeAngle(side.hip, side.knee, side.ankle)
      const angle = smoother.current(rawAngle)
      const progress = matchProgress(angle, targetDepthDeg, cfg.standingAngle)

      // Hold-to-confirm state machine
      let holdPct = 0
      let confirmed = confirmedRef.current

      if (!confirmed) {
        if (angle <= targetDepthDeg + 3) {
          // At or below target — accumulate hold
          if (holdStart.current === null) {
            holdStart.current = Date.now()
          }
          const elapsed = Date.now() - holdStart.current
          holdPct = Math.min(1, elapsed / cfg.holdMs)

          if (holdPct >= 1) {
            confirmed = true
            confirmedRef.current = true
          }
        } else if (angle > targetDepthDeg + cfg.exitAngle) {
          // Too far above — reset hold
          holdStart.current = null
          holdPct = 0
        } else if (holdStart.current !== null) {
          // In the buffer zone — keep hold but don't accumulate
          const elapsed = Date.now() - holdStart.current
          holdPct = Math.min(1, elapsed / cfg.holdMs)
        }
      }

      // Coaching text
      let coaching
      if (confirmed) {
        coaching = "Depth confirmed — ready to go"
      } else if (angle > cfg.standingAngle - 5) {
        coaching = "Start squatting down"
      } else if (angle > targetDepthDeg + 20) {
        coaching = "Keep going lower"
      } else if (angle > targetDepthDeg + 3) {
        coaching = "Almost there — a little deeper"
      } else {
        coaching = holdPct < 1 ? "Hold it right there…" : "Depth confirmed"
      }

      setState({
        progress,
        angle: Math.round(angle),
        coaching,
        holdPct,
        confirmed,
        visible: true,
      })
    },
    [cfg.holdMs, cfg.standingAngle, cfg.minVisibility, cfg.exitAngle]
  )

  const reset = useCallback(() => {
    confirmedRef.current = false
    holdStart.current = null
    setState({
      progress: 0,
      angle: 180,
      coaching: "Stand in frame",
      holdPct: 0,
      confirmed: false,
      visible: false,
    })
  }, [])

  return { update, state, reset }
}
