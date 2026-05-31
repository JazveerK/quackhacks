export default function AppHeader({ context = [], phase, phaseColor = "green", children }) {
  const dotCls = phaseColor === "blue" ? "bg-brand" : "bg-ok"

  return (
    <header className="h-14 px-6 flex items-center justify-between bg-white/80 backdrop-blur-md shrink-0 sticky top-0 z-30">
      <div className="flex items-center gap-2 text-[15px]">
        <span className="text-brand font-semibold tracking-tight">PhysioFusion</span>
        {context.map((s, i) => (
          <span key={i} className="flex items-center gap-2">
            <span className="text-ink-faint/50">·</span>
            <span className="text-ink-soft text-[13px]">{s}</span>
          </span>
        ))}
      </div>
      <div className="flex items-center gap-3">
        {phase && (
          <div className="flex items-center gap-2 bg-surface/80 rounded-full px-3 py-1.5">
            <span className={`w-2 h-2 rounded-full ${dotCls}`} />
            <span className="text-[12px] font-medium text-ink-soft">{phase}</span>
          </div>
        )}
        {children}
      </div>
    </header>
  )
}
