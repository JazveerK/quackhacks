export default function AppHeader({ context = [], phase, phaseColor = "green", children }) {
  const dotCls = phaseColor === "blue" ? "bg-brand" : "bg-ok"

  return (
    <header className="h-12 px-5 flex items-center justify-between border-b border-hair bg-white shrink-0">
      <div className="flex items-center gap-1.5 text-[15px]">
        <span className="text-brand font-medium tracking-wide">PhysioFusion</span>
        {context.map((s, i) => (
          <span key={i} className="flex items-center gap-1.5">
            <span className="text-ink-faint">·</span>
            <span className="text-ink-soft text-xs">{s}</span>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-3">
        {phase && (
          <div className="flex items-center gap-2">
            <span className={`w-2 h-2 rounded-full ${dotCls}`} />
            <span className="text-xs text-ink-soft">{phase}</span>
          </div>
        )}
        {children}
      </div>
    </header>
  )
}
