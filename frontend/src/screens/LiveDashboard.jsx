import { useRef } from "react"
import { useMockSession } from "../mockSession"
import AppHeader from "../components/AppHeader"
import GhostButton from "../components/GhostButton"
import CameraPanel from "../components/CameraPanel"
import RepCounter from "../components/RepCounter"
import DepthGauge from "../components/DepthGauge"
import TrackingSource from "../components/TrackingSource"
import Pill from "../components/Pill"

const CUES = [
  "Good depth — control the way up",
  "Nice control — three more",
  "Take your time on the way down",
  "Good — last one",
  "Steady through the bottom",
]

export default function LiveDashboard({ setScreen }) {
  const { state } = useMockSession()
  const lastRepRef = useRef(0)
  const cueIndexRef = useRef(0)

  if (!state) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-soft text-sm">
        Connecting…
      </div>
    )
  }

  // Advance cue when rep_count increments
  if (state.rep_count > lastRepRef.current && state.rep_count > 0) {
    cueIndexRef.current = (state.rep_count - 1) % CUES.length
    lastRepRef.current = state.rep_count
  }
  const cue = state.rep_count > 0 ? CUES[cueIndexRef.current] : null

  const angle = state.angle ?? 180
  const target = state.personal_target_depth_deg ?? 95
  const tempo = state.tempo ?? 0
  const imuQ = state.imu_quality ?? 0
  const vis = state.landmark_visibility ?? 0

  // Depth status
  let depthLabel, depthVariant
  if (angle <= target + 5) {
    depthLabel = "At target"
    depthVariant = "ok"
  } else if (angle <= target + 20) {
    depthLabel = "Approaching"
    depthVariant = "warn"
  } else {
    depthLabel = "Above target"
    depthVariant = "brand"
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <AppHeader
        context={["Bodyweight squat", "Set 2 of 3"]}
        phase="Set active"
        phaseColor="green"
      >
        <GhostButton onClick={() => setScreen("debrief")}>
          <i className="ti ti-player-stop text-sm" />
          End set
        </GhostButton>
      </AppHeader>

      {/* 3-column grid */}
      <div className="flex-1 grid grid-cols-[3fr_1.25fr_0.75fr] gap-3 p-3 min-h-0">
        {/* Camera (60%) */}
        <CameraPanel frame={null} />

        {/* Metrics (25%) */}
        <div className="flex flex-col gap-3 min-h-0 overflow-y-auto">
          <RepCounter state={state} />

          {/* Knee depth — inline version with arc gauge */}
          <div className="bg-white rounded-lg border border-hair p-4">
            <div className="text-[10px] text-ink-faint tracking-wide mb-1">Knee depth</div>
            <div className="flex items-center gap-2 mb-2">
              <span className="text-[26px] font-medium text-ink tabular-nums leading-none">
                {Math.round(angle)}°
              </span>
              <Pill variant={depthVariant}>{depthLabel}</Pill>
            </div>
            <DepthArc angle={angle} target={target} depthVariant={depthVariant} />
          </div>

          {/* Descent tempo */}
          <div className="bg-white rounded-lg border border-hair p-4">
            <div className="text-[10px] text-ink-faint tracking-wide mb-1">Descent tempo</div>
            <span className="text-[26px] font-medium text-ink tabular-nums leading-none">
              {tempo > 0 ? tempo.toFixed(1) : "--"}
              <span className="text-sm font-normal text-ink-soft ml-1">s</span>
            </span>
            <div className="text-[11px] text-ink-faint mt-1">
              Steady · within range
            </div>
          </div>
        </div>

        {/* Sidebar — fusion (15%) */}
        <div className="flex flex-col gap-3 min-h-0 overflow-y-auto">
          <TrackingSource state={state} />

          {/* IMU quality */}
          <div className="bg-white rounded-lg border border-hair p-4">
            <div className="text-[10px] text-ink-faint tracking-wide mb-1">IMU quality</div>
            <span className="text-lg font-medium text-ink tabular-nums">
              {Math.round(imuQ * 100)}%
            </span>
          </div>

          {/* Visibility */}
          <div className="bg-white rounded-lg border border-hair p-4">
            <div className="text-[10px] text-ink-faint tracking-wide mb-1">Visibility</div>
            <span className={`text-lg font-medium tabular-nums ${vis < 0.5 ? "text-warn" : "text-ink"}`}>
              {Math.round(vis * 100)}%
            </span>
          </div>
        </div>
      </div>

      {/* Form-cue banner */}
      {cue && (
        <div className="shrink-0 bg-surface border-t border-hair px-5 py-2.5 flex items-center gap-2.5">
          <i className="ti ti-volume text-ink-faint text-base" />
          <span className="text-sm text-ink-soft">&ldquo;{cue}&rdquo;</span>
        </div>
      )}
    </div>
  )
}

/* ── Half-circle arc gauge ── */
function DepthArc({ angle, target, depthVariant }) {
  const A_MIN = 60
  const A_MAX = 180
  const pct = Math.max(0, Math.min(1, (A_MAX - angle) / (A_MAX - A_MIN)))
  const targetPct = Math.max(0, Math.min(1, (A_MAX - target) / (A_MAX - A_MIN)))

  const R = 60, CX = 70, CY = 70

  function pt(frac) {
    const a = Math.PI - frac * Math.PI
    return [CX + R * Math.cos(a), CY - R * Math.sin(a)]
  }

  function arc(from, to) {
    const [x1, y1] = pt(from)
    const [x2, y2] = pt(to)
    return `M ${x1} ${y1} A ${R} ${R} 0 ${to - from > 0.5 ? 1 : 0} 1 ${x2} ${y2}`
  }

  const [tx, ty] = pt(targetPct)
  const fillColor = depthVariant === "ok"
    ? "var(--color-ok)"
    : depthVariant === "warn"
      ? "var(--color-warn)"
      : "var(--color-ink-faint)"

  return (
    <svg viewBox="0 0 140 80" className="w-full max-w-[180px] mx-auto">
      <path d={arc(0, 1)} fill="none" stroke="var(--color-surface)" strokeWidth="8" strokeLinecap="round" />
      {pct > 0.01 && (
        <path d={arc(0, pct)} fill="none" stroke={fillColor} strokeWidth="8" strokeLinecap="round" />
      )}
      <circle cx={tx} cy={ty} r="4" fill="var(--color-ok)" stroke="white" strokeWidth="2" />
    </svg>
  )
}
