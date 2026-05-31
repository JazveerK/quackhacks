import { useRef, useState } from "react"
import { useSession } from "../SocketContext"
import AppHeader from "../components/AppHeader"
import GhostButton from "../components/GhostButton"
import CameraPanel from "../components/CameraPanel"
import RepCounter from "../components/RepCounter"
import TrackingSource from "../components/TrackingSource"
import FormCueBanner from "../components/FormCueBanner"
import Pill from "../components/Pill"
import SetupPoseGuide from "./SetupPoseGuide"

const CUES = [
  "Good depth — control the way up",
  "Nice control — three more",
  "Take your time on the way down",
  "Good — last one",
  "Steady through the bottom",
]

export default function LiveDashboard({ setScreen, workout = [], workoutPos = { ex: 0, set: 1 }, setWorkoutPos }) {
  const { connected, state, frame, send } = useSession()
  const [setupDone, setSetupDone] = useState(false)
  const lastRepRef = useRef(0)
  const cueIndexRef = useRef(0)

  // Offline / connecting note — no real data yet.
  if (!connected || !state) {
    return (
      <div className="flex-1 flex items-center justify-center text-ink-soft text-[15px]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 rounded-2xl bg-surface flex items-center justify-center">
            <i className="ti ti-loader-2 text-ink-faint text-xl animate-spin" />
          </div>
          {connected ? "Waiting for session…" : "Connecting…"}
        </div>
      </div>
    )
  }

  const phase = state.phase
  const repCount = state.rep_count ?? 0

  // Advance cue when rep_count increments — prefer real backend form flags.
  if (repCount > lastRepRef.current && repCount > 0) {
    cueIndexRef.current = (repCount - 1) % CUES.length
    lastRepRef.current = repCount
  }
  const formFlag =
    Array.isArray(state.form_flags) && state.form_flags.length > 0
      ? state.form_flags[0]
      : null
  const cue = formFlag ?? (repCount > 0 ? CUES[cueIndexRef.current] : null)

  const angle = state.angle ?? 180
  const target = state.target_depth_deg ?? 95

  // Show the setup pose guide once before the active set begins.
  if (!setupDone && phase === "SET_ACTIVE" && repCount === 0) {
    return (
      <div className="flex flex-col h-full p-4">
        <SetupPoseGuide
          personalTargetDepthDeg={target}
          onConfirmed={() => setSetupDone(true)}
          onSkip={() => setSetupDone(true)}
          backendLandmarks={state.pose_landmarks ?? null}
          backendFrame={frame ?? null}
        />
      </div>
    )
  }

  const tempo = state.tempo ?? 0

  const exerciseUi = state.exercise_ui ?? {}
  const exerciseName = exerciseUi.display_name ?? "Exercise"
  const isActive = phase === "SET_ACTIVE"
  const canStart = phase === "WAITING_FOR_START" || phase === "DEBRIEF"

  // ── Workout plan progression ──────────────────────────────────────
  // The plan built on check-in drives which exercise + set comes next. When a
  // set finishes (SET_END / DEBRIEF) we offer the next step instead of a bare
  // "start set", reconfiguring the tracker (exercise + rep target) as we go.
  const hasWorkout = Array.isArray(workout) && workout.length > 0
  const exIdx = Math.min(workoutPos.ex ?? 0, Math.max(0, workout.length - 1))
  const curEx = hasWorkout ? workout[exIdx] : null
  const setNum = workoutPos.set ?? 1
  const isLastSet = curEx ? setNum >= curEx.sets : true
  const isLastExercise = exIdx >= workout.length - 1
  const setDone = phase === "DEBRIEF" || (hasWorkout && phase === "SET_END")
  const workoutDone = hasWorkout && setDone && isLastSet && isLastExercise

  const advanceWorkout = () => {
    if (!hasWorkout) {
      send({ cmd: "start_set" })
      return
    }
    if (!isLastSet) {
      // Same exercise, next set.
      setWorkoutPos({ ex: exIdx, set: setNum + 1 })
      send({ cmd: "reset_set", rep_target: curEx.reps })
      send({ cmd: "start_set" })
    } else if (!isLastExercise) {
      // Move on to the next exercise's first set.
      const next = workout[exIdx + 1]
      setWorkoutPos({ ex: exIdx + 1, set: 1 })
      send({ cmd: "select_exercise", id: next.id })
      send({ cmd: "reset_set", rep_target: next.reps })
      send({ cmd: "start_set" })
    } else {
      // Whole plan finished — head to the debrief.
      setScreen("debrief")
    }
  }

  const nextLabel = !hasWorkout
    ? "Start set"
    : !isLastSet
      ? `Start set ${setNum + 1}`
      : !isLastExercise
        ? `Next: ${workout[exIdx + 1].name}`
        : "Finish workout"

  const PHASE_LABEL = {
    WAITING_FOR_START: "Ready",
    COUNTDOWN: "Get ready",
    SET_ACTIVE: "Set active",
    SET_END: "Set complete",
    DEBRIEF: "Debrief",
  }
  const phaseLabel = PHASE_LABEL[phase] ?? "Live"
  const phaseColor = isActive ? "green" : "blue"

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
      {/* Header — workout controls */}
      <AppHeader
        context={[exerciseName, `${repCount} / ${state.rep_target ?? "—"} reps`]}
        phase={phaseLabel}
        phaseColor={phaseColor}
      >
        {isActive ? (
          <GhostButton onClick={() => send({ cmd: "end_set" })}>
            <i className="ti ti-player-stop text-sm" />
            End set
          </GhostButton>
        ) : setDone ? (
          <GhostButton onClick={advanceWorkout}>
            <i className={`ti ${workoutDone ? "ti-flag-check" : "ti-player-play"} text-sm`} />
            {nextLabel}
          </GhostButton>
        ) : canStart ? (
          <GhostButton onClick={() => send({ cmd: "start_set" })}>
            <i className="ti ti-player-play text-sm" />
            {phase === "WAITING_FOR_START" && state.start_pending
              ? "Waiting for camera…"
              : "Start set"}
          </GhostButton>
        ) : null}
      </AppHeader>

      {/* Workout plan progress */}
      {hasWorkout && (
        <div className="shrink-0 flex items-center gap-2 px-4 py-2 border-b border-hair bg-surface overflow-x-auto">
          {workout.map((ex, i) => {
            const current = i === exIdx
            const done = i < exIdx
            return (
              <div
                key={i}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs whitespace-nowrap ${
                  current
                    ? "bg-brand text-white font-medium"
                    : done
                      ? "bg-ok-bg text-ok"
                      : "bg-white text-ink-soft"
                }`}
              >
                {done && <i className="ti ti-check text-xs" />}
                <span>{ex.name}</span>
                <span className={current ? "text-white/80" : "text-ink-faint"}>
                  {current ? `set ${setNum}/${ex.sets}` : `${ex.sets}×${ex.reps}`}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* 2-column: camera hero + metrics sidebar */}
      <div className="flex-1 flex gap-3 p-3 min-h-0 lg:flex-row flex-col">

        {/* Camera hero — takes remaining space */}
        <div className="relative flex-1 min-h-[280px] min-w-0">
          <CameraPanel
            frame={frame}
            targetDeg={target}
            landmarks={state.pose_landmarks}
          />
          {phase === "WAITING_FOR_START" && <CameraCheck state={state} />}
          {phase === "SET_ACTIVE" && state.setup_status?.severity === "blocking" && (
            <CameraLostOverlay setup={state.setup_status} />
          )}
          {phase === "COUNTDOWN" && (
            <div className="absolute inset-0 flex items-center justify-center bg-ink/40 rounded-lg">
              <span className="text-white text-7xl font-medium tabular-nums leading-none">
                {state.countdown ?? ""}
              </span>
            </div>
          )}
        </div>

        {/* Metrics sidebar — fixed width on desktop, full width on mobile */}
        <div className="lg:w-80 w-full shrink-0 flex flex-col gap-3 min-h-0 overflow-y-auto stagger-enter">

          {/* Rep counter — hero metric */}
          <RepCounter state={state} profile={state?.profile} />

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
          <TrackingSource state={state} profile={state?.profile} />

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

        </div>
      </div>

      {/* Form cue banner — slides up from bottom */}
      <FormCueBanner state={state} />
    </div>
  )
}

/* ── Camera-angle check (shown before a set starts) ──
 * When the camera looks good it stays out of the way (a small pill at the
 * bottom). When it isn't set up it takes over the middle of the camera so the
 * user can't miss it. */
function CameraCheck({ state }) {
  const setup = state.setup_status ?? {}
  // Backend confirms the angle once framing + the per-exercise view check pass.
  const ready = setup.code === "ok" || setup.code === "low_visibility"
  const pending = !!state.start_pending
  const positionHint = state.exercise_ui?.position_hint
  const hint = setup.hint || positionHint || "Getting the camera ready…"

  // Ready → unobtrusive confirmation pill at the bottom.
  if (ready) {
    return (
      <div className="absolute inset-x-0 bottom-0 p-3 z-30">
        <div className="mx-auto w-fit rounded-full bg-ink/70 backdrop-blur-sm px-4 py-2 flex items-center gap-2">
          <i className="ti ti-circle-check text-emerald-300 text-base" />
          <span className="text-sm font-medium text-white">
            {pending
              ? "Camera looks good — starting…"
              : "Camera looks good — say “start set”"}
          </span>
          {pending && (
            <i className="ti ti-loader-2 text-white/60 text-base animate-spin" />
          )}
        </div>
      </div>
    )
  }

  // Not ready → prominent, centered takeover.
  const blocking = setup.severity === "blocking"
  const accent = blocking ? "text-red-300" : "text-amber-300"
  const ring = blocking ? "bg-red-500/15" : "bg-amber-500/15"
  const icon = blocking ? "ti-alert-triangle" : "ti-camera"
  const title = pending ? "Hold on — line up the camera" : "Set up your camera"

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center p-6 bg-ink/55 backdrop-blur-[2px] rounded-2xl">
      <div className="flex flex-col items-center text-center gap-4 max-w-sm">
        <div className={`w-20 h-20 rounded-full ${ring} flex items-center justify-center`}>
          <i className={`ti ${icon} text-4xl ${accent}`} />
        </div>
        <div className="text-2xl font-semibold text-white">{title}</div>
        <p className="text-[15px] text-white/85 leading-relaxed">{hint}</p>
        {pending && (
          <div className="flex items-center gap-2 text-white/70 text-sm">
            <i className="ti ti-loader-2 text-base animate-spin" />
            Waiting for a clear view…
          </div>
        )}
      </div>
    </div>
  )
}

/* ── Lost-tracking takeover (shown mid-set when the camera can't see you) ── */
function CameraLostOverlay({ setup }) {
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center p-6 bg-ink/55 backdrop-blur-[2px] rounded-2xl">
      <div className="flex flex-col items-center text-center gap-4 max-w-sm">
        <div className="w-20 h-20 rounded-full bg-red-500/15 flex items-center justify-center">
          <i className="ti ti-user-off text-4xl text-red-300" />
        </div>
        <div className="text-2xl font-semibold text-white">Can't see you</div>
        <p className="text-[15px] text-white/85 leading-relaxed">
          {setup?.hint || "Step back into the camera's view."}
        </p>
      </div>
    </div>
  )
}

/* ── Half-circle arc gauge ── */
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
