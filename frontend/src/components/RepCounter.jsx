export default function RepCounter({ state }) {
  const count = state?.rep_count ?? 0
  const target = state?.rep_target ?? 10
  const pct = target > 0 ? Math.min(100, (count / target) * 100) : 0

  return (
    <div className="bg-white rounded-2xl p-5">
      <div className="text-[12px] text-ink-faint font-medium uppercase tracking-wide mb-2">Reps</div>
      <div className="flex items-baseline gap-2" aria-label={`${count} of ${target} reps completed`}>
        <span className="text-[56px] font-semibold leading-none text-ink tabular-nums tracking-tight">
          {count}
        </span>
        <span className="text-[20px] font-medium text-ink-faint">/ {target}</span>
      </div>
      <div
        className="mt-4 h-2 rounded-full bg-surface overflow-hidden"
        role="progressbar"
        aria-valuenow={count}
        aria-valuemin={0}
        aria-valuemax={target}
      >
        <div
          className="h-full rounded-full bg-brand transition-[width] duration-300 ease-out motion-reduce:transition-none"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
