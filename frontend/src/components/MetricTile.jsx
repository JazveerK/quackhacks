export default function MetricTile({ label, value, unit, className = "" }) {
  return (
    <div className={`flex flex-col gap-1 ${className}`}>
      <span className="text-[12px] text-ink-faint font-medium uppercase tracking-wide">{label}</span>
      <span className="text-[28px] font-semibold tabular-nums text-ink leading-none">
        {value}
        {unit && <span className="text-[14px] font-medium text-ink-faint ml-0.5">{unit}</span>}
      </span>
    </div>
  )
}
