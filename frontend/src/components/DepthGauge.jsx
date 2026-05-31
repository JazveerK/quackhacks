export default function DepthGauge({ state, profile }) {
  const angle = state?.angle ?? 180
  const depthState = state?.depth_state || 'shallow'
  const ex = state?.exercise_ui
  const targetDeg = state?.target_depth_deg ?? profile?.depth_deg ?? 95
  const rom = ex?.rom_metric || 'min'

  // Arc gauge: 0% = resting, 100% = full range. Range + direction come from the
  // active exercise: "min" fills as the angle shrinks (squat), "max" fills as it
  // grows (arm raise).
  const A_MIN = ex?.gauge_min_deg ?? 60
  const A_MAX = ex?.gauge_max_deg ?? 180
  const fill = (a) => {
    const r = (A_MAX - a) / (A_MAX - A_MIN)
    return Math.max(0, Math.min(1, rom === 'max' ? 1 - r : r))
  }
  const pct = fill(angle)
  const targetPct = fill(targetDeg)

  // SVG half-circle arc
  const R = 60
  const CX = 70
  const CY = 70
  const startAngle = Math.PI // left
  const endAngle = 0 // right

  function arcPoint(frac) {
    const a = startAngle - frac * Math.PI
    return [CX + R * Math.cos(a), CY - R * Math.sin(a)]
  }

  function arcPath(from, to) {
    const [x1, y1] = arcPoint(from)
    const [x2, y2] = arcPoint(to)
    const largeArc = to - from > 0.5 ? 1 : 0
    return `M ${x1} ${y1} A ${R} ${R} 0 ${largeArc} 1 ${x2} ${y2}`
  }

  const [tx, ty] = arcPoint(targetPct)

  const badgeLabel = {
    below_parallel: 'At target',
    at_parallel: 'Approaching',
    shallow: 'Above target',
  }[depthState] || depthState

  const badgeClass = {
    below_parallel: 'bg-success-fill text-success-text',
    at_parallel: 'bg-info-fill text-info-text',
    shallow: 'bg-warning-fill text-warning-text',
  }[depthState] || 'bg-surface text-secondary-text'

  return (
    <div className="bg-surface-white rounded-xl border border-border p-4">
      <div className="text-[10px] text-tertiary-text tracking-wide mb-1">{ex?.depth_label || 'Depth'}</div>
      <div className="flex items-center gap-3 mb-2">
        <span className="text-[26px] font-medium text-primary-text tabular-nums leading-none">
          {angle > 0 ? Math.round(angle) : '--'}
        </span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${badgeClass}`}>
          {badgeLabel}
        </span>
      </div>

      <svg viewBox="0 0 140 80" className="w-full max-w-[200px] mx-auto">
        {/* Track */}
        <path d={arcPath(0, 1)} fill="none" stroke="var(--color-surface)" strokeWidth="8" strokeLinecap="round" />
        {/* Fill */}
        {pct > 0.01 && (
          <path
            d={arcPath(0, pct)}
            fill="none"
            stroke={depthState === 'shallow' ? 'var(--color-warning)' : 'var(--color-success)'}
            strokeWidth="8"
            strokeLinecap="round"
          />
        )}
        {/* Target marker */}
        <circle cx={tx} cy={ty} r="4" fill="var(--color-success)" stroke="white" strokeWidth="2" />
      </svg>
    </div>
  )
}
