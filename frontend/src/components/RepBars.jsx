export default function RepBars({ depths, targetDeg, ex }) {
  if (!depths || depths.length === 0) return null
  const target = targetDeg ?? 95
  const rom = ex?.rom_metric || 'min'
  const A_MIN = ex?.gauge_min_deg ?? 60
  const A_MAX = ex?.gauge_max_deg ?? 180
  // Bar height = how far through the range the rep got (direction-aware).
  const heightPct = (d) => {
    const r = (A_MAX - d) / (A_MAX - A_MIN)
    const v = rom === 'max' ? 1 - r : r
    return Math.max(10, Math.min(100, v * 100))
  }
  const missed = (d) => (rom === 'max' ? d < target - 5 : d > target + 5)

  return (
    <div className="bg-surface-white rounded-xl border border-border p-4">
      <div className="text-[10px] text-tertiary-text tracking-wide mb-3">Per-rep range</div>
      <div className="flex items-end gap-1 h-16">
        {depths.map((d, i) => {
          const isShallow = missed(d)
          const pct = heightPct(d)
          return (
            <div
              key={i}
              className={`flex-1 rounded-t transition-all duration-200 ${
                isShallow ? 'bg-warning' : 'bg-info'
              }`}
              style={{ height: `${pct}%` }}
              title={`Rep ${i + 1}: ${Math.round(d)}°`}
            />
          )
        })}
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[9px] text-tertiary-text">Rep 1</span>
        <span className="text-[9px] text-tertiary-text">Rep {depths.length}</span>
      </div>
    </div>
  )
}
