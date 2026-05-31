/**
 * poseMath.js — Pure math utilities for pose matching overlay.
 *
 * Angles, EMA smoothing, color ramp (sage → green), and ghost pose solver.
 * No React, no side effects.
 */

// ── MediaPipe landmark indices ──────────────────────────────────────
export const LM = {
  LEFT_HIP: 23,
  RIGHT_HIP: 24,
  LEFT_KNEE: 25,
  RIGHT_KNEE: 26,
  LEFT_ANKLE: 27,
  RIGHT_ANKLE: 28,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
}

// ── Vector math ─────────────────────────────────────────────────────
function vec(a, b) {
  return { x: b.x - a.x, y: b.y - a.y }
}

function dot(u, v) {
  return u.x * v.x + u.y * v.y
}

function mag(v) {
  return Math.sqrt(v.x * v.x + v.y * v.y)
}

/**
 * Angle at vertex B in triangle A-B-C, in degrees.
 */
export function angleDeg(a, b, c) {
  const ba = vec(b, a)
  const bc = vec(b, c)
  const cosAngle = dot(ba, bc) / (mag(ba) * mag(bc) + 1e-9)
  return (Math.acos(Math.max(-1, Math.min(1, cosAngle))) * 180) / Math.PI
}

/**
 * Knee angle from hip, knee, ankle landmarks.
 * Returns degrees (180 = straight, ~90 = parallel squat).
 */
export function kneeAngle(hip, knee, ankle) {
  return angleDeg(hip, knee, ankle)
}

// ── EMA smoothing ───────────────────────────────────────────────────
/**
 * Exponential moving average smoother.
 * @param {number} alpha — smoothing factor (0 = no smoothing, 1 = no memory)
 */
export function createSmoother(alpha = 0.35) {
  let prev = null
  return (value) => {
    if (prev === null) {
      prev = value
      return value
    }
    prev = alpha * value + (1 - alpha) * prev
    return prev
  }
}

/**
 * Smooth a landmark array (33 × {x, y, z, visibility}).
 * Returns a new array with smoothed x, y values.
 */
export function createLandmarkSmoother(alpha = 0.35) {
  let prevLandmarks = null
  return (landmarks) => {
    if (!prevLandmarks || prevLandmarks.length !== landmarks.length) {
      prevLandmarks = landmarks.map((lm) => ({ ...lm }))
      return landmarks
    }
    const smoothed = landmarks.map((lm, i) => {
      const p = prevLandmarks[i]
      return {
        ...lm,
        x: alpha * lm.x + (1 - alpha) * p.x,
        y: alpha * lm.y + (1 - alpha) * p.y,
      }
    })
    prevLandmarks = smoothed.map((lm) => ({ ...lm }))
    return smoothed
  }
}

// ── Color ramp ──────────────────────────────────────────────────────
const SAGE = { r: 93, g: 202, b: 165 }   // #5DCAA5
const GREEN = { r: 22, g: 181, b: 126 }  // #16B57E

/**
 * Interpolate sage → green based on match progress (0–1).
 * Returns a CSS color string.
 */
export function matchColor(progress) {
  const t = Math.max(0, Math.min(1, progress))
  const r = Math.round(SAGE.r + (GREEN.r - SAGE.r) * t)
  const g = Math.round(SAGE.g + (GREEN.g - SAGE.g) * t)
  const b = Math.round(SAGE.b + (GREEN.b - SAGE.b) * t)
  return `rgb(${r}, ${g}, ${b})`
}

/**
 * Border color with alpha based on progress.
 */
