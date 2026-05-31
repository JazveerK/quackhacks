/**
 * End-of-session report (page 3). Renders the aggregates + the PT-facing
 * progress note returned by POST /session/end (or the voice agent's
 * end_session reply). onClose rotates back to a fresh live session.
 */
export default function SessionReport({ report, onClose }) {
  if (!report) return null

  const sets = report.sets_count ?? 0
  const reps = report.total_reps ?? 0
  const depth = report.avg_depth
  const adherence = report.adherence_flag || '—'
  const note = report.report

  const adherenceClass =
    adherence === 'complete'
      ? 'bg-success-fill text-success-text'
      : adherence === 'partial'
        ? 'bg-warning-fill text-warning-text'
        : 'bg-surface text-secondary-text'

  const stats = [
    ['Sets', sets],
    ['Total reps', reps],
    ['Avg depth', depth != null ? `${depth}°` : '—'],
  ]

  return (
    <div className="min-h-screen bg-[#FAFAF7] flex flex-col">
      <div className="max-w-xl mx-auto w-full px-5 py-8 flex-1 flex flex-col gap-4">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] text-tertiary-text tracking-wide">Session complete</div>
            <h2 className="text-xl font-medium text-primary-text mt-0.5">Your summary</h2>
          </div>
          <span className={`text-[11px] px-3 py-1 rounded-full capitalize ${adherenceClass}`}>
            {adherence}
          </span>
        </div>

        {/* Stat tiles */}
        <div className="grid grid-cols-3 gap-3">
          {stats.map(([label, val]) => (
            <div key={label} className="bg-surface-white rounded-xl border border-border p-4 text-center">
              <div className="text-[28px] font-medium text-primary-text tabular-nums leading-none">
                {val}
              </div>
              <div className="text-[10px] text-tertiary-text tracking-wide mt-1.5">{label}</div>
            </div>
          ))}
        </div>

        {/* PT progress note */}
        {note ? (
          <div className="bg-surface rounded-xl p-5">
            <div className="flex items-center gap-2.5 mb-2">
              <div className="w-8 h-8 rounded-full bg-info-fill flex items-center justify-center">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-info)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="16" y2="17" />
                </svg>
              </div>
              <div className="text-sm font-medium text-primary-text">Note for your physio</div>
            </div>
            <p className="text-[15px] text-secondary-text leading-relaxed whitespace-pre-line">{note}</p>
          </div>
        ) : (
          <div className="bg-surface rounded-xl p-5 text-sm text-secondary-text">
            {sets > 0
              ? 'Saved. A detailed progress note will appear here once the AI summary is configured.'
              : 'No sets were recorded this session.'}
          </div>
        )}

        <button
          onClick={onClose}
          className="mt-auto self-center bg-info text-white text-sm font-medium px-6 py-2.5 rounded-lg hover:opacity-90 transition-opacity"
        >
          Start a new session
        </button>
      </div>
    </div>
  )
}
