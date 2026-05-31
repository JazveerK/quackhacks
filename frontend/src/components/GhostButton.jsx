export default function GhostButton({ onClick, children, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-5 min-h-[44px] rounded-xl
        bg-surface/60 text-[14px] font-medium text-ink
        hover:bg-surface active:scale-[0.98]
        focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2
        transition-all duration-150 motion-reduce:transition-none motion-reduce:active:scale-100 ${className}`}
    >
      {children}
    </button>
  )
}
