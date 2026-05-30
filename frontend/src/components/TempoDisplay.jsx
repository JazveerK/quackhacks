export default function TempoDisplay({ state }) {
  const tempo = state?.tempo ?? 0
  const targetTempo = 3.0 // from profile, TODO: wire
  const hasData = tempo > 0

  let label = 'Waiting...'
  if (hasData) {
    if (Math.abs(tempo - targetTempo) < 0.5) label = 'Steady · within range'
    else if (tempo < targetTempo) label = 'A bit fast'
    else label = 'Nice and slow'
  }

  return (
    <div className="bg-surface-white rounded-xl border border-border p-4">
      <div className="text-[10px] text-tertiary-text tracking-wide mb-1">Descent tempo</div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[22px] font-medium text-primary-text tabular-nums leading-none">
          {hasData ? tempo.toFixed(1) : '--'}
        </span>
        <span className="text-xs text-tertiary-text">sec</span>
      </div>
      <div className="text-[11px] text-secondary-text mt-1">{label}</div>
    </div>
  )
}
