export default function Card({ soft, className = "", children }) {
  const base = soft
    ? "bg-surface rounded-lg p-4 md:p-5"
    : "bg-white border border-hair rounded-lg p-4 md:p-5"
  return <div className={`${base} ${className}`}>{children}</div>
}
