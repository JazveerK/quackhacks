/**
 * PoseMatchOverlay.jsx — SVG overlay for the camera panel.
 *
 * Renders:
 * 1. A faint ghost showing target depth (anchored to user's ankle)
 * 2. Live skeleton that fills sage → green as user descends
 * 3. Panel border that greens up at match
 * 4. Coaching chip with arrow + text
 * 5. Hold-to-confirm meter
 *
 * Source-agnostic: only needs the 33-point landmark array + target angle.
 * The SVG is aria-hidden; coaching info is in an aria-live region.
 */

import { useMemo } from "react"
import {
  matchColor,
  borderColor,
  bestSideLandmarks,
  limbLengths,
  solveGhostPose,
  LM,
} from "./poseMath"
import { usePoseMatch } from "./usePoseMatch"

// ── Skeleton connections (landmark index pairs) ─────────────────────
const SKELETON_PAIRS = [
  // Torso
  [LM.LEFT_SHOULDER, LM.LEFT_HIP],
  [LM.RIGHT_SHOULDER, LM.RIGHT_HIP],
  [LM.LEFT_SHOULDER, LM.RIGHT_SHOULDER],
  [LM.LEFT_HIP, LM.RIGHT_HIP],
  // Left leg
  [LM.LEFT_HIP, LM.LEFT_KNEE],
  [LM.LEFT_KNEE, LM.LEFT_ANKLE],
  // Right leg
  [LM.RIGHT_HIP, LM.RIGHT_KNEE],
  [LM.RIGHT_KNEE, LM.RIGHT_ANKLE],
]

function toPixel(lm, w, h, mirrored) {
  const x = mirrored ? (1 - lm.x) * w : lm.x * w
  const y = lm.y * h
  return { x, y }
}

/**
 * @param {object} props
 * @param {Array} props.landmarks — 33-point normalized landmark array
 * @param {number} props.targetDepthDeg — target knee angle in degrees
 * @param {boolean} props.mirrored — flip horizontally (default false)
 * @param {number} props.width — overlay width in px
 * @param {number} props.height — overlay height in px
 * @param {function} props.onConfirmed — called once when hold completes
 */
