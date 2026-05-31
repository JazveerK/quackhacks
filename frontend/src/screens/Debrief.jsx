import { useState, useEffect, useRef } from "react"
import Card from "../components/Card"
import GhostButton from "../components/GhostButton"
import PrimaryButton from "../components/PrimaryButton"
import MetricTile from "../components/MetricTile"
import Pill from "../components/Pill"
import { useDebriefAudio } from "../coach/useDebriefAudio"
import { useSession } from "../SocketContext"

// ── Helpers ──────────────────────────────────────────────────────────
const avg = (arr) =>
  arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0

function friendlyTrend(t) {
  if (t === "speeding_up") return "Speeding up"
  if (t === "slowing_down") return "Slowing down"
  if (t === "deepening" || t === "improving") return "Deepening"
  if (t === "shallowing" || t === "declining") return "Shallowing"
  if (t === "steady" || t === "stable") return "Steady"
  return t || "Steady"
}

function friendlyFatigue(f) {
  if (!f || f === "none") return "None detected"
  const m = String(f).match(/(\d+)/)
  return m ? `Smoothness dropped ${m[1]}%` : String(f).replace(/_/g, " ")
}

function pct1(ratio) {
  if (ratio == null) return null
  return Math.round(ratio * 100)
}

// ── Main Debrief screen ──────────────────────────────────────────────
export default function Debrief({ setScreen }) {
  const { summary, aiDebrief, send, setSummary } = useSession()
  const [showClinical, setShowClinical] = useState(false)
  const { audioState, play, stop } = useDebriefAudio()
  const clinicalRef = useRef(null)

  // Animate clinical section open
  useEffect(() => {
    if (!clinicalRef.current) return
    const el = clinicalRef.current
    if (showClinical) {
      el.style.maxHeight = el.scrollHeight + "px"
      el.style.opacity = "1"
    } else {
      el.style.maxHeight = "0px"
      el.style.opacity = "0"
    }
  }, [showClinical])

  // ── Empty state ─────────────────────────────────────────
  if (!summary) {
    return (
      <div className="flex flex-col gap-4">
        <Card soft className="flex flex-col items-center text-center gap-3 py-10">
          <div className="w-12 h-12 rounded-full bg-brand-bg text-brand flex items-center justify-center">
            <i className="ti ti-clipboard-list text-xl" />
          </div>
          <h2 className="text-base font-semibold text-ink">
            No set yet — finish a set to see your debrief
          </h2>
          <p className="text-sm text-ink-soft max-w-xs leading-relaxed">
            Complete a set in your live session and your personalised coach
            debrief will appear here.
          </p>
          <PrimaryButton onClick={() => setScreen("live")} arrow>
            Go to live session
          </PrimaryButton>
        </Card>
      </div>
    )
  }

  // ── Derive everything from the real summary ─────────────
  const ui = summary.exercise_ui || {}
  const displayName = ui.display_name || "exercise"
  const plural = ui.plural || displayName + "s"
  const romMetric = ui.rom_metric // 'max' | 'min' | undefined

  const depths = Array.isArray(summary.rep_depths_deg)
    ? summary.rep_depths_deg
    : []
  const targetDepth = summary.target_depth_deg

  // Direction-aware "reached target"
  const reachedTarget = (deg) => {
    if (targetDepth == null) return false
    return romMetric === "max" ? deg >= targetDepth : deg <= targetDepth
  }
  const okCount = depths.filter(reachedTarget).length
  const warnCount = depths.length - okCount

  const analysis = summary.analysis || {}
  const aDepth = analysis.depth || {}
  const aTempo = analysis.tempo || {}
  const aForm = analysis.form || {}
  const aTracking = analysis.tracking || {}

  // For the bar chart, "best" depends on direction.
  const avgDepth = aDepth.mean_deg != null ? Math.round(aDepth.mean_deg) : avg(depths)
  const bestDepth =
    romMetric === "max"
      ? aDepth.max_deg != null
        ? Math.round(aDepth.max_deg)
        : depths.length
          ? Math.max(...depths)
          : 0
      : aDepth.min_deg != null
        ? Math.round(aDepth.min_deg)
        : depths.length
          ? Math.min(...depths)
          : 0
  const depthRange =
    depths.length ? Math.max(...depths) - Math.min(...depths) : 0
  const maxBar = depths.length
    ? Math.max(...depths, (targetDepth || 0) + 10)
    : (targetDepth || 0) + 10

  const repsCompleted = summary.reps_completed ?? depths.length

  // Coach text: AI debrief, falling back to summary fields.
  const coachText =
    aiDebrief?.text || summary.ai_debrief || summary.templated_debrief || ""

  const score = summary.score || {}

  const cameraPct = pct1(aTracking.camera_frame_ratio)
  const imuPct = pct1(aTracking.imu_frame_ratio)

  const formNotes = Array.isArray(aForm.notes) ? aForm.notes : []
  const flagCounts = aForm.flag_counts || {}

  // ── Rep dot row ───────────────────────────────────────
  const renderRepDots = () => (
    <div className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap justify-center gap-2">
        {depths.map((deg, i) => {
          const ok = reachedTarget(deg)
          return (
            <div key={i} className="flex flex-col items-center gap-1">
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center ${
                  ok ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"
                }`}
              >
                <i className={`ti ${ok ? "ti-check" : "ti-minus"} text-sm`} />
              </div>
              <span className="text-[10px] text-ink-faint">{i + 1}</span>
            </div>
          )
        })}
      </div>
      <div className="flex items-center gap-5 text-xs text-ink-soft">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-ok-bg border border-ok/30" />
          Reached your goal
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-warn-bg border border-warn/30" />
          A little short
        </span>
      </div>
    </div>
  )

  // ── "How it went" plain-language items ────────────────
  const renderHowItWent = () => {
    const items = []
    items.push({
      icon: "ti-circle-check",
      color: "text-ok",
      bg: "bg-ok-bg",
      text: `You hit your target depth on ${okCount} out of ${repsCompleted} reps.`,
    })
    if (warnCount > 0) {
      items.push({
        icon: "ti-alert-circle",
        color: "text-warn",
        bg: "bg-warn-bg",
        text: `${warnCount} ${warnCount === 1 ? "rep was" : "reps were"} a little short of target.`,
      })
    }
    if (summary.depth_trend && summary.depth_trend !== "steady") {
      items.push({
        icon: "ti-activity",
        color: "text-brand",
        bg: "bg-brand-bg",
        text: `Your depth was ${friendlyTrend(summary.depth_trend).toLowerCase()} across the set.`,
      })
    }
    if (summary.fatigue_signal && summary.fatigue_signal !== "none") {
      items.push({
        icon: "ti-info-circle",
        color: "text-brand",
        bg: "bg-brand-bg",
        text: "Some fatigue was detected — your PT may want to take a look.",
      })
    }
    // Surface AI / templated form notes (cap at a couple)
    formNotes.slice(0, 2).forEach((note) =>
      items.push({
        icon: "ti-message-2",
        color: "text-brand",
        bg: "bg-brand-bg",
        text: note,
      }),
    )

    return (
      <ul className="flex flex-col gap-3">
        {items.map((it, i) => (
          <li key={i} className="flex items-start gap-3">
            <div
              className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 ${it.bg}`}
            >
              <i className={`ti ${it.icon} text-sm ${it.color}`} />
            </div>
            <span className="text-sm text-ink-soft leading-snug">{it.text}</span>
          </li>
        ))}
      </ul>
    )
  }

  // ── Clinical depth chart ──────────────────────────────
  const renderDepthBarChart = () => (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wide">
        Per-rep depth
      </h4>
      <div className="relative flex items-end gap-1.5 h-40 pt-4">
        {targetDepth != null && (
          <div
            className="absolute left-0 right-0 border-t border-dashed border-brand/40 z-10"
            style={{ bottom: `${(targetDepth / maxBar) * 100}%` }}
          >
            <span className="absolute -top-4 right-0 text-[10px] text-brand">
              {targetDepth}° target
            </span>
          </div>
        )}
        {depths.map((deg, i) => {
          const ok = reachedTarget(deg)
          const pct = (deg / maxBar) * 100
          return (
            <div key={i} className="flex-1 flex flex-col items-center gap-1">
              <span className="text-[10px] text-ink-faint">{deg}°</span>
              <div
                className={`w-full rounded-t ${ok ? "bg-ok" : "bg-warn"}`}
                style={{ height: `${pct}%` }}
              />
              <span className="text-[10px] text-ink-faint">{i + 1}</span>
            </div>
          )
        })}
      </div>
    </div>
  )

  // ── Clinical metric grid ──────────────────────────────
  const renderClinicalMetrics = () => (
    <div className="grid grid-cols-3 gap-4">
      <MetricTile label="Avg depth" value={avgDepth} unit="°" />
      <MetricTile label="Best depth" value={bestDepth} unit="°" />
      <MetricTile label="Depth range" value={depthRange} unit="°" />
      <MetricTile
        label="Avg descent"
        value={aTempo.mean_sec != null ? aTempo.mean_sec.toFixed(1) : "—"}
        unit={aTempo.mean_sec != null ? "s" : undefined}
      />
      <MetricTile label="Tempo trend" value={friendlyTrend(aTempo.trend)} />
      <MetricTile
        label="Fatigue signal"
        value={friendlyFatigue(summary.fatigue_signal)}
      />
    </div>
  )

  // ── Source bar ────────────────────────────────────────
  const renderSourceBar = () => {
    if (cameraPct == null && imuPct == null) return null
    const cam = cameraPct ?? 100 - (imuPct ?? 0)
    const imu = imuPct ?? 100 - cam
    return (
      <div className="flex flex-col gap-2">
        <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wide">
          Tracking source
        </h4>
        <div className="flex h-4 rounded-full overflow-hidden">
          <div className="bg-brand" style={{ width: `${cam}%` }} />
          <div className="bg-warn" style={{ width: `${imu}%` }} />
        </div>
        <div className="flex justify-between text-[10px] text-ink-faint">
          <span>Camera {cam}%</span>
          <span>IMU {imu}%</span>
        </div>
      </div>
    )
  }

  const headline = score.headline || "Nice work."

  return (
    <div className="flex flex-col gap-4">
      {/* ── Coach card ─────────────────────────────────────── */}
      <Card soft>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-brand-bg text-brand flex items-center justify-center shrink-0">
            <i className="ti ti-activity text-lg" />
          </div>
          <div className="flex flex-col gap-2 flex-1">
            <h2 className="text-base font-semibold text-ink">{headline}</h2>
            <p className="text-sm text-ink-soft leading-relaxed">{coachText}</p>
            <div className="flex items-center gap-3">
              <GhostButton
                onClick={() =>
                  audioState === "playing" ? stop() : play(coachText)
                }
                disabled={!coachText}
              >
                <i
                  className={`ti ti-${audioState === "playing" ? "player-pause" : "volume"} text-base`}
                />
                {audioState === "loading"
                  ? "Loading…"
                  : audioState === "playing"
                    ? "Pause"
                    : "Play debrief"}
              </GhostButton>
            </div>
          </div>
        </div>
      </Card>

      {/* ── Rep dots card ──────────────────────────────────── */}
      <Card>
        <h3 className="text-sm font-medium text-ink mb-3">
          Your {repsCompleted} {plural}
        </h3>
        {renderRepDots()}
      </Card>

      {/* ── How it went card ───────────────────────────────── */}
      <Card>
        <h3 className="text-sm font-medium text-ink mb-3">How it went</h3>
        {renderHowItWent()}
      </Card>

      {/* ── PT flag ────────────────────────────────────────── */}
      {(summary.fatigue_signal && summary.fatigue_signal !== "none") && (
        <div className="flex items-start gap-3 rounded-lg bg-brand-bg p-4">
          <i className="ti ti-message-circle text-brand text-lg shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-brand">
              Worth telling your PT
            </span>
            <span className="text-sm text-ink-soft leading-relaxed">
              We noticed some fatigue toward the end of your set. It's nothing to
              worry about — just something your physiotherapist might find useful
              to know about.
            </span>
          </div>
        </div>
      )}

      {/* ── Next set action bar ────────────────────────────── */}
      <Card soft className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-ink">
            {repsCompleted < (summary.rep_target ?? repsCompleted)
              ? "Pick up where you left off"
              : "Ready for another set?"}
          </h3>
          <p className="text-xs text-ink-soft mt-0.5">
            Rest as long as you need, then jump back in.
          </p>
        </div>
        <PrimaryButton
          onClick={() => {
            send?.({ cmd: "reset_set" })
            setSummary?.(null)
            setScreen("live")
          }}
          arrow
        >
          Next set
        </PrimaryButton>
      </Card>

      {/* ── Secondary actions ──────────────────────────────── */}
      <div className="flex items-center justify-center gap-3">
        <GhostButton onClick={() => setScreen("clinician")}>
          <i className="ti ti-chart-line text-base" />
          View trends
        </GhostButton>
        <GhostButton onClick={() => setScreen("checkin")}>
          <i className="ti ti-door-exit text-base" />
          End session
        </GhostButton>
      </div>

      {/* ── Clinical toggle ────────────────────────────────── */}
      <div className="flex justify-center">
        <GhostButton onClick={() => setShowClinical((v) => !v)}>
          <i className="ti ti-stethoscope text-base" />
          {showClinical ? "Hide clinical details" : "Show clinical details"}
        </GhostButton>
      </div>

      {/* ── Clinical section (collapsible) ─────────────────── */}
      <div
        ref={clinicalRef}
        className="overflow-hidden transition-all duration-300 ease-in-out"
        style={{ maxHeight: 0, opacity: 0 }}
      >
        <div className="flex flex-col gap-4 pt-1">
          <Card>
            {renderDepthBarChart()}
          </Card>

          <Card>
            <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wide mb-3">
              Metrics
            </h4>
            {renderClinicalMetrics()}
          </Card>

          <Card>
            {renderSourceBar()}
          </Card>

          <Card>
            <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wide mb-3">
              Form flags
            </h4>
            <div className="flex flex-wrap gap-2">
              {warnCount > 0 && (
                <Pill variant="warn">
                  <i className="ti ti-alert-triangle text-xs" />
                  short · {warnCount} reps
                </Pill>
              )}
              {aTempo.trend && aTempo.trend !== "steady" && (
                <Pill variant="warn">
                  <i className="ti ti-clock text-xs" />
                  tempo · {friendlyTrend(aTempo.trend).toLowerCase()}
                </Pill>
              )}
              {Object.entries(flagCounts).map(([flag, count]) =>
                count ? (
                  <Pill key={flag} variant="brand">
                    <i className="ti ti-flag text-xs" />
                    {flag.replace(/_/g, " ")} · {count}
                  </Pill>
                ) : null,
              )}
              {summary.fatigue_signal && summary.fatigue_signal !== "none" && (
                <Pill variant="brand">
                  <i className="ti ti-trending-down text-xs" />
                  fatigue · {friendlyFatigue(summary.fatigue_signal).toLowerCase()}
                </Pill>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
