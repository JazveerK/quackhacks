import { useState, useEffect, useRef, useCallback } from "react"
import Card from "../components/Card"
import Chip from "../components/Chip"
import GhostButton from "../components/GhostButton"
import PrimaryButton from "../components/PrimaryButton"

// ── Speech recognition (on-device only) ──────────────────────────────
const SR = typeof window !== "undefined"
  ? window.SpeechRecognition || window.webkitSpeechRecognition
  : null

// ══════════════════════════════════════════════════════════════════════
//  CHECK-IN FLOW
// ══════════════════════════════════════════════════════════════════════

const PAIN_OPTIONS = ["None", "Mild", "Moderate", "Sharp"]
const READY_OPTIONS = ["Yes, let's go", "Give me a minute"]

function CheckInFlow({ setScreen, switchToIntake, micAvailable }) {
  const [kneeScore, setKneeScore] = useState(null)
  const [pain, setPain] = useState(null)
  const [ready, setReady] = useState(null)
  const [listening, setListening] = useState(false)
  const recRef = useRef(null)

  // Which question is "active" (first unanswered)
  const activeQ = kneeScore == null ? 1 : pain == null ? 2 : ready == null ? 3 : 3

  // ── Mic toggle ───────────────────────────────────────────────────
  const toggleMic = useCallback(() => {
    if (!micAvailable || !SR) return
    if (listening) {
      recRef.current?.stop()
      setListening(false)
      return
    }
    const rec = new SR()
    rec.lang = "en-US"
    rec.continuous = false
    rec.interimResults = false
    recRef.current = rec

    rec.onresult = (e) => {
      const t = e.results[0][0].transcript.toLowerCase()
      // Q1: number 1-10
      const num = parseInt(t.replace(/\D/g, ""), 10)
      if (kneeScore == null && num >= 1 && num <= 10) {
        setKneeScore(num)
      }
      // Q2: pain
      if (pain == null) {
        const match = PAIN_OPTIONS.find((o) => t.includes(o.toLowerCase()))
        if (match) setPain(match)
      }
      // Q3: ready
      if (ready == null) {
        if (t.includes("yes") || t.includes("let's go")) setReady(READY_OPTIONS[0])
        else if (t.includes("minute") || t.includes("wait")) setReady(READY_OPTIONS[1])
      }
      setListening(false)
    }
    rec.onerror = () => setListening(false)
    rec.onend = () => setListening(false)
    rec.start()
    setListening(true)
  }, [listening, micAvailable, kneeScore, pain, ready])

  useEffect(() => {
    return () => recRef.current?.abort()
  }, [])

  function qBadge(n) {
    if (
      (n === 1 && kneeScore != null) ||
      (n === 2 && pain != null) ||
      (n === 3 && ready != null)
    ) {
      return (
        <span className="w-6 h-6 rounded-full bg-ok-bg text-ok flex items-center justify-center text-xs">
          <i className="ti ti-check text-sm" />
        </span>
      )
    }
    const active = n === activeQ
    return (
      <span
        className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium ${
          active ? "bg-brand text-white" : "bg-surface text-ink-faint"
        }`}
      >
        {n}
      </span>
    )
  }

  const cardBorder = (n) =>
    n === activeQ ? "ring-1 ring-brand" : ""

  return (
    <div className="flex flex-col gap-4">
      {/* Header area */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Hi again.</h2>
          <p className="text-sm text-ink-soft mt-1 max-w-md">
            Quick check before we start — tap an answer, or use the mic to speak.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleMic}
          disabled={!micAvailable}
          title={micAvailable ? (listening ? "Listening…" : "Tap to speak") : "On-device speech not available"}
          className={`relative w-10 h-10 rounded-full flex items-center justify-center transition-colors ${
            listening
              ? "bg-brand text-white"
              : micAvailable
                ? "bg-surface text-ink-soft hover:text-ink"
                : "bg-surface text-ink-faint cursor-not-allowed opacity-50"
          }`}
        >
          <i className="ti ti-microphone text-lg" />
          {listening && (
            <span className="absolute inset-0 rounded-full border-2 border-brand animate-ping" />
          )}
        </button>
      </div>

      {/* Q1 — Knee score */}
      <Card className={cardBorder(1)}>
        <div className="flex items-center gap-2 mb-3">
          {qBadge(1)}
          <h3 className="text-sm font-medium text-ink">
            How's your right knee today?
          </h3>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] text-ink-faint mr-1">Rough</span>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setKneeScore(n)}
              className={`w-8 h-8 rounded-full text-xs font-medium transition-colors ${
                kneeScore === n
                  ? "bg-brand text-white"
                  : "bg-surface text-ink-soft hover:text-ink"
              }`}
            >
              {n}
            </button>
          ))}
          <span className="text-[10px] text-ink-faint ml-1">Great</span>
        </div>
      </Card>

      {/* Q2 — Pain */}
      <Card className={cardBorder(2)}>
        <div className="flex items-center gap-2 mb-3">
          {qBadge(2)}
          <h3 className="text-sm font-medium text-ink">Any pain right now?</h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {PAIN_OPTIONS.map((opt) => (
            <Chip key={opt} selected={pain === opt} onClick={() => setPain(opt)}>
              {opt}
            </Chip>
          ))}
        </div>
      </Card>

      {/* Q3 — Ready */}
      <Card className={cardBorder(3)}>
        <div className="flex items-center gap-2 mb-3">
          {qBadge(3)}
          <h3 className="text-sm font-medium text-ink">
            Ready to start your session?
          </h3>
        </div>
        <div className="flex flex-wrap gap-2">
          {READY_OPTIONS.map((opt) => (
            <Chip key={opt} selected={ready === opt} onClick={() => setReady(opt)}>
              {opt}
            </Chip>
          ))}
        </div>
      </Card>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={switchToIntake}
          className="text-xs text-ink-faint hover:text-ink underline underline-offset-2"
        >
          First time? Set up profile
        </button>
        <PrimaryButton onClick={() => setScreen("live")} arrow>
          Start session
        </PrimaryButton>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════
//  INTAKE FLOW
// ══════════════════════════════════════════════════════════════════════

const BODY_AREAS = ["Right knee", "Left knee", "Hip", "Lower back", "Ankle", "Shoulder", "Other"]
const SITUATIONS = [
  "Recovering from surgery",
  "Sports injury",
  "Chronic pain",
  "Post-fall recovery",
  "General strength",
  "Something else",
]
const TIMELINES = ["This week", "This month", "1–3 months ago", "3–6 months ago", "Longer"]

function IntakeFlow({ switchToCheckin }) {
  const [area, setArea] = useState(null)
  const [situation, setSituation] = useState(null)
  const [timeline, setTimeline] = useState(null)
  const [ptName, setPtName] = useState("")
  const [notes, setNotes] = useState("")

  return (
    <div className="flex flex-col gap-4">
      {/* Greeting */}
      <div>
        <h2 className="text-lg font-semibold text-ink">Welcome.</h2>
        <p className="text-sm text-ink-soft mt-1 max-w-md">
          Let's get to know your situation so we can coach you better.
        </p>
      </div>

      {/* Disclaimer */}
      <div className="flex items-start gap-3 rounded-lg bg-brand-bg p-4">
        <i className="ti ti-info-circle text-brand text-lg shrink-0 mt-0.5" />
        <p className="text-sm text-ink-soft leading-relaxed">
          PhysioFusion is a coaching and tracking tool, not a substitute for your
          physical therapist. We don't diagnose or prescribe exercises.
        </p>
      </div>

      {/* Q: Body area */}
      <Card>
        <h3 className="text-sm font-medium text-ink mb-3">
          What are you working on?
        </h3>
        <div className="flex flex-wrap gap-2">
          {BODY_AREAS.map((opt) => (
            <Chip key={opt} selected={area === opt} onClick={() => setArea(opt)}>
              {opt}
            </Chip>
          ))}
        </div>
      </Card>

      {/* Q: Situation */}
      <Card>
        <h3 className="text-sm font-medium text-ink mb-3">
          What's the situation?
        </h3>
        <div className="flex flex-wrap gap-2">
          {SITUATIONS.map((opt) => (
            <Chip key={opt} selected={situation === opt} onClick={() => setSituation(opt)}>
              {opt}
            </Chip>
          ))}
        </div>
      </Card>

      {/* Q: Timeline */}
      <Card>
        <h3 className="text-sm font-medium text-ink mb-3">
          When did this start?
        </h3>
        <div className="flex flex-wrap gap-2">
          {TIMELINES.map((opt) => (
            <Chip key={opt} selected={timeline === opt} onClick={() => setTimeline(opt)}>
              {opt}
            </Chip>
          ))}
        </div>
      </Card>

      {/* Optional inputs */}
      <Card>
        <h3 className="text-sm font-medium text-ink mb-3">
          Your PT (optional)
        </h3>
        <input
          type="text"
          value={ptName}
          onChange={(e) => setPtName(e.target.value)}
          placeholder="PT name or clinic"
          className="w-full px-3 py-2 rounded-lg border border-hair bg-white text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </Card>

      <Card>
        <h3 className="text-sm font-medium text-ink mb-3">
          Anything we should know? (optional)
        </h3>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Previous surgeries, restrictions, goals…"
          rows={3}
          className="w-full px-3 py-2 rounded-lg border border-hair bg-white text-sm text-ink placeholder:text-ink-faint resize-none focus:outline-none focus:ring-1 focus:ring-brand"
        />
      </Card>

      {/* Footer */}
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={switchToCheckin}
          className="text-xs text-ink-faint hover:text-ink underline underline-offset-2"
        >
          I'll do this later
        </button>
        <PrimaryButton onClick={switchToCheckin} arrow>
          Save and start
        </PrimaryButton>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════
//  ROOT COMPONENT
// ══════════════════════════════════════════════════════════════════════

export default function CheckIn({ setScreen }) {
  const [mode, setMode] = useState("checkin")
  const [micAvailable, setMicAvailable] = useState(false)

  // Check on-device speech recognition availability
  useEffect(() => {
    if (!SR) return
    // SR.available is a newer API — guard against browsers that don't have it
    if (typeof SR.available === "function") {
      SR.available({ langs: ["en-US"], processLocally: true })
        .then((result) => {
          // result may be "available", "downloadable", or an object with .available
          const ok = result === "available" || result?.available === true
          setMicAvailable(ok)
        })
        .catch(() => setMicAvailable(false))
    } else {
      // Older browsers: SR exists but no availability check — allow it on
      // localhost/HTTPS only (required for getUserMedia/SR anyway)
      const secure =
        location.protocol === "https:" || location.hostname === "localhost"
      setMicAvailable(secure)
    }
  }, [])

  if (mode === "intake") {
    return (
      <IntakeFlow switchToCheckin={() => setMode("checkin")} />
    )
  }

  return (
    <CheckInFlow
      setScreen={setScreen}
      switchToIntake={() => setMode("intake")}
      micAvailable={micAvailable}
    />
  )
}
