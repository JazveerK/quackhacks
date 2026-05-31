import { useState, useEffect, useRef } from "react"
import AppHeader from "../components/AppHeader"
import Card from "../components/Card"
import GhostButton from "../components/GhostButton"
import PrimaryButton from "../components/PrimaryButton"
import MetricTile from "../components/MetricTile"
import Pill from "../components/Pill"
import { useDebriefAudio } from "../coach/useDebriefAudio"

const summary = {
  reps_completed: 10,
  rep_target: 10,
  rep_depths_deg: [95, 92, 90, 91, 96, 98, 101, 104, 107, 110],
  target_depth_deg: 90,
  coach_text:
    "You did all 10 squats and reached your goal on 6 of them. Your last few got a little shallower as you got tired — that's totally normal. Next time, try going down a little slower.",
  clinical_flags: {
    mobility_limited_at_deg: 112,
    tempo_trend: "speeding_up",
    fatigue_signal: "smoothness_down_22pct",
  },
}

// ── Helpers ──────────────────────────────────────────────────────────
const isOk = (deg) => deg <= summary.target_depth_deg + 1
const okCount = summary.rep_depths_deg.filter(isOk).length
const warnCount = summary.rep_depths_deg.length - okCount

const avg = (arr) => Math.round(arr.reduce((a, b) => a + b, 0) / arr.length)
const bestDepth = Math.min(...summary.rep_depths_deg)
const avgDepth = avg(summary.rep_depths_deg)
const depthRange = Math.max(...summary.rep_depths_deg) - bestDepth
const maxBar = Math.max(...summary.rep_depths_deg, summary.target_depth_deg + 10)

function friendlyTempo(t) {
  if (t === "speeding_up") return "Speeding up"
  if (t === "slowing_down") return "Slowing down"
  return "Steady"
}

function friendlyFatigue(f) {
  if (!f) return "None detected"
  const m = f.match(/(\d+)/)
  return m ? `Smoothness dropped ${m[1]}%` : f
}

