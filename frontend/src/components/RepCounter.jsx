export default function RepCounter({ state }) {
  const count = state?.rep_count ?? 0
  const target = state?.rep_target ?? 10
  const pct = target > 0 ? Math.min(100, (count / target) * 100) : 0

  return (
    <div className="bg-white rounded-lg border border-hair p-4">
      <div className="text-[10px] text-ink-faint tracking-wide mb-1">Reps</div>
      <div className="flex items-baseline gap-2">
        <span className="text-[48px] font-medium leading-none text-ink tabular-nums">
          {count}
        </span>
        <span className="text-lg text-ink-faint">/ {target}</span>
      </div>
      <div className="mt-3 h-1 rounded-full bg-surface overflow-hidden">
        <div
          className="h-full rounded-full bg-brand transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