export function borderColor(progress) {
  const t = Math.max(0, Math.min(1, progress))
  const r = Math.round(SAGE.r + (GREEN.r - SAGE.r) * t)
  const g = Math.round(SAGE.g + (GREEN.g - SAGE.g) * t)
  const b = Math.round(SAGE.b + (GREEN.b - SAGE.b) * t)
  const a = 0.3 + 0.7 * t
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

// ── Match progress ──────────────────────────────────────────────────
/**
 * Compute match progress: 0 = standing, 1 = at/below target depth.
 * @param {number} currentAngle — current knee angle in degrees
 * @param {number} targetAngle — target knee angle in degrees
 * @param {number} standingAngle — "legs straight" reference (default 172)
 */
export function matchProgress(currentAngle, targetAngle, standingAngle = 172) {
  if (currentAngle >= standingAngle) return 0
  if (currentAngle <= targetAngle) return 1
  return (standingAngle - currentAngle) / (standingAngle - targetAngle)
}

// ── Ghost pose solver ───────────────────────────────────────────────
/**
 * Solve a target ghost pose given current ankle position + limb lengths.
 * Assumes sagittal-plane side view.
 *
 * @param {object} ankle — {x, y} in normalized coords
 * @param {number} shinLen — distance from ankle to knee (in normalized units)
 * @param {number} thighLen — distance from knee to hip (in normalized units)
 * @param {number} targetAngleDeg — desired knee angle in degrees
 * @returns {{hip: {x,y}, knee: {x,y}, ankle: {x,y}}}
 */
export function solveGhostPose(ankle, shinLen, thighLen, targetAngleDeg) {
  // Target angle at the knee joint
  const targetRad = (targetAngleDeg * Math.PI) / 180

  // Shin goes up from ankle (roughly vertical in side view)
  // We approximate: shin is vertical, then knee angle determines hip position
  const kneeX = ankle.x
  const kneeY = ankle.y - shinLen

  // The angle at the knee opens behind — hip is behind and above the knee
  // In a squat, the hip drops and moves back
  // Half-angle split: the thigh goes up-and-back from the knee
  const halfAngle = (Math.PI - targetRad) / 2
  // Shin angle from vertical ≈ 0 (upright shin), thigh angle from shin = pi - targetRad
  const thighAngleFromVertical = Math.PI - targetRad
  const hipX = kneeX - thighLen * Math.sin(thighAngleFromVertical) * 0.5
  const hipY = kneeY - thighLen * Math.cos(thighAngleFromVertical)

  return {
    hip: { x: hipX, y: Math.max(0, hipY) },
    knee: { x: kneeX, y: kneeY },
    ankle: { x: ankle.x, y: ankle.y },
  }
}

/**
 * Extract limb lengths from current landmarks.
 */
export function limbLengths(landmarks) {
  const hip = landmarks[LM.LEFT_HIP]
  const knee = landmarks[LM.LEFT_KNEE]
  const ankle = landmarks[LM.LEFT_ANKLE]

  const shinLen = mag(vec(ankle, knee))
  const thighLen = mag(vec(knee, hip))
  return { shinLen, thighLen }
}

/**
 * Get the "better visible" side landmarks (left or right).
 */
export function bestSideLandmarks(landmarks, minVisibility = 0.6) {
  const leftVis =
    (landmarks[LM.LEFT_HIP]?.visibility ?? 0) +
    (landmarks[LM.LEFT_KNEE]?.visibility ?? 0) +
    (landmarks[LM.LEFT_ANKLE]?.visibility ?? 0)
  const rightVis =
    (landmarks[LM.RIGHT_HIP]?.visibility ?? 0) +
    (landmarks[LM.RIGHT_KNEE]?.visibility ?? 0) +
    (landmarks[LM.RIGHT_ANKLE]?.visibility ?? 0)

  const useLeft = leftVis >= rightVis
  const hip = useLeft ? landmarks[LM.LEFT_HIP] : landmarks[LM.RIGHT_HIP]
  const knee = useLeft ? landmarks[LM.LEFT_KNEE] : landmarks[LM.RIGHT_KNEE]
  const ankle = useLeft ? landmarks[LM.LEFT_ANKLE] : landmarks[LM.RIGHT_ANKLE]
  const shoulder = useLeft ? landmarks[LM.LEFT_SHOULDER] : landmarks[LM.RIGHT_SHOULDER]

  const avgVis = ((hip?.visibility ?? 0) + (knee?.visibility ?? 0) + (ankle?.visibility ?? 0)) / 3
  const visible = avgVis >= minVisibility

  return { hip, knee, ankle, shoulder, visible, side: useLeft ? "left" : "right" }
}
