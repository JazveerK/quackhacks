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

  // Show setup pose guide before the active set (skip in mock mode)
  if (!setupDone && !state.is_mock && state.phase === "SET_ACTIVE" && state.rep_count === 0) {
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

  // Depth status — icon + text + color
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
    if (Math.abs(tempo - targetTempo) < 0.5) tempoLabel = "Steady"
    else if (tempo < targetTempo) tempoLabel = "A bit fast"
    else tempoLabel = "Nice and slow"
  }

  return (
    <div className="flex flex-col h-full">
      {/* 2-column: camera hero + metrics sidebar */}
      <div className="flex-1 flex gap-3 p-3 min-h-0 lg:flex-row flex-col">

        {/* Camera hero — takes remaining space */}
        <div className="flex-1 min-h-[280px] min-w-0">
          <CameraPanel
            frame={null}
            repDepths={state.rep_depths}
            targetDeg={target}
            landmarks={state.pose_landmarks}
          />
        </div>

        {/* Metrics sidebar — fixed width on desktop, full width on mobile */}
        <div className="lg:w-80 w-full shrink-0 flex flex-col gap-3 min-h-0 overflow-y-auto stagger-enter">

          {/* Rep counter — hero metric */}
          <RepCounter state={state} />

          {/* Knee depth with arc gauge */}
          <div className="bg-white rounded-2xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="text-[12px] text-ink-faint font-medium uppercase tracking-wide">Knee depth</div>
              <Pill variant={depthVariant}>
                <i className={`ti ${depthIcon} text-[11px]`} />
                {depthLabel}
              </Pill>
            </div>
            <div className="flex items-center gap-4">
              <DepthArc angle={angle} target={target} depthVariant={depthVariant} />
              <div>
                <span
                  className="text-[32px] font-semibold text-ink tabular-nums leading-none tracking-tight"
                  aria-label={`Knee depth ${Math.round(angle)} degrees`}
                >
                  {angle > 0 ? Math.round(angle) : "—"}°
                </span>
                <div className="text-[12px] text-ink-faint mt-1">Target: {target}°</div>
              </div>
            </div>
          </div>

          {/* Descent tempo — compact */}
          <div
            className="bg-white rounded-2xl p-4 flex items-center justify-between"
            aria-label={`Descent tempo ${tempo > 0 ? tempo.toFixed(1) : "no data"} seconds`}
          >
            <div>
              <div className="text-[12px] text-ink-faint font-medium uppercase tracking-wide mb-1">Descent tempo</div>
              <span className="text-[13px] text-ink-soft font-medium">{tempoLabel}</span>
            </div>
            <span className="text-[28px] font-semibold text-ink tabular-nums leading-none tracking-tight">
              {tempo > 0 ? tempo.toFixed(1) : "—"}
              <span className="text-[13px] font-medium text-ink-faint ml-0.5">s</span>
            </span>
          </div>

          {/* Tracking source — shows camera/IMU signal bars */}
          <TrackingSource state={state} />

          {/* Setup hint */}
          {state.setup_status && state.setup_status.severity !== "good" && (
            <div className={`rounded-2xl p-4 text-[13px] font-medium flex items-center gap-2.5 ${
              state.setup_status.severity === "blocking" || state.setup_status.severity === "warning"
                ? "bg-warn-bg text-warn"
                : "bg-surface text-ink-faint"
            }`}>
              <i className="ti ti-info-circle text-[16px] shrink-0" />
              {state.setup_status.hint}
            </div>
          )}

          {/* End set button — pushed to bottom */}
          <div className="mt-auto pt-2">
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

      {/* Form cue banner — slides up from bottom */}
      <FormCueBanner state={state} />
    </div>
  )
}

/* Half-circle arc gauge — compact version */
function DepthArc({ angle, target, depthVariant }) {
  const A_MIN = 60
  const A_MAX = 180
  const pct = Math.max(0, Math.min(1, (A_MAX - angle) / (A_MAX - A_MIN)))
  const targetPct = Math.max(0, Math.min(1, (A_MAX - target) / (A_MAX - A_MIN)))

  const R = 36, CX = 44, CY = 44

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
    <svg viewBox="0 0 88 50" className="w-20 shrink-0" role="img" aria-hidden="true">
      <path d={arc(0, 1)} fill="none" stroke="var(--color-surface)" strokeWidth="7" strokeLinecap="round" />
      {pct > 0.01 && (
        <path d={arc(0, pct)} fill="none" stroke={fillColor} strokeWidth="7" strokeLinecap="round" />
      )}
      <circle cx={tx} cy={ty} r="4" fill="var(--color-ok)" stroke="white" strokeWidth="2" />
    </svg>
  )
}
