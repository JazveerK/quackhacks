export default function AppHeader({ connected, state, profile }) {
  const phase = state?.phase || 'REST'
  const setNum = 1 // TODO: track set number across resets
  const totalSets = profile?.sets || 3

  const phaseLabel = {
    SET_ACTIVE: 'Active',
    SET_END: 'Set complete',
    DEBRIEF: 'Debrief',
    REST: 'Resting',
    CHECK_IN: 'Check-in',
    CALIBRATE: 'Calibrating',
  }[phase] || phase

  const dotColor = {
    SET_ACTIVE: 'bg-success',
    SET_END: 'bg-info',
    DEBRIEF: 'bg-info',
    REST: 'bg-tertiary-text',
    CHECK_IN: 'bg-info',
    CALIBRATE: 'bg-warning',
  }[phase] || 'bg-tertiary-text'

  return (
    <header className="h-12 px-5 flex items-center justify-between border-b border-border bg-surface-white">
      <div className="flex items-center gap-3">
        <span className="text-info font-medium tracking-wide text-[15px]">PhysioFusion</span>
        <span className="text-tertiary-text text-xs">·</span>
        <span className="text-secondary-text text-xs">Bodyweight Squat</span>
        {profile?.patient_name && (
          <>
            <span className="text-tertiary-text text-xs">·</span>
            <span className="text-secondary-text text-xs">{profile.patient_name}</span>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <span className={`w-2 h-2 rounded-full ${dotColor}`} />
        <span className="text-xs text-secondary-text">{phaseLabel}</span>
        {!connected && (
          <span className="text-xs text-warning ml-2">Disconnected</span>
        )}
      </div>
    </header>
  )
}
