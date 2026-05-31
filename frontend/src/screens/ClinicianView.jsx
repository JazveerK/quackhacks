import { useState, useCallback } from "react"
import Card from "../components/Card"
import GhostButton from "../components/GhostButton"
import PrimaryButton from "../components/PrimaryButton"
import MetricTile from "../components/MetricTile"
import Pill from "../components/Pill"
import ClinicianHandoff from "./ClinicianHandoff"

// ── Mock data ────────────────────────────────────────────────────────
const TREND_DATA = [
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
      <line
        x1={pad.l} x2={w - pad.r} y1={targetY} y2={targetY}
        stroke="var(--color-brand)" strokeWidth="1" strokeDasharray="6 4" opacity="0.5"
      />
      <text x={w - pad.r + 4} y={targetY + 4} fontSize="10" fill="var(--color-brand)">
        {TARGET_DEG}° target
      </text>
      <path d={areaPath} fill="var(--color-brand)" opacity="0.08" />
      <path d={linePath} fill="none" stroke="var(--color-brand)" strokeWidth="2.5" strokeLinejoin="round" />
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r="3.5" fill="var(--color-brand)" />
      ))}
      {TREND_DATA.map((d, i) =>
        i % 3 === 0 ? (
          <text key={i} x={points[i].x} y={h - 4} fontSize="9" fill="var(--color-ink-faint)" textAnchor="middle">
            {d.day.replace("May ", "5/")}
          </text>
        ) : null
      )}
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
      <div className="flex flex-col gap-2">
        {HEATMAP.map((week, wi) => (
          <div key={wi} className="flex items-center gap-2">
            <span className="text-[11px] text-ink-faint w-10 shrink-0 font-medium">Wk {wi + 1}</span>
            {week.map((status, di) => (
              <div
                key={di}
                className={`w-9 h-9 rounded-xl ${cellColor[status]} flex items-center justify-center transition-all duration-150`}
                title={`${DAY_LABELS[di]}: ${status}`}
              >
                {status === "done" && <i className="ti ti-check text-white text-[12px]" />}
                {status === "missed" && <i className="ti ti-x text-white text-[12px]" />}
              </div>
            ))}
          </div>
        ))}
        <div className="flex items-center gap-2">
          <span className="w-10 shrink-0" />
          {DAY_LABELS.map((d) => (
            <span key={d} className="w-9 text-center text-[10px] text-ink-faint font-medium">{d}</span>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-5 text-[11px] text-ink-faint font-medium">
        <span className="flex items-center gap-2">
          <span className="w-3.5 h-3.5 rounded-md bg-ok" /> Completed
        </span>
        <span className="flex items-center gap-2">
          <span className="w-3.5 h-3.5 rounded-md bg-surface" /> Rest day
        </span>
        <span className="flex items-center gap-2">
          <span className="w-3.5 h-3.5 rounded-md bg-warn" /> Missed
        </span>
      </div>
    </div>
  )
}

// ── Toast ─────────────────────────────────────────────────────────────
function Toast({ message, onDone }) {
  return (
    <div
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-ink text-white text-[14px] font-medium px-5 py-3.5 rounded-2xl animate-[fadeInUp_0.25s_ease-out]"
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
  const [handoffObs, setHandoffObs] = useState(null)
  const [showHandoff, setShowHandoff] = useState(false)

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }, [])

  const handleShareWithPT = useCallback(async () => {
    try {
      const res = await fetch("/session")
      const data = await res.json()
      const sid = data.session_id
      const obsRes = await fetch(`/api/share/${sid}`)
      if (obsRes.ok) {
        const obsData = await obsRes.json()
        setHandoffObs(obsData.observation)
        setShowHandoff(true)
        return
      }
    } catch (e) {
      // fallback
    }
    setShowHandoff(true)
  }, [])

  if (showHandoff) {
    return (
      <>
        <div className="flex items-center gap-3">
          <GhostButton onClick={() => setShowHandoff(false)}>
            <i className="ti ti-arrow-left text-[15px]" />
            Back to overview
          </GhostButton>
        </div>
        <ClinicianHandoff observation={handoffObs} />
      </>
    )
  }

  return (
    <>
      {/* Action buttons row */}
      <div className="flex items-center justify-end gap-3">
        <GhostButton onClick={() => showToast("Progress report exported as PDF")}>
          <i className="ti ti-file-export text-[15px]" />
          Export PDF
        </GhostButton>
        <PrimaryButton onClick={handleShareWithPT}>
          <i className="ti ti-send text-[15px]" />
          Share with PT
        </PrimaryButton>
      </div>

      {/* Patient bar */}
      <Card className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-brand-bg text-brand flex items-center justify-center text-[15px] font-semibold shrink-0">
          JM
        </div>
        <div>
          <h2 className="text-[17px] font-semibold text-ink tracking-tight">Jordan M.</h2>
          <p className="text-[13px] text-ink-soft mt-1">
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
          <span className="text-[12px] text-ink-faint uppercase tracking-wide font-medium">ROM gain</span>
          <span className="text-[28px] font-semibold tabular-nums text-ok leading-none tracking-tight mt-1">
            +14°
          </span>
        </Card>
        <Card>
          <MetricTile label="To target" value="6" unit="°" />
        </Card>
      </div>

      {/* Depth trend chart */}
      <Card>
        <h3 className="text-[16px] font-semibold text-ink mb-4">Squat depth trend</h3>
        <DepthTrendChart />
      </Card>

      {/* Adherence heatmap */}
      <Card>
        <h3 className="text-[16px] font-semibold text-ink mb-4">Adherence</h3>
        <AdherenceHeatmap />
      </Card>

      {/* Progress report */}
      <Card>
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-2xl bg-brand-bg text-brand flex items-center justify-center shrink-0">
            <i className="ti ti-sparkles text-[18px]" />
          </div>
          <h3 className="text-[16px] font-semibold text-ink">Progress report</h3>
        </div>
        <p className="text-[14px] text-ink-soft leading-relaxed mb-5">
          Jordan has completed 15 sessions over 3 weeks with 80% adherence to
          the prescribed 5x/week schedule. Average squat depth has improved from
          108° to 96°, a gain of 14° toward the 90° target. Depth consistency
          has improved, though reps 7-10 remain consistently shallower than
          reps 1-6. Tempo regulation is an area for continued focus — descent
          speed increases in the final set of every session. A mobility plateau
          around 96° has been observed over the last 5 sessions and may warrant
          reassessment of the stretching protocol.
        </p>
        <h4 className="text-[12px] font-medium text-ink-faint uppercase tracking-wide mb-3">
          Flagged patterns
        </h4>
        <ul className="flex flex-col gap-3">
          {FLAGGED_PATTERNS.map((f, i) => (
            <li key={i} className="flex items-center gap-3">
              <div className="w-8 h-8 rounded-xl bg-warn-bg flex items-center justify-center shrink-0">
                <i className="ti ti-alert-circle text-warn text-[14px]" />
              </div>
              <span className="flex-1 text-[14px] text-ink-soft">{f.text}</span>
              <Pill variant="warn">{f.count}x</Pill>
            </li>
          ))}
        </ul>
      </Card>

      {/* Current prescription */}
      <Card className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2.5 mb-1.5">
            <h3 className="text-[15px] font-semibold text-ink">Current prescription</h3>
            <Pill variant="brand">set by PT</Pill>
          </div>
          <p className="text-[14px] text-ink-soft">
            Bodyweight squat · 3 sets x 10 · target 90° · 5x/week
          </p>
        </div>
        <div className="w-10 h-10 rounded-2xl bg-surface flex items-center justify-center shrink-0">
          <i className="ti ti-lock text-ink-faint text-[16px]" />
        </div>
      </Card>

      {/* Toast */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </>
  )
}
