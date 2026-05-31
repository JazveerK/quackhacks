export default function Chip({ selected, onClick, children, className = "" }) {
  const base = "px-3 py-1.5 rounded-full text-xs font-medium cursor-pointer transition-colors"
  const cls = selected
    ? "bg-brand text-white"
    : "bg-surface text-ink-soft hover:text-ink"

  return (
    <button type="button" className={`${base} ${cls} ${className}`} onClick={onClick}>
      {children}
    </button>
  )
}
