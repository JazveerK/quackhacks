export default function RepBars({ depths, targetDeg }) {
  if (!depths || depths.length === 0) return null
  const target = targetDeg ?? 95

  return (
    <div className="bg-white rounded-lg border border-hair p-4">
      <div className="text-[10px] text-ink-faint tracking-wide mb-3">Per-rep depth</div>
      <div className="flex items-end gap-1 h-16">
        {depths.map((d, i) => {
          const isShallow = d > target + 5
          const pct = Math.max(10, Math.min(100, ((180 - d) / 120) * 100))
          return (
            <div
              key={i}
              className={`flex-1 rounded-t transition-all duration-200 ${
                isShallow ? 'bg-warn' : 'bg-brand'
              }`}
              style={{ height: `${pct}%` }}
              title={`Rep ${i + 1}: ${Math.round(d)}°`}
            />
          )
        })}
      </div>
      <div className="flex justify-between mt-1">
        <span className="text-[9px] text-ink-faint">Rep 1</span>
        <span className="text-[9px] text-ink-faint">Rep {depths.length}</span>
      </div>
    </div>
  )
}
