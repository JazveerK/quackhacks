export default function Card({ soft, className = "", children }) {
  const base = soft
    ? "bg-surface rounded-2xl p-5 md:p-6"
    : "bg-white rounded-2xl p-5 md:p-6"
  return <div className={`${base} ${className}`}>{children}</div>
}
