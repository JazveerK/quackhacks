import { useState, useCallback, useEffect } from "react"
import Card from "../components/Card"
import GhostButton from "../components/GhostButton"
import PrimaryButton from "../components/PrimaryButton"
import MetricTile from "../components/MetricTile"
import Pill from "../components/Pill"

const TARGET_DEG = 90
const CHART_MIN = 85
const CHART_MAX = 120

// ── Defensive readers (BigQuery rows may be flatter than in-memory) ───
// A row is a SESSION (cross-session history) or a SET (single-session fallback).
function depthMean(r) {
  const v = r?.avg_depth ?? r?.analysis?.depth?.mean_deg ?? r?.avg_depth_deg ?? null
  return v == null ? null : Number(v)
}
function hitRate(r) {
  const v = r?.analysis?.depth?.target_hit_rate ?? r?.target_hit_rate ?? null
  return v == null ? null : Number(v)
}
function depthTrend(r) {
  return r?.analysis?.depth?.trend ?? r?.depth_trend ?? null
}
function tempoTrend(r) {
  return r?.analysis?.tempo?.trend ?? r?.tempo_trend ?? null
}
function setScore(r) {
  const v = r?.set_score ?? r?.score ?? null
  return v == null ? null : Number(v)
}
function repsCompleted(r) {
  const v = r?.total_reps ?? r?.reps_completed ?? r?.reps ?? null
  return v == null ? null : Number(v)
}
function repTarget(r) {
  const v = r?.rep_target ?? r?.target_reps ?? null
  return v == null ? null : Number(v)
}
function targetDepth(r) {
  const v = r?.target_depth_deg ?? null
  return v == null ? null : Number(v)
}
function fatigue(r) {
  // In-memory summaries carry a string signal; BQ rows carry a numeric score.
  if (r?.fatigue_signal != null) return r.fatigue_signal
  const score = r?.fatigue_score
  if (score != null) {
    const n = Number(score)
    if (n >= 0.66) return "high"
    if (n >= 0.33) return "moderate"
    return "none"
  }
  return null
}
// Label for the X axis: a date for sessions, else "Set N".
function pointLabel(r, i, mode) {
  if (mode === "sessions") {
    const ts = r?.started_at
    if (ts) {
      const d = new Date(ts)
      if (!Number.isNaN(d.getTime())) {
        return d.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      }
    }
    return `Session ${i + 1}`
  }
  const v = r?.set_index
  return `Set ${v == null ? i + 1 : Number(v)}`
}
// A session counts as adherent if its boolean flag is true; a set counts when
// reps met the target. Returns "done" | "partial" | "missed".
function adherenceStatus(r, mode) {
  if (mode === "sessions") {
    return r?.adherence_flag ? "done" : "partial"
  }
  const done = repsCompleted(r)
  const tgt = repTarget(r)
  if (done == null || tgt == null || tgt === 0) return "partial"
  if (done >= tgt) return "done"
  if (done <= 0) return "missed"
  return "partial"
}

