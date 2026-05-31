import { useState } from 'react'

export default function DebriefScreen({
  summary, aiDebrief, profile, onStartNext, onEndSession,
  setsCompleted = 0, totalSets = 3,
}) {
  const [showClinical, setShowClinical] = useState(false)

  if (!summary) return null

  const lastSet = setsCompleted >= totalSets
  const setsLeft = Math.max(0, totalSets - setsCompleted)

  const reps = summary.reps_completed ?? 0
  const target = summary.rep_target ?? 10
  const depths = summary.rep_depths_deg || []
  const targetDeg = summary.target_depth_deg ?? 95
  const debrief = aiDebrief?.text || summary.ai_debrief || summary.templated_debrief || ''

  // Build "how it went" items
  const items = []
  const analysis = summary.analysis || {}
  const depthA = analysis.depth || {}
  const tempoA = analysis.tempo || {}
  const formA = analysis.form || {}

  if (depthA.target_hit_rate != null) {
    const hitPct = Math.round(depthA.target_hit_rate * 100)
    items.push({
      status: hitPct >= 70 ? 'success' : hitPct >= 40 ? 'warning' : 'warning',
      text: `${depthA.reps_at_or_below_target || 0} of ${reps} reps reached your target depth`,
    })
  }
  if (depthA.trend === 'declining_late') {
    items.push({
      status: 'warning',
      text: 'Depth dropped off toward the end — a common fatigue pattern',
    })
  }
  if (tempoA.trend === 'slowing_down') {
    items.push({
      status: 'info',
      text: 'Your tempo slowed a bit by the end of the set',
    })
  }
  if (tempoA.trend === 'consistent') {
    items.push({
      status: 'success',
      text: 'Tempo stayed consistent throughout',
    })
  }

  const statusDot = {
    success: 'bg-success',
    warning: 'bg-warning',
    info: 'bg-info',
  }

  return (
    <div className="min-h-screen bg-[#FAFAF7] flex flex-col">
      <div className="max-w-xl mx-auto w-full px-5 py-8 flex-1 flex flex-col gap-4">

        {/* Coach card */}
        <div className="bg-surface rounded-xl p-5">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-info-fill flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--color-info)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
              </svg>
            </div>
            <div>
              <div className="text-sm font-medium text-primary-text">Nice work.</div>
            </div>
          </div>
          <p className="text-[15px] text-secondary-text leading-relaxed">{debrief}</p>
        </div>

        {/* Rep dots */}
        <div className="bg-surface-white rounded-xl border border-border p-5">
          <div className="text-[10px] text-tertiary-text tracking-wide mb-3">
            Your {reps} squats
          </div>
          <div className="flex justify-center gap-2 flex-wrap">
            {depths.map((d, i) => {
              const hit = d <= targetDeg
              return (
                <div key={i} className="flex flex-col items-center gap-1">
                  <div
                    className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-medium ${
                      hit
                        ? 'bg-success-fill text-success-text'
                        : 'bg-warning-fill text-warning-text'
                    }`}
                  >
                    {hit ? (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    )}
                  </div>
                  <span className="text-[9px] text-tertiary-text">{i + 1}</span>
                </div>
              )
            })}
          </div>
          <div className="flex justify-center gap-4 mt-3 text-[10px] text-tertiary-text">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-success" /> Reached goal
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-warning" /> Shallow
            </span>
          </div>
        </div>

        {/* How it went */}
        {items.length > 0 && (
          <div className="bg-surface-white rounded-xl border border-border p-5">
            <div className="text-[10px] text-tertiary-text tracking-wide mb-3">How it went</div>
            <div className="space-y-2.5">
              {items.map((item, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span className={`w-2 h-2 rounded-full mt-1.5 ${statusDot[item.status]}`} />
                  <span className="text-sm text-secondary-text">{item.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Action bar */}
        <div className="bg-surface rounded-xl p-5 flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="text-sm font-medium text-primary-text">
              {lastSet ? 'That was your last set' : setsLeft === 1 ? 'One more set to go' : `${setsLeft} sets to go`}
            </div>
            <div className="text-xs text-secondary-text mt-0.5">
              {lastSet
                ? 'Wrap up to see your session summary'
                : `${target} squats · take it a bit slower this time`}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!lastSet && (
              <button
                onClick={onEndSession}
                className="text-sm text-secondary-text border border-border px-4 py-2 rounded-lg hover:bg-surface-white transition-colors"
              >
                End session
              </button>
            )}
            <button
              onClick={lastSet ? onEndSession : onStartNext}
              className="bg-info text-white text-sm font-medium px-5 py-2 rounded-lg hover:opacity-90 transition-opacity flex items-center gap-1.5"
            >
              {lastSet ? 'Finish' : 'Start'}
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </button>
          </div>
        </div>

        {/* Clinical toggle */}
        <button
          onClick={() => setShowClinical(!showClinical)}
          className="mx-auto flex items-center gap-1.5 text-[11px] text-tertiary-text border border-border rounded-full px-3 py-1.5 hover:bg-surface transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4.8 2.3A.3.3 0 1 0 5 2H4a2 2 0 0 0-2 2v5a6 6 0 0 0 6 6 6 6 0 0 0 6-6V4a2 2 0 0 0-2-2h-1a.2.2 0 1 0 .3.3" />
            <path d="M8 15v1a6 6 0 0 0 6 6 6 6 0 0 0 6-6v-4" />
            <circle cx="20" cy="10" r="2" />
          </svg>
          {showClinical ? 'Hide' : 'Show'} clinical details
        </button>

        {/* Clinical details (collapsible) */}
        <div
          className="overflow-hidden transition-all duration-300"
          style={{ maxHeight: showClinical ? '600px' : '0' }}
        >
          <div className="bg-surface-white rounded-xl border border-border p-5 space-y-4">
            {/* Per-rep depth bars with degree labels */}
            <div>
              <div className="text-[10px] text-tertiary-text tracking-wide mb-2">Per-rep depth</div>
              <div className="flex items-end gap-1 h-24 relative">
                {/* Target line */}
                <div
                  className="absolute left-0 right-0 border-t border-dashed border-success"
                  style={{ bottom: `${Math.max(5, ((180 - targetDeg) / 120) * 100)}%` }}
                >
                  <span className="text-[8px] text-success absolute -top-3 right-0">{targetDeg}°</span>
                </div>
                {depths.map((d, i) => {
                  const pct = Math.max(10, ((180 - d) / 120) * 100)
                  const isShallow = d > targetDeg
                  return (
                    <div key={i} className="flex-1 flex flex-col items-center">
                      <span className="text-[8px] text-tertiary-text mb-0.5">{Math.round(d)}°</span>
                      <div
                        className={`w-full rounded-t ${isShallow ? 'bg-warning' : 'bg-success'}`}
                        style={{ height: `${pct}%` }}
                      />
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Metric grid */}
            <div className="grid grid-cols-3 gap-2">
              {[
                ['Avg depth', depthA.mean_deg != null ? `${depthA.mean_deg.toFixed(0)}°` : '--'],
                ['Best depth', depthA.min_deg != null ? `${depthA.min_deg}°` : '--'],
                ['Depth range', depthA.min_deg != null ? `${depthA.min_deg}°–${depthA.max_deg}°` : '--'],
                ['Avg descent', tempoA.mean_sec != null ? `${tempoA.mean_sec.toFixed(1)}s` : '--'],
                ['Tempo trend', tempoA.trend || '--'],
                ['Fatigue', summary.fatigue_signal || 'none'],
              ].map(([label, val], i) => (
                <div key={i} className="bg-surface rounded-lg p-2">
                  <div className="text-[9px] text-tertiary-text">{label}</div>
                  <div className="text-xs font-medium text-primary-text mt-0.5">{val}</div>
                </div>
              ))}
            </div>

            {/* Tracking source bar */}
            {analysis.tracking && (
              <div>
                <div className="text-[10px] text-tertiary-text tracking-wide mb-1">Tracking source</div>
                <div className="flex h-3 rounded-full overflow-hidden">
                  <div
                    className="bg-info transition-all"
                    style={{ width: `${(analysis.tracking.camera_frame_ratio * 100).toFixed(0)}%` }}
                  />
                  <div
                    className="bg-warning transition-all"
                    style={{ width: `${(analysis.tracking.imu_frame_ratio * 100).toFixed(0)}%` }}
                  />
                </div>
                <div className="flex justify-between mt-1 text-[9px] text-tertiary-text">
                  <span>Camera {(analysis.tracking.camera_frame_ratio * 100).toFixed(0)}%</span>
                  <span>IMU {(analysis.tracking.imu_frame_ratio * 100).toFixed(0)}%</span>
                </div>
              </div>
            )}

            {/* Form flags */}
            {formA.flag_counts && (
              <div className="flex gap-2 flex-wrap">
                {Object.entries(formA.flag_counts).filter(([, c]) => c > 0).map(([flag, count]) => (
                  <span key={flag} className="text-[10px] bg-warning-fill text-warning-text px-2 py-0.5 rounded-full">
                    {flag.replace('_', ' ')} × {count}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
