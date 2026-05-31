/**
 * Overlay shown on the live screen before a set is counting:
 *   WAITING_FOR_START -> a "Get into position" card with a Start button
 *   COUNTDOWN         -> a big 3-2-1 number
 * Sits on top of the camera feed so the patient can frame themselves first.
 */
export default function StartGate({ state, profile, onStartSet }) {
  const phase = state?.phase
  if (phase !== 'WAITING_FOR_START' && phase !== 'COUNTDOWN') return null

  const setup = state?.setup_status
  const ready = setup?.ok !== false
  const target = state?.rep_target ?? profile?.reps_per_set ?? 10
  const ex = state?.exercise_ui
  const plural = ex?.plural || 'reps'
  const positionHint = ex?.position_hint || 'Stand side-on so your whole body is in frame.'

  if (phase === 'COUNTDOWN') {
    const n = state?.countdown
    return (
      <div className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-[1px]">
        <div className="flex flex-col items-center gap-2">
          <span className="text-[96px] font-medium leading-none text-white tabular-nums">
            {n != null && n > 0 ? n : 'Go'}
          </span>
          <span className="text-sm text-white/70">Get ready</span>
        </div>
      </div>
    )
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center bg-black/55 backdrop-blur-[1px] p-6">
      <div className="bg-surface-white rounded-2xl border border-border p-6 max-w-sm w-full text-center">
        <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-info-fill flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-info)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="5 3 19 12 5 21 5 3" />
          </svg>
        </div>
        <div className="text-base font-medium text-primary-text">Ready when you are</div>
        <p className="text-sm text-secondary-text mt-1">
          {target} {plural} this set. {positionHint}
        </p>

        <div
          className={`mt-3 inline-flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-full ${
            ready ? 'bg-success-fill text-success-text' : 'bg-warning-fill text-warning-text'
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${ready ? 'bg-success' : 'bg-warning'}`} />
          {ready ? 'In position' : (setup?.hint || 'Step into frame')}
        </div>

        <button
          onClick={onStartSet}
          className="mt-5 w-full bg-info text-white text-sm font-medium px-5 py-2.5 rounded-lg hover:opacity-90 transition-opacity"
        >
          Start set
        </button>
        <p className="text-[11px] text-tertiary-text mt-2">or say “start my set”</p>
      </div>
    </div>
  )
}
