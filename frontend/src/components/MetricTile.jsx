export default function MetricTile({ label, value, unit, className = "" }) {
  return (
    <div className={`flex flex-col gap-0.5 ${className}`}>
      <span className="text-xs text-ink-faint uppercase tracking-wide">{label}</span>
      <span className="text-2xl font-semibold tabular-nums text-ink">
        {value}
        {unit && <span className="text-sm font-normal text-ink-soft ml-0.5">{unit}</span>}
      </span>
    </div>
  )
}
