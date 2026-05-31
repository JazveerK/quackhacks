export default function Chip({ selected, onClick, children, className = "" }) {
  const base = "px-4 py-2.5 rounded-xl text-[13px] font-medium cursor-pointer transition-all duration-150 motion-reduce:transition-none"
  const cls = selected
    ? "bg-brand text-white active:scale-[0.97]"
    : "bg-white text-ink-soft hover:text-ink hover:bg-surface active:scale-[0.97]"

  return (
    <button type="button" className={`${base} ${cls} ${className}`} onClick={onClick}>
      {children}
    </button>
  )
}
