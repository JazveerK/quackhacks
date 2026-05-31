import { useState, useCallback } from "react"
import Card from "../components/Card"
import GhostButton from "../components/GhostButton"
import PrimaryButton from "../components/PrimaryButton"
import MetricTile from "../components/MetricTile"
import Pill from "../components/Pill"

// ── Mock data ────────────────────────────────────────────────────────
const TREND_DATA = [
  // ~3 weeks of session avg depths (lower = deeper = better)
  { day: "May 12", deg: 108 },
  { day: "May 13", deg: 106 },
  { day: "May 14", deg: 104 },
  { day: "May 16", deg: 103 },
  { day: "May 17", deg: 101 },
  { day: "May 19", deg: 100 },
  { day: "May 20", deg: 99 },
  { day: "May 21", deg: 98 },
  { day: "May 23", deg: 97 },
  { day: "May 24", deg: 96 },
  { day: "May 26", deg: 96 },
  { day: "May 27", deg: 95 },
  { day: "May 28", deg: 94 },
  { day: "May 29", deg: 96 },
  { day: "May 30", deg: 96 },
]

// 3 weeks × 7 days: "done" | "rest" | "missed"
const HEATMAP = [
  ["done", "done", "done", "rest", "done", "done", "rest"],
  ["done", "done", "missed", "rest", "done", "done", "rest"],
  ["done", "done", "done", "rest", "done", "missed", "rest"],
]
const DAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]

const FLAGGED_PATTERNS = [
  { text: "Shallow reps increase after rep 7 in 9 of 15 sessions", count: 9 },
  { text: "Tempo accelerates in final set across all sessions", count: 15 },
  { text: "Right-side mobility plateau at ~96° for 5 sessions", count: 5 },
  { text: "Fatigue-related smoothness drop > 20% in 4 sessions", count: 4 },
]

const TARGET_DEG = 90
const CHART_MIN = 85
const CHART_MAX = 115

// ── SVG line chart ───────────────────────────────────────────────────
function DepthTrendChart() {
  const w = 600
  const h = 200
  const pad = { t: 24, r: 16, b: 28, l: 36 }
  const cw = w - pad.l - pad.r
  const ch = h - pad.t - pad.b

  const xStep = cw / (TREND_DATA.length - 1)
  // Inverted: lower degree = higher on chart (improvement rises)
  const yScale = (deg) => pad.t + ((deg - CHART_MIN) / (CHART_MAX - CHART_MIN)) * ch
  const targetY = yScale(TARGET_DEG)

  const points = TREND_DATA.map((d, i) => ({
    x: pad.l + i * xStep,
    y: yScale(d.deg),
  }))

  const linePath = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ")
  const areaPath = `${linePath} L${points[points.length - 1].x},${pad.t + ch} L${points[0].x},${pad.t + ch} Z`

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" preserveAspectRatio="xMidYMid meet">
      {/* Target line */}
      <line
        x1={pad.l} x2={w - pad.r} y1={targetY} y2={targetY}
        stroke="var(--color-brand)" strokeWidth="1" strokeDasharray="6 4" opacity="0.5"
      />
      <text x={w - pad.r + 4} y={targetY + 4} fontSize="10" fill="var(--color-brand)">
        {TARGET_DEG}° target
      </text>

      {/* Area fill */}
      <path d={areaPath} fill="var(--color-brand)" opacity="0.08" />

      {/* Line */}
      <path d={linePath} fill="none" stroke="var(--color-brand)" strokeWidth="2" />

      {/* Dots */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3" fill="var(--color-brand)" />
      ))}

      {/* X labels (every 3rd) */}
      {TREND_DATA.map((d, i) =>
        i % 3 === 0 ? (
          <text key={i} x={points[i].x} y={h - 4} fontSize="9" fill="var(--color-ink-faint)" textAnchor="middle">
            {d.day.replace("May ", "5/")}
          </text>
        ) : null
      )}

      {/* Y labels */}
      {[90, 95, 100, 105, 110].map((deg) => (
        <text key={deg} x={pad.l - 6} y={yScale(deg) + 3} fontSize="9" fill="var(--color-ink-faint)" textAnchor="end">
          {deg}°
        </text>
      ))}
    </svg>
  )
}

// ── Adherence heatmap ────────────────────────────────────────────────
function AdherenceHeatmap() {
  const cellColor = { done: "bg-ok", rest: "bg-surface", missed: "bg-warn" }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {HEATMAP.map((week, wi) => (
          <div key={wi} className="flex items-center gap-1.5">
            <span className="text-[10px] text-ink-faint w-10 shrink-0">Wk {wi + 1}</span>
            {week.map((status, di) => (
              <div
                key={di}
                className={`w-8 h-8 rounded ${cellColor[status]} flex items-center justify-center`}
                title={`${DAY_LABELS[di]}: ${status}`}
              >
                {status === "done" && <i className="ti ti-check text-white text-xs" />}
                {status === "missed" && <i className="ti ti-x text-white text-xs" />}
              </div>
            ))}
          </div>
        ))}
        {/* Day labels */}
        <div className="flex items-center gap-1.5">
          <span className="w-10 shrink-0" />
          {DAY_LABELS.map((d) => (
            <span key={d} className="w-8 text-center text-[9px] text-ink-faint">{d}</span>
          ))}
        </div>
      </div>
      {/* Legend */}
      <div className="flex items-center gap-4 text-[10px] text-ink-faint">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-ok" /> Completed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-surface border border-hair" /> Rest day
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-warn" /> Missed
        </span>
      </div>
    </div>
  )
}

