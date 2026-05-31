const styles = {
  brand: "bg-brand-bg text-brand",
  ok:    "bg-ok-bg text-ok",
  warn:  "bg-warn-bg text-warn",
}

export default function Pill({ variant = "brand", children, className = "" }) {
  return (
    <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-medium ${styles[variant]} ${className}`}>
      {children}
    </span>
  )
}
