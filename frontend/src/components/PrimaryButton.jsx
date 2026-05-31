export default function PrimaryButton({ onClick, arrow, children, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-6 min-h-[48px] rounded-xl
        bg-brand text-white text-[14px] font-semibold
        hover:opacity-90 active:scale-[0.98] active:opacity-85
        focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2
        transition-all duration-150 motion-reduce:transition-none motion-reduce:active:scale-100 ${className}`}
    >
      {children}
      {arrow && <i className="ti ti-arrow-right text-base" />}
    </button>
  )
}
