const styles = {
  brand: "bg-brand-bg text-brand",
  ok:    "bg-ok-bg text-ok",
  warn:  "bg-warn-bg text-warn",
}

export default function Pill({ variant = "brand", children, className = "" }) {
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-lg text-[12px] font-medium ${styles[variant]} ${className}`}>
      {children}
    </span>
  )
}