// ── SVG line chart (depth over time, real data) ──────────────────────
function DepthTrendChart({ rows, mode }) {
  const w = 600
  const h = 200
  const pad = { t: 24, r: 16, b: 28, l: 36 }
  const cw = w - pad.l - pad.r
  const ch = h - pad.t - pad.b

  const depthPts = rows
    .map((r, i) => ({ i, deg: depthMean(r) }))
    .filter((p) => p.deg != null)

  if (depthPts.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-sm text-ink-faint">
        No depth data to chart yet.
      </div>
    )
  }

  const xStep = depthPts.length > 1 ? cw / (depthPts.length - 1) : 0
  // Clamp into the visible band so outliers stay on-chart.
  const clamp = (v) => Math.min(CHART_MAX, Math.max(CHART_MIN, v))
  // Inverted: lower degree = higher on chart (improvement rises).
  const yScale = (deg) => pad.t + ((clamp(deg) - CHART_MIN) / (CHART_MAX - CHART_MIN)) * ch
  const targetDeg =
    targetDepth(rows[rows.length - 1]) ?? targetDepth(rows[0]) ?? TARGET_DEG
  const targetY = yScale(targetDeg)

  const points = depthPts.map((p, idx) => ({
    x: pad.l + (depthPts.length > 1 ? idx * xStep : cw / 2),
    y: yScale(p.deg),
    label: pointLabel(rows[p.i], p.i, mode),
    score: setScore(rows[p.i]),
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
        {Math.round(targetDeg)}° target
      </text>

      {/* Area fill */}
      <path d={areaPath} fill="var(--color-brand)" opacity="0.08" />

      {/* Line */}
      <path d={linePath} fill="none" stroke="var(--color-brand)" strokeWidth="2" />

      {/* Dots — colored by per-set score when available */}
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r="3"
          fill={p.score != null && p.score < 60 ? "var(--color-warn)" : "var(--color-brand)"}
        >
          <title>{`${p.label}${p.score != null ? ` · score ${Math.round(p.score)}` : ""} · ${Math.round(depthPts[i].deg)}°`}</title>
        </circle>
      ))}

      {/* X labels (every point if few, else thinned) */}
      {points.map((p, i) => {
        const every = points.length > 8 ? Math.ceil(points.length / 8) : 1
        return i % every === 0 ? (
          <text key={i} x={p.x} y={h - 4} fontSize="9" fill="var(--color-ink-faint)" textAnchor="middle">
            {p.label}
          </text>
        ) : null
      })}

      {/* Y labels */}
      {[90, 100, 110, 120].map((deg) => (
        <text key={deg} x={pad.l - 6} y={yScale(deg) + 3} fontSize="9" fill="var(--color-ink-faint)" textAnchor="end">
          {deg}°
        </text>
      ))}
    </svg>
  )
}

