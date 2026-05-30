export default function RepCounter({ state }) {
  const count = state?.rep_count ?? 0
  const target = state?.rep_target ?? 10
  const pct = target > 0 ? Math.min(100, (count / target) * 100) : 0

  return (
    <div className="bg-surface-white rounded-xl border border-border p-4">
      <div className="text-[10px] text-tertiary-text tracking-wide mb-1">Reps</div>
      <div className="flex items-baseline gap-2">
        <span className="text-[48px] font-medium leading-none text-primary-text tabular-nums">
          {count}
        </span>
        <span className="text-lg text-tertiary-text">/ {target}</span>
      </div>
      <div className="mt-3 h-1 rounded-full bg-surface overflow-hidden">
        <div
          className="h-full rounded-full bg-info transition-all duration-200"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