export default function PoseMatchOverlay({
  landmarks,
  targetDepthDeg = 95,
  mirrored = false,
  width = 640,
  height = 480,
  onConfirmed,
}) {
  const { update, state } = usePoseMatch()
  const { progress, coaching, holdPct, confirmed, visible } = state

  // Update match state every render (driven by landmark prop changes)
  useMemo(() => {
    update(landmarks, targetDepthDeg)
  }, [landmarks, targetDepthDeg, update])

  // Fire onConfirmed callback
  useMemo(() => {
    if (confirmed && onConfirmed) onConfirmed()
  }, [confirmed, onConfirmed])

  const skeletonColor = matchColor(progress)
  const border = borderColor(progress)

  // Ghost pose
  const ghost = useMemo(() => {
    if (!landmarks || landmarks.length < 33) return null
    const side = bestSideLandmarks(landmarks)
    if (!side.visible) return null
    const { shinLen, thighLen } = limbLengths(landmarks)
    const anklePos = toPixel(side.ankle, width, height, mirrored)
    const g = solveGhostPose(
      { x: anklePos.x / width, y: anklePos.y / height },
      shinLen,
      thighLen,
      targetDepthDeg
    )
    return {
      hip: { x: g.hip.x * width, y: g.hip.y * height },
      knee: { x: g.knee.x * width, y: g.knee.y * height },
      ankle: { x: g.ankle.x * width, y: g.ankle.y * height },
    }
  }, [landmarks, targetDepthDeg, width, height, mirrored])

  return (
    <>
      {/* Border glow */}
      <div
        className="absolute inset-0 rounded-lg pointer-events-none z-20 transition-all duration-300"
        style={{
          boxShadow: confirmed
            ? `inset 0 0 0 3px #16B57E`
            : progress > 0.1
              ? `inset 0 0 0 2px ${border}`
              : "none",
        }}
      />

      {/* SVG overlay */}
      <svg
        className="absolute inset-0 w-full h-full pointer-events-none z-10"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid slice"
        aria-hidden="true"
      >
        {/* Ghost target pose */}
        {ghost && !confirmed && (
          <g opacity="0.25">
            <line
              x1={ghost.ankle.x} y1={ghost.ankle.y}
              x2={ghost.knee.x} y2={ghost.knee.y}
              stroke="#5DCAA5" strokeWidth="3" strokeLinecap="round"
            />
            <line
              x1={ghost.knee.x} y1={ghost.knee.y}
              x2={ghost.hip.x} y2={ghost.hip.y}
              stroke="#5DCAA5" strokeWidth="3" strokeLinecap="round"
            />
            <circle cx={ghost.ankle.x} cy={ghost.ankle.y} r="4" fill="#5DCAA5" />
            <circle cx={ghost.knee.x} cy={ghost.knee.y} r="5" fill="#5DCAA5" />
            <circle cx={ghost.hip.x} cy={ghost.hip.y} r="5" fill="#5DCAA5" />
          </g>
        )}

        {/* Live skeleton */}
        {visible && landmarks && (
          <g>
            {SKELETON_PAIRS.map(([a, b], i) => {
              const la = landmarks[a]
              const lb = landmarks[b]
              if (!la || !lb) return null
              if ((la.visibility ?? 0) < 0.3 || (lb.visibility ?? 0) < 0.3) return null
              const pa = toPixel(la, width, height, mirrored)
              const pb = toPixel(lb, width, height, mirrored)
              return (
                <line
                  key={i}
                  x1={pa.x} y1={pa.y}
                  x2={pb.x} y2={pb.y}
                  stroke={skeletonColor}
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              )
            })}
            {/* Joint dots for key joints */}
            {[LM.LEFT_HIP, LM.RIGHT_HIP, LM.LEFT_KNEE, LM.RIGHT_KNEE, LM.LEFT_ANKLE, LM.RIGHT_ANKLE].map((idx) => {
              const lm = landmarks[idx]
              if (!lm || (lm.visibility ?? 0) < 0.3) return null
              const p = toPixel(lm, width, height, mirrored)
              return (
                <circle
                  key={idx}
                  cx={p.x} cy={p.y} r="5"
                  fill={skeletonColor}
                  stroke="white" strokeWidth="1.5"
                />
              )
            })}
          </g>
        )}

        {/* Hold-to-confirm meter (arc at bottom center) */}
        {holdPct > 0 && !confirmed && (
          <g>
            <circle
              cx={width / 2} cy={height - 50}
              r="20"
              fill="none"
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="4"
            />
            <circle
              cx={width / 2} cy={height - 50}
              r="20"
              fill="none"
              stroke="#16B57E"
              strokeWidth="4"
              strokeDasharray={`${holdPct * 126} 126`}
              strokeLinecap="round"
              transform={`rotate(-90 ${width / 2} ${height - 50})`}
            />
            <text
              x={width / 2} y={height - 45}
              textAnchor="middle"
              fill="white"
              fontSize="12"
              fontWeight="600"
            >
              {Math.round(holdPct * 100)}%
            </text>
          </g>
        )}

        {/* Confirmed checkmark */}
        {confirmed && (
          <g>
            <circle
              cx={width / 2} cy={height - 50}
              r="20"
              fill="#16B57E"
            />
            <path
              d={`M ${width/2 - 8} ${height - 50} l 6 6 l 10 -12`}
              fill="none"
              stroke="white"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </g>
        )}
      </svg>

      {/* Coaching chip (aria-live for accessibility) */}
      <div
        className="absolute top-14 left-1/2 -translate-x-1/2 z-30"
        role="status"
        aria-live="polite"
      >
        <div
          className={`inline-flex items-center gap-2 px-4 py-2 rounded-full text-[15px] font-medium shadow-lg backdrop-blur-sm transition-colors duration-300 ${
            confirmed
              ? "bg-[#16B57E]/90 text-white"
              : "bg-black/60 text-white"
          }`}
        >
          {!confirmed && progress < 0.5 && (
            <i className="ti ti-arrow-down text-[16px]" />
          )}
          {!confirmed && progress >= 0.5 && progress < 1 && (
            <i className="ti ti-arrow-down text-[16px]" />
          )}
          {confirmed && (
            <i className="ti ti-check text-[16px]" />
          )}
          {coaching}
          {visible && !confirmed && (
            <span className="text-[13px] text-white/70 ml-1">
              {state.angle}°
            </span>
          )}
        </div>
      </div>

      {/* Depth progress meter (right edge) */}
      {visible && !confirmed && (
        <div className="absolute right-3 top-1/4 bottom-1/4 w-2 rounded-full bg-white/10 z-20 overflow-hidden">
          <div
            className="absolute bottom-0 left-0 right-0 rounded-full transition-all duration-150"
            style={{
              height: `${progress * 100}%`,
              backgroundColor: skeletonColor,
            }}
          />
          {/* Target line */}
          <div
            className="absolute left-0 right-0 h-0.5 bg-white/40"
            style={{ bottom: "100%" }}
          />
        </div>
      )}
    </>
  )
}
