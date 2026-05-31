export default function PrimaryButton({ onClick, arrow, children, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-brand text-white text-sm font-medium hover:opacity-90 transition-opacity ${className}`}
    >
      {children}
      {arrow && <i className="ti ti-arrow-right text-base" />}
    </button>
  )
}
