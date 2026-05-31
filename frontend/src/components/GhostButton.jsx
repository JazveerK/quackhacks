export default function GhostButton({ onClick, children, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-hair text-sm text-ink hover:bg-surface transition-colors ${className}`}
    >
      {children}
    </button>
  )
}