// ── Rep dot row ──────────────────────────────────────────────────────
function RepDots() {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex flex-wrap justify-center gap-2">
        {summary.rep_depths_deg.map((deg, i) => {
          const ok = isOk(deg)
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
          A little shallow
        </span>
      </div>
    </div>
  )
}

// ── "How it went" plain-language items ───────────────────────────────
function HowItWent() {
  const items = [
    {
      icon: "ti-circle-check",
      color: "text-ok",
      bg: "bg-ok-bg",
      text: `You hit your target depth on ${okCount} out of ${summary.reps_completed} reps.`,
    },
    {
      icon: "ti-alert-circle",
      color: "text-warn",
      bg: "bg-warn-bg",
      text: `${warnCount} reps were a little shallow — mostly toward the end.`,
    },
    {
      icon: "ti-activity",
      color: "text-brand",
      bg: "bg-brand-bg",
      text: "Your pace picked up as the set went on — try holding a steady tempo.",
    },
    {
      icon: "ti-info-circle",
      color: "text-brand",
      bg: "bg-brand-bg",
      text: "Some stiffness was detected — your PT may want to take a look.",
    },
  ]

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

// ── Clinical depth chart ─────────────────────────────────────────────
function DepthBarChart() {
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wide">
        Per-rep depth
      </h4>
      <div className="relative flex items-end gap-1.5 h-40 pt-4">
        {/* Target line */}
        <div
          className="absolute left-0 right-0 border-t border-dashed border-brand/40 z-10"
          style={{ bottom: `${(summary.target_depth_deg / maxBar) * 100}%` }}
        >
          <span className="absolute -top-4 right-0 text-[10px] text-brand">
            {summary.target_depth_deg}° target
          </span>
        </div>
        {summary.rep_depths_deg.map((deg, i) => {
          const ok = isOk(deg)
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
}

// ── Clinical metric grid ─────────────────────────────────────────────
function ClinicalMetrics() {
  return (
    <div className="grid grid-cols-3 gap-4">
      <MetricTile label="Avg depth" value={avgDepth} unit="°" />
      <MetricTile label="Best depth" value={bestDepth} unit="°" />
      <MetricTile label="Depth range" value={depthRange} unit="°" />
      <MetricTile label="Avg descent" value="1.2" unit="s" />
      <MetricTile label="Tempo trend" value={friendlyTempo(summary.clinical_flags.tempo_trend)} />
      <MetricTile label="Fatigue signal" value={friendlyFatigue(summary.clinical_flags.fatigue_signal)} />
    </div>
  )
}

// ── Source bar ────────────────────────────────────────────────────────
function SourceBar() {
  const cameraPct = 72
  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wide">
        Tracking source
      </h4>
      <div className="flex h-4 rounded-full overflow-hidden">
        <div className="bg-brand" style={{ width: `${cameraPct}%` }} />
        <div className="bg-warn" style={{ width: `${100 - cameraPct}%` }} />
      </div>
      <div className="flex justify-between text-[10px] text-ink-faint">
        <span>Camera {cameraPct}%</span>
        <span>IMU {100 - cameraPct}%</span>
      </div>
    </div>
  )
}

// ── Main Debrief screen ──────────────────────────────────────────────
export default function Debrief({ setScreen }) {
  const [showClinical, setShowClinical] = useState(false)
  const { audioState, play, stop } = useDebriefAudio()
  const clinicalRef = useRef(null)

  // Animate clinical section open
  useEffect(() => {
    if (!clinicalRef.current) return
    if (showClinical) {
      const el = clinicalRef.current
      el.style.maxHeight = el.scrollHeight + "px"
      el.style.opacity = "1"
    } else {
      const el = clinicalRef.current
      el.style.maxHeight = "0px"
      el.style.opacity = "0"
    }
  }, [showClinical])

  return (
    <div className="flex flex-col gap-4">
      {/* ── Coach card ─────────────────────────────────────── */}
      <Card soft>
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-brand-bg text-brand flex items-center justify-center shrink-0">
            <i className="ti ti-activity text-lg" />
          </div>
          <div className="flex flex-col gap-2 flex-1">
            <h2 className="text-base font-semibold text-ink">Nice work.</h2>
            <p className="text-sm text-ink-soft leading-relaxed">
              {summary.coach_text}
            </p>
            <div className="flex items-center gap-3">
              <GhostButton
                onClick={() => audioState === "playing" ? stop() : play(summary.coach_text)}
              >
                <i className={`ti ti-${audioState === "playing" ? "player-pause" : "volume"} text-base`} />
                {audioState === "loading" ? "Loading…" : audioState === "playing" ? "Pause" : "Hear this"}
              </GhostButton>
            </div>
          </div>
        </div>
      </Card>

      {/* ── Rep dots card ──────────────────────────────────── */}
      <Card>
        <h3 className="text-sm font-medium text-ink mb-3">
          Your {summary.reps_completed} squats
        </h3>
        <RepDots />
      </Card>

      {/* ── How it went card ───────────────────────────────── */}
      <Card>
        <h3 className="text-sm font-medium text-ink mb-3">How it went</h3>
        <HowItWent />
      </Card>

      {/* ── PT flag ────────────────────────────────────────── */}
      {summary.clinical_flags.mobility_limited_at_deg && (
        <div className="flex items-start gap-3 rounded-lg bg-brand-bg p-4">
          <i className="ti ti-message-circle text-brand text-lg shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-brand">
              Worth telling your PT
            </span>
            <span className="text-sm text-ink-soft leading-relaxed">
              We noticed some stiffness that might be limiting how deep you can
              go. It's nothing to worry about — just something your
              physiotherapist might find useful to know about.
            </span>
          </div>
        </div>
      )}

      {/* ── Next set action bar ────────────────────────────── */}
      <Card soft className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium text-ink">
            One more set to go
          </h3>
          <p className="text-xs text-ink-soft mt-0.5">
            Rest as long as you need, then jump back in.
          </p>
        </div>
        <PrimaryButton onClick={() => setScreen("live")} arrow>
          Start next set
        </PrimaryButton>
      </Card>

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
            <DepthBarChart />
          </Card>

          <Card>
            <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wide mb-3">
              Metrics
            </h4>
            <ClinicalMetrics />
          </Card>

          <Card>
            <SourceBar />
          </Card>

          <Card>
            <h4 className="text-xs font-medium text-ink-faint uppercase tracking-wide mb-3">
              Form flags
            </h4>
            <div className="flex flex-wrap gap-2">
              <Pill variant="warn">
                <i className="ti ti-alert-triangle text-xs" />
                shallow · {warnCount} reps
              </Pill>
              <Pill variant="warn">
                <i className="ti ti-clock text-xs" />
                tempo · {friendlyTempo(summary.clinical_flags.tempo_trend).toLowerCase()}
              </Pill>
              <Pill variant="brand">
                <i className="ti ti-stretching text-xs" />
                mobility limited · {summary.clinical_flags.mobility_limited_at_deg}°
              </Pill>
              <Pill variant="brand">
                <i className="ti ti-trending-down text-xs" />
                fatigue · {friendlyFatigue(summary.clinical_flags.fatigue_signal).toLowerCase()}
              </Pill>
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}