// ── Adherence: one cell per session/set ──────────────────────────────
function AdherenceHeatmap({ rows, mode }) {
  const cells = rows.map((r, i) => {
    const status = adherenceStatus(r, mode)
    let detail
    if (mode === "sessions") {
      const sets = r?.sets_count
      const reps = repsCompleted(r)
      detail = `${sets != null ? `${sets} sets` : ""}${reps != null ? ` · ${reps} reps` : ""}`.trim() || "—"
    } else {
      const done = repsCompleted(r)
      const tgt = repTarget(r)
      detail = done != null && tgt != null ? `${done}/${tgt} reps` : "—"
    }
    return { status, label: pointLabel(r, i, mode), detail }
  })

  const cellColor = { done: "bg-ok", partial: "bg-warn", missed: "bg-warn" }

  // Chunk into rows of 7 to reuse the week-grid layout.
  const perRow = 7
  const grid = []
  for (let i = 0; i < cells.length; i += perRow) grid.push(cells.slice(i, i + perRow))

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        {grid.map((week, wi) => (
          <div key={wi} className="flex items-center gap-1.5">
            <span className="text-[10px] text-ink-faint w-10 shrink-0">
              {wi * perRow + 1}–{Math.min((wi + 1) * perRow, cells.length)}
            </span>
            {week.map((cell, di) => (
              <div
                key={di}
                className={`w-8 h-8 rounded ${cellColor[cell.status]} flex items-center justify-center`}
                title={`${cell.label}: ${cell.detail} (${cell.status})`}
              >
                {cell.status === "done" && <i className="ti ti-check text-white text-xs" />}
                {cell.status === "partial" && <span className="text-white text-[9px] font-medium">½</span>}
                {cell.status === "missed" && <i className="ti ti-x text-white text-xs" />}
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* Legend */}
      <div className="flex items-center gap-4 text-[10px] text-ink-faint">
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-ok" /> {mode === "sessions" ? "Completed session" : "Completed"}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-3 h-3 rounded bg-warn" /> {mode === "sessions" ? "Incomplete session" : "Partial / missed"}
        </span>
      </div>
    </div>
  )
}

// ── Derive flagged patterns from real signals (set-level only) ────────
function deriveFlags(rows, mode) {
  if (mode === "sessions") return [] // session rows don't carry per-rep signals
  const flags = []
  rows.forEach((r, i) => {
    const n = r?.set_index == null ? i + 1 : Number(r.set_index)
    const f = fatigue(r)
    if (f && f !== "none") {
      flags.push({ text: `Fatigue signal "${f}" detected in set ${n}`, set: n })
    }
    const hr = hitRate(r)
    if (hr != null && hr < 0.7) {
      flags.push({
        text: `Only ${Math.round(hr * 100)}% of reps hit target depth in set ${n}`,
        set: n,
      })
    }
    if (depthTrend(r) === "declining_late") {
      flags.push({ text: `Depth declined toward the end of set ${n}`, set: n })
    }
    if (tempoTrend(r) === "slowing_down") {
      flags.push({ text: `Tempo slowed through set ${n}`, set: n })
    }
  })
  return flags
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
export default function ClinicianView() {
  const [toast, setToast] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [rows, setRows] = useState([])          // chart/adherence source
  const [mode, setMode] = useState("sets")      // "sessions" | "sets"
  const [sourceLabel, setSourceLabel] = useState("")
  const [progressReport, setProgressReport] = useState("") // Gemini #3 cross-session
  const [profile, setProfile] = useState(null)
  const [exerciseName, setExerciseName] = useState(null)
  const [sessionId, setSessionId] = useState(null)

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }, [])

  const handleExport = useCallback(() => {
    window.print()
  }, [])

  const handleShare = useCallback(async () => {
    if (!sessionId) {
      showToast("No active session to share yet")
      return
    }
    const url = `${window.location.origin}/share/${sessionId}`
    try {
      await navigator.clipboard.writeText(url)
      showToast("Handoff link copied to clipboard")
    } catch {
      window.prompt("Copy this clinician handoff link:", url)
    }
  }, [sessionId, showToast])

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)

      // 1) PREFER cross-session history from BigQuery (the real PT product value):
      //    per-session ROM/adherence trend + the Gemini progress report.
      let overview = null
      try {
        const res = await fetch("/pt/overview")
        if (res.ok) overview = await res.json()
      } catch {
        /* fall through to set-level */
      }

      // 2) Fallback source: recent sets (single-session granularity).
      let recent = null
      let bqSets = false
      try {
        const res = await fetch("/sets/recent?limit=50")
        if (res.ok) {
          const data = await res.json()
          bqSets = !!data.bq_available
          if (Array.isArray(data.rows)) recent = data.rows
        }
      } catch {
        /* fall through to /session */
      }

      let session = null
      try {
        const res = await fetch("/session")
        if (res.ok) session = await res.json()
      } catch {
        /* may be unavailable */
      }

      // The active PT prescription (patient name, condition, sets/reps/depth).
      try {
        const res = await fetch("/profile")
        if (res.ok) {
          const data = await res.json()
          if (!cancelled && data?.profile) setProfile(data.profile)
        }
      } catch {
        /* fall back to defaults in the render */
      }

      // The exercise currently installed on the tracker.
      try {
        const res = await fetch("/exercises")
        if (res.ok) {
          const data = await res.json()
          const active = (data?.exercises || []).find((e) => e.id === data?.active)
          if (!cancelled && active?.display_name) setExerciseName(active.display_name)
        }
      } catch {
        /* prescription line falls back to a generic label */
      }

      if (cancelled) return

      if (session?.session_id) setSessionId(session.session_id)

      // Decide which list drives the views. Session history wins when present.
      let chosen = []
      let chosenMode = "sets"
      let label = ""
      if (overview && Array.isArray(overview.sessions) && overview.sessions.length > 0) {
        chosen = overview.sessions // already oldest→newest
        chosenMode = "sessions"
        label = "cross-session history"
      } else if (bqSets && Array.isArray(recent) && recent.length > 0) {
        chosen = [...recent].reverse() // BQ rows newest-first; show oldest→newest
        label = "recent sets"
      } else if (session && Array.isArray(session.summaries) && session.summaries.length > 0) {
        chosen = session.summaries
        label = "current session"
      } else if (Array.isArray(recent) && recent.length > 0) {
        chosen = [...recent].reverse()
        label = "recent sets"
      }

      setRows(chosen)
      setMode(chosenMode)
      setSourceLabel(label)
      // Gemini #3 progress report — always text from the backend (templated fallback).
      setProgressReport(overview?.progress_report || "")

      if (!chosen.length && !overview && recent == null && session == null) {
        setError("Could not reach the session backend.")
      }
      setLoading(false)
    }

    load()
    return () => { cancelled = true }
  }, [])

  // ── Derived aggregates for stat tiles ──────────────────────────────
  const depths = rows.map(depthMean).filter((v) => v != null)
  const firstDepth = depths.length ? depths[0] : null
  const lastDepth = depths.length ? depths[depths.length - 1] : null
  const romGain = firstDepth != null && lastDepth != null ? Math.round(firstDepth - lastDepth) : null
  const tgt = targetDepth(rows[rows.length - 1]) ?? TARGET_DEG
  const toTarget = lastDepth != null ? Math.max(0, Math.round(lastDepth - tgt)) : null

  const completedCount = rows.filter((r) => adherenceStatus(r, mode) === "done").length
  const adherencePct = rows.length ? Math.round((completedCount / rows.length) * 100) : null

  const flags = deriveFlags(rows, mode)
  const hasData = rows.length > 0
  const unit = mode === "sessions" ? "Sessions" : "Sets"

  // ── Patient + prescription, from the real active profile ────────────
  const patientName = profile?.patient_name || "Patient"
  const initials =
    patientName
      .split(/\s+/)
      .map((w) => w[0])
      .filter(Boolean)
      .slice(0, 2)
      .join("")
      .toUpperCase() || "PT"
  const condition = profile?.condition || ""
  const fromPT = profile?.source === "parsed" || profile?.source === "uploaded"
  const rxName = exerciseName || "Bodyweight squat"
  const rxSets = profile?.sets ?? 3
  const rxReps = profile?.reps_per_set ?? repTarget(rows[0]) ?? 10
  const rxDepth = profile?.depth_deg != null ? Math.round(profile.depth_deg) : Math.round(tgt)
  const rxTempo = profile?.tempo_sec ?? null
  const rxFocus = profile?.focus || ""

  return (
    <div className="flex flex-col gap-4">
      {/* Action buttons row */}
      <div className="flex items-center justify-end gap-3">
        <GhostButton onClick={handleExport}>
          <i className="ti ti-file-export text-base" />
          Export PDF
        </GhostButton>
        <PrimaryButton onClick={handleShare}>
          <i className="ti ti-send text-base" />
          Share with PT
        </PrimaryButton>
      </div>

      {/* Patient bar */}
      <Card className="flex items-center gap-4">
        <div className="w-11 h-11 rounded-full bg-brand-bg text-brand flex items-center justify-center text-sm font-semibold shrink-0">
          {initials}
        </div>
        <div className="flex-1">
          <h2 className="text-base font-semibold text-ink">{patientName}</h2>
          <p className="text-xs text-ink-soft mt-0.5">
            {condition || "No condition on file"}
          </p>
        </div>
        {sourceLabel && (
          <Pill variant="brand">{sourceLabel}</Pill>
        )}
      </Card>

      {loading ? (
        <Card className="flex items-center justify-center py-10 text-sm text-ink-faint">
          <i className="ti ti-loader-2 animate-spin mr-2" />
          Loading session data…
        </Card>
      ) : !hasData ? (
        <Card className="flex flex-col items-center justify-center py-12 gap-2 text-center">
          <i className="ti ti-clipboard-off text-ink-faint text-2xl" />
          <p className="text-sm font-medium text-ink">No history yet</p>
          <p className="text-xs text-ink-soft">
            {error
              ? error
              : "Completed sessions will appear here once a workout is recorded."}
          </p>
        </Card>
      ) : (
        <>
          {/* Stat tiles */}
          <div className="grid grid-cols-4 gap-3">
            <Card>
              <MetricTile
                label="Adherence"
                value={adherencePct != null ? adherencePct : "—"}
                unit={adherencePct != null ? "%" : ""}
              />
            </Card>
            <Card>
              <MetricTile label={unit} value={rows.length} />
            </Card>
            <Card>
              <span className="text-xs text-ink-faint uppercase tracking-wide">ROM gain</span>
              <span
                className={`text-2xl font-semibold tabular-nums ${
                  romGain != null && romGain > 0 ? "text-ok" : "text-ink"
                }`}
              >
                {romGain != null ? `${romGain > 0 ? "+" : ""}${romGain}°` : "—"}
              </span>
            </Card>
            <Card>
              <MetricTile
                label="To target"
                value={toTarget != null ? toTarget : "—"}
                unit={toTarget != null ? "°" : ""}
              />
            </Card>
          </div>

          {/* Depth trend chart */}
          <Card>
            <h3 className="text-sm font-medium text-ink mb-3">
              {mode === "sessions" ? "Range-of-motion trend (per session)" : "Squat depth trend"}
            </h3>
            <DepthTrendChart rows={rows} mode={mode} />
          </Card>

          {/* Adherence heatmap */}
          <Card>
            <h3 className="text-sm font-medium text-ink mb-3">Adherence</h3>
            <AdherenceHeatmap rows={rows} mode={mode} />
          </Card>

          {/* Progress report — Gemini #3 cross-session, with computed fallback */}
          <Card>
            <div className="flex items-center gap-2 mb-3">
              <i className="ti ti-sparkles text-brand text-lg" />
              <h3 className="text-sm font-medium text-ink">Progress report</h3>
              {progressReport && mode === "sessions" && (
                <Pill variant="brand">AI · cross-session</Pill>
              )}
            </div>
            {progressReport ? (
              <p className="text-sm text-ink-soft leading-relaxed mb-4 whitespace-pre-line">
                {progressReport}
              </p>
            ) : (
              <p className="text-sm text-ink-soft leading-relaxed mb-4">
                {rows.length} {unit.toLowerCase()} recorded
                {sourceLabel ? ` (${sourceLabel})` : ""}.{" "}
                {romGain != null && firstDepth != null && lastDepth != null
                  ? `Average squat depth moved from ${Math.round(firstDepth)}° to ${Math.round(
                      lastDepth
                    )}°, a change of ${romGain > 0 ? "+" : ""}${romGain}° toward the ${Math.round(
                      tgt
                    )}° target. `
                  : ""}
                {adherencePct != null
                  ? `${completedCount} of ${rows.length} ${unit.toLowerCase()} met the prescription (${adherencePct}% adherence). `
                  : ""}
                {flags.length
                  ? "Flagged patterns below highlight sets that may warrant attention."
                  : "No notable issues were flagged."}
              </p>
            )}
            {progressReport && mode === "sessions" && (
              <p className="flex items-center gap-1.5 text-[11px] text-ink-faint mb-4">
                <i className="ti ti-sparkles text-xs" />
                Generated by Gemini 2.5 Flash over your BigQuery session history
              </p>
            )}
            {mode !== "sessions" && (
              <>
                <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wide mb-2">
                  Flagged patterns
                </h4>
                {flags.length ? (
                  <ul className="flex flex-col gap-2">
                    {flags.map((f, i) => (
                      <li key={i} className="flex items-center gap-2 text-sm text-ink-soft">
                        <i className="ti ti-alert-circle text-warn text-sm shrink-0" />
                        <span className="flex-1">{f.text}</span>
                        <Pill variant="warn">Set {f.set}</Pill>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-soft">No patterns flagged.</p>
                )}
              </>
            )}
          </Card>

          {/* Current prescription */}
          <Card className="flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <h3 className="text-sm font-medium text-ink">Current prescription</h3>
                <Pill variant="brand">{fromPT ? "set by PT" : "demo profile"}</Pill>
              </div>
              <p className="text-sm text-ink-soft">
                {rxName} · {rxSets} sets × {rxReps} · target {rxDepth}°
                {rxTempo != null ? ` · ${rxTempo}s tempo` : ""}
              </p>
              {rxFocus && (
                <p className="text-xs text-ink-faint mt-1">Focus: {rxFocus}</p>
              )}
            </div>
            <i className="ti ti-lock text-ink-faint text-lg mt-0.5" />
          </Card>
        </>
      )}

      {/* Toast */}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  )
}
