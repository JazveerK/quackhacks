export default function DepthGauge({ state, profile }) {
  const angle = state?.angle ?? 180
  const depthState = state?.depth_state || 'shallow'
  const targetDeg = profile?.depth_deg ?? 95

  const A_MIN = 60
  const A_MAX = 180
  const pct = Math.max(0, Math.min(1, (A_MAX - angle) / (A_MAX - A_MIN)))
  const targetPct = Math.max(0, Math.min(1, (A_MAX - targetDeg) / (A_MAX - A_MIN)))

  const R = 60
  const CX = 70
  const CY = 70
  const startAngle = Math.PI

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
    below_parallel: 'bg-ok-bg text-ok',
    at_parallel: 'bg-brand-bg text-brand',
    shallow: 'bg-warn-bg text-warn',
  }[depthState] || 'bg-surface text-ink-soft'

  return (
    <div className="bg-white rounded-lg border border-hair p-4">
      <div className="text-[10px] text-ink-faint tracking-wide mb-1">Knee depth</div>
      <div className="flex items-center gap-3 mb-2">
        <span className="text-[26px] font-medium text-ink tabular-nums leading-none">
          {angle > 0 ? Math.round(angle) : '--'}
        </span>
        <span className={`text-[10px] px-2 py-0.5 rounded-full ${badgeClass}`}>
          {badgeLabel}
        </span>
      </div>

      <svg viewBox="0 0 140 80" className="w-full max-w-[200px] mx-auto">
        <path d={arcPath(0, 1)} fill="none" stroke="var(--color-surface)" strokeWidth="8" strokeLinecap="round" />
        {pct > 0.01 && (
          <path
            d={arcPath(0, pct)}
            fill="none"
            stroke={depthState === 'shallow' ? 'var(--color-warn)' : 'var(--color-ok)'}
            strokeWidth="8"
            strokeLinecap="round"
          />
        )}
        <circle cx={tx} cy={ty} r="4" fill="var(--color-ok)" stroke="white" strokeWidth="2" />
      </svg>
    </div>
  )
}
