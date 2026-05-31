export default function TempoDisplay({ state }) {
  const tempo = state?.tempo ?? 0
  const targetTempo = 3.0
  const hasData = tempo > 0

  let label = 'Waiting...'
  if (hasData) {
    if (Math.abs(tempo - targetTempo) < 0.5) label = 'Steady · within range'
    else if (tempo < targetTempo) label = 'A bit fast'
    else label = 'Nice and slow'
  }

  return (
    <div className="bg-white rounded-lg border border-hair p-4">
      <div className="text-[10px] text-ink-faint tracking-wide mb-1">Descent tempo</div>
      <div className="flex items-baseline gap-1.5">
        <span className="text-[22px] font-medium text-ink tabular-nums leading-none">
          {hasData ? tempo.toFixed(1) : '--'}
        </span>
        <span className="text-xs text-ink-faint">sec</span>
      </div>
      <div className="text-[11px] text-ink-soft mt-1">{label}</div>
    </div>
  )
}
