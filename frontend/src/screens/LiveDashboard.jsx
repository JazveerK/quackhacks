import { useState } from "react"
import { useMockSession } from "../mockSession"
import CameraPanel from "../components/CameraPanel"
import RepCounter from "../components/RepCounter"
import TrackingSource from "../components/TrackingSource"
import FormCueBanner from "../components/FormCueBanner"
import Pill from "../components/Pill"
import SetupPoseGuide from "./SetupPoseGuide"

export default function LiveDashboard({ setScreen }) {
  const { state } = useMockSession()
  const [setupDone, setSetupDone] = useState(false)

  if (!state) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-soft text-[15px]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-surface flex items-center justify-center">
            <i className="ti ti-loader-2 text-ink-faint text-xl animate-spin" />
          </div>
          Connecting…
        </div>
      </div>
    )
  }

  const target = state.personal_target_depth_deg ?? 95

  // Show setup pose guide before the active set
  if (!setupDone && state.phase === "SET_ACTIVE" && state.rep_count === 0) {
    return (
      <div className="flex flex-col h-full p-4">
        <SetupPoseGuide
          personalTargetDepthDeg={target}
          onConfirmed={() => setSetupDone(true)}
          onSkip={() => setSetupDone(true)}
          backendLandmarks={state.pose_landmarks ?? null}
          backendFrame={null}
        />
      </div>
    )
  }

  const angle = state.angle ?? 180
  const tempo = state.tempo ?? 0
  const imuQ = state.imu_quality ?? 0
  const vis = state.landmark_visibility ?? 0

  // Depth status — icon + text + color (triple redundancy)
  let depthLabel, depthVariant, depthIcon
  if (angle <= target + 5) {
    depthLabel = "At target"
    depthVariant = "ok"
    depthIcon = "ti-check"
  } else if (angle <= target + 20) {
    depthLabel = "Approaching"
    depthVariant = "brand"
    depthIcon = "ti-arrow-down"
  } else {
    depthLabel = "Above target"
    depthVariant = "warn"
    depthIcon = "ti-arrow-up"
  }

  // Tempo assessment
  const targetTempo = 3.0
  let tempoLabel = "Waiting…"
  if (tempo > 0) {
    if (Math.abs(tempo - targetTempo) < 0.5) tempoLabel = "Steady · within range"
    else if (tempo < targetTempo) tempoLabel = "A bit fast"
    else tempoLabel = "Nice and slow"
  }

  return (
    <div className="flex flex-col h-full">
      {/* 3-column grid — camera hero (60%), metrics (25%), sidebar (15%) */}
      <div className="flex-1 grid grid-cols-[3fr_1.25fr_0.75fr] gap-3 p-3 min-h-0
                       max-[1023px]:grid-cols-[3fr_1.5fr] max-[767px]:grid-cols-1">

        {/* Camera (hero) with per-rep bar overlay */}
        <CameraPanel
          frame={null}
          repDepths={state.rep_depths}
          targetDeg={target}
          landmarks={state.pose_landmarks}
        />

        {/* Metrics column */}
        <div className="flex flex-col gap-3 min-h-0 overflow-y-auto">
          <RepCounter state={state} />

          {/* Knee depth with arc gauge */}
          <div
            className="bg-white rounded-2xl p-5"
            aria-label={`Knee depth ${Math.round(angle)} degrees, ${depthLabel}`}
          >
            <div className="text-[12px] text-ink-faint font-medium uppercase tracking-wide mb-2">Knee depth</div>
            <div className="flex items-center gap-2.5 mb-3">
              <span className="text-[28px] font-semibold text-ink tabular-nums leading-none tracking-tight">
                {angle > 0 ? Math.round(angle) : "—"}°
              </span>
              <Pill variant={depthVariant}>
                <i className={`ti ${depthIcon} text-[11px]`} />
                {depthLabel}
              </Pill>
            </div>
            <DepthArc angle={angle} target={target} depthVariant={depthVariant} />
          </div>

          {/* Descent tempo */}
          <div
            className="bg-white rounded-2xl p-5"
            aria-label={`Descent tempo ${tempo > 0 ? tempo.toFixed(1) : "no data"} seconds, ${tempoLabel}`}
          >
            <div className="text-[12px] text-ink-faint font-medium uppercase tracking-wide mb-2">Descent tempo</div>
            <span className="text-[28px] font-semibold text-ink tabular-nums leading-none tracking-tight">
              {tempo > 0 ? tempo.toFixed(1) : "—"}
              <span className="text-[14px] font-medium text-ink-faint ml-1">s</span>
            </span>
            <div className="text-[13px] text-ink-soft mt-2 font-medium">
              {tempoLabel}
            </div>
          </div>

          {/* Setup hint */}
          {state.setup_status && state.setup_status.severity !== "good" && (
            <div className={`rounded-2xl p-4 text-[13px] font-medium flex items-center gap-2.5 ${
              state.setup_status.severity === "blocking" || state.setup_status.severity === "warning"
                ? "bg-warn-bg text-warn"
                : "bg-surface text-ink-faint"
            }`}>
              <i className="ti ti-info-circle text-[16px]" />
              {state.setup_status.hint}
            </div>
          )}
        </div>

        {/* Sidebar — fusion indicators + actions */}
        <div className="flex flex-col gap-3 min-h-0 overflow-y-auto
                        max-[1023px]:flex-row max-[1023px]:flex-wrap max-[767px]:flex-row">
          <TrackingSource state={state} />

          {/* IMU quality */}
          <div className="bg-white rounded-2xl p-5" aria-label={`IMU quality ${Math.round(imuQ * 100)} percent`}>
            <div className="text-[12px] text-ink-faint font-medium uppercase tracking-wide mb-2">IMU quality</div>
            <span className={`text-[22px] font-semibold tabular-nums ${imuQ < 0.5 ? "text-warn" : "text-ink"}`}>
              {Math.round(imuQ * 100)}%
            </span>
          </div>

          {/* Visibility */}
          <div className="bg-white rounded-2xl p-5" aria-label={`Landmark visibility ${Math.round(vis * 100)} percent`}>
            <div className="text-[12px] text-ink-faint font-medium uppercase tracking-wide mb-2">Visibility</div>
            <span className={`text-[22px] font-semibold tabular-nums ${vis < 0.5 ? "text-warn" : "text-ink"}`}>
              {Math.round(vis * 100)}%
            </span>
            {vis < 0.5 && (
              <div className="flex items-center gap-1.5 mt-2 text-[12px] text-warn font-medium">
                <i className="ti ti-alert-circle text-[14px]" />
                Low visibility
              </div>
            )}
          </div>

          {/* End set — pinned to bottom */}
          <div className="mt-auto">
            <button
              type="button"
              onClick={() => setScreen("debrief")}
              className="w-full flex items-center justify-center gap-2 min-h-[48px] px-4
                         bg-surface/80 rounded-xl text-[14px] font-semibold text-ink-soft
                         hover:bg-surface active:scale-[0.98]
                         focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2
                         transition-all duration-150 motion-reduce:transition-none motion-reduce:active:scale-100"
            >
              <i className="ti ti-player-stop text-[14px]" />
              End set
            </button>
          </div>
        </div>
      </div>

      {/* Form cue banner */}
      <FormCueBanner state={state} />
    </div>
  )
}

/* Half-circle arc gauge */
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
    <svg viewBox="0 0 140 80" className="w-full max-w-[180px] mx-auto" role="img" aria-hidden="true">
      <path d={arc(0, 1)} fill="none" stroke="var(--color-surface)" strokeWidth="10" strokeLinecap="round" />
      {pct > 0.01 && (
        <path d={arc(0, pct)} fill="none" stroke={fillColor} strokeWidth="10" strokeLinecap="round" />
      )}
      <circle cx={tx} cy={ty} r="5" fill="var(--color-ok)" stroke="white" strokeWidth="2.5" />
    </svg>
  )
}