// ── Toast ─────────────────────────────────────────────────────────────
function Toast({ message, onDone }) {
  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-ink text-white text-sm px-5 py-3 rounded-lg shadow-lg animate-[fadeInUp_0.25s_ease-out]"
      onAnimationEnd={() => setTimeout(onDone, 2500)}
    >
      <i className="ti ti-check mr-2" />
      {message}
    </div>
  )
}

// ── Main ClinicianView ───────────────────────────────────────────────
export default function ClinicianView({ setScreen }) {
  const [toast, setToast] = useState(null)

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }, [])

  return (
    <div className="flex flex-col gap-4">
      {/* Action buttons row */}
      <div className="flex items-center justify-end gap-3">
        <GhostButton onClick={() => showToast("Progress report exported as PDF")}>
          <i className="ti ti-file-export text-base" />
          Export PDF
        </GhostButton>
        <PrimaryButton onClick={() => showToast("Report sent to Dr. Aisha Patel")}>
          <i className="ti ti-send text-base" />
          Share with PT
        </PrimaryButton>
      </div>

      {/* Patient bar */}
      <Card className="flex items-center gap-4">
        <div className="w-11 h-11 rounded-full bg-brand-bg text-brand flex items-center justify-center text-sm font-semibold shrink-0">
          JM
        </div>
        <div>
          <h2 className="text-base font-semibold text-ink">Jordan M.</h2>
          <p className="text-xs text-ink-soft mt-0.5">
            Right knee · post-ACL reconstruction · week 6 of 12 · PT: Dr. Aisha Patel
          </p>
        </div>
      </Card>

      {/* Stat tiles */}
      <div className="grid grid-cols-4 gap-3">
        <Card>
          <MetricTile label="Adherence" value="80" unit="%" />
        </Card>
        <Card>
          <MetricTile label="Sessions" value="15" />
        </Card>
        <Card>
          <span className="text-xs text-ink-faint uppercase tracking-wide">ROM gain</span>
          <span className="text-2xl font-semibold tabular-nums text-ok">
            +14°
          </span>
        </Card>
        <Card>
          <MetricTile label="To target" value="6" unit="°" />
        </Card>
      </div>

      {/* Depth trend chart */}
      <Card>
        <h3 className="text-sm font-medium text-ink mb-3">Squat depth trend</h3>
        <DepthTrendChart />
      </Card>

      {/* Adherence heatmap */}
      <Card>
        <h3 className="text-sm font-medium text-ink mb-3">Adherence</h3>
        <AdherenceHeatmap />
      </Card>

      {/* Progress report */}
      <Card>
        <div className="flex items-center gap-2 mb-3">
          <i className="ti ti-sparkles text-brand text-lg" />
          <h3 className="text-sm font-medium text-ink">Progress report</h3>
        </div>
        <p className="text-sm text-ink-soft leading-relaxed mb-4">
          Jordan has completed 15 sessions over 3 weeks with 80% adherence to
          the prescribed 5×/week schedule. Average squat depth has improved from
          108° to 96°, a gain of 14° toward the 90° target. Depth consistency
          has improved, though reps 7–10 remain consistently shallower than
          reps 1–6. Tempo regulation is an area for continued focus — descent
          speed increases in the final set of every session. A mobility plateau
          around 96° has been observed over the last 5 sessions and may warrant
          reassessment of the stretching protocol.
        </p>
        <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wide mb-2">
          Flagged patterns
        </h4>
        <ul className="flex flex-col gap-2">
          {FLAGGED_PATTERNS.map((f, i) => (
            <li key={i} className="flex items-center gap-2 text-sm text-ink-soft">
              <i className="ti ti-alert-circle text-warn text-sm shrink-0" />
              <span className="flex-1">{f.text}</span>
              <Pill variant="warn">{f.count}×</Pill>
            </li>
          ))}
        </ul>
      </Card>

      {/* Current prescription */}
      <Card className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h3 className="text-sm font-medium text-ink">Current prescription</h3>
            <Pill variant="brand">set by PT</Pill>
          </div>
          <p className="text-sm text-ink-soft">
            Bodyweight squat · 3 sets × 10 · target 90° · 5×/week
          </p>
        </div>
        <i className="ti ti-lock text-ink-faint text-lg mt-0.5" />
      </Card>

      {/* Toast */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  )
}
