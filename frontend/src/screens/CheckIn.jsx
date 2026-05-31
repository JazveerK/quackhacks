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

  const activeQ = kneeScore == null ? 1 : pain == null ? 2 : ready == null ? 3 : 3

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
      const num = parseInt(t.replace(/\D/g, ""), 10)
      if (kneeScore == null && num >= 1 && num <= 10) setKneeScore(num)
      if (pain == null) {
        const match = PAIN_OPTIONS.find((o) => t.includes(o.toLowerCase()))
        if (match) setPain(match)
      }
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
        <span className="w-8 h-8 rounded-xl bg-ok-bg text-ok flex items-center justify-center">
          <i className="ti ti-check text-[14px]" />
        </span>
      )
    }
    const active = n === activeQ
    return (
      <span
        className={`w-8 h-8 rounded-xl flex items-center justify-center text-[13px] font-semibold ${
          active ? "bg-brand text-white" : "bg-surface text-ink-faint"
        }`}
      >
        {n}
      </span>
    )
  }

  const cardBorder = (n) =>
    n === activeQ ? "ring-2 ring-brand/30" : ""

  return (
    <>
      {/* Header area */}
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-[22px] font-bold text-ink tracking-tight">Hi again.</h2>
          <p className="text-[15px] text-ink-soft mt-1.5 max-w-md leading-relaxed">
            Quick check before we start — tap an answer, or use the mic to speak.
          </p>
        </div>
        <button
          type="button"
          onClick={toggleMic}
          disabled={!micAvailable}
          title={micAvailable ? (listening ? "Listening…" : "Tap to speak") : "On-device speech not available"}
          className={`relative w-12 h-12 rounded-2xl flex items-center justify-center transition-all duration-150 ${
            listening
              ? "bg-brand text-white"
              : micAvailable
                ? "bg-surface text-ink-soft hover:text-ink active:scale-[0.95]"
                : "bg-surface text-ink-faint cursor-not-allowed opacity-50"
          }`}
        >
          <i className="ti ti-microphone text-xl" />
          {listening && (
            <span className="absolute inset-0 rounded-2xl border-2 border-brand animate-ping" />
          )}
        </button>
      </div>

      {/* Q1 — Knee score */}
      <Card className={`transition-all duration-200 ${cardBorder(1)}`}>
        <div className="flex items-center gap-3 mb-4">
          {qBadge(1)}
          <h3 className="text-[15px] font-semibold text-ink">
            How's your right knee today?
          </h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-ink-faint font-medium mr-1">Rough</span>
          {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setKneeScore(n)}
              className={`w-9 h-9 rounded-xl text-[13px] font-semibold transition-all duration-150
                active:scale-[0.9] motion-reduce:active:scale-100 ${
                kneeScore === n
                  ? "bg-brand text-white"
                  : "bg-surface text-ink-soft hover:text-ink hover:bg-surface"
              }`}
            >
              {n}
            </button>
          ))}
          <span className="text-[12px] text-ink-faint font-medium ml-1">Great</span>
        </div>
      </Card>

      {/* Q2 — Pain */}
      <Card className={`transition-all duration-200 ${cardBorder(2)}`}>
        <div className="flex items-center gap-3 mb-4">
          {qBadge(2)}
          <h3 className="text-[15px] font-semibold text-ink">Any pain right now?</h3>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {PAIN_OPTIONS.map((opt) => (
            <Chip key={opt} selected={pain === opt} onClick={() => setPain(opt)}>
              {opt}
            </Chip>
          ))}
        </div>
      </Card>

      {/* Q3 — Ready */}
      <Card className={`transition-all duration-200 ${cardBorder(3)}`}>
        <div className="flex items-center gap-3 mb-4">
          {qBadge(3)}
          <h3 className="text-[15px] font-semibold text-ink">
            Ready to start your session?
          </h3>
        </div>
        <div className="flex flex-wrap gap-2.5">
          {READY_OPTIONS.map((opt) => (
            <Chip key={opt} selected={ready === opt} onClick={() => setReady(opt)}>
              {opt}
            </Chip>
          ))}
        </div>
      </Card>

      {/* Footer */}
      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={switchToIntake}
          className="text-[13px] text-ink-faint font-medium hover:text-ink underline underline-offset-4 decoration-ink-faint/30
            min-h-[44px] flex items-center"
        >
          First time? Set up profile
        </button>
        <PrimaryButton onClick={() => setScreen("live")} arrow>
          Start session
        </PrimaryButton>
      </div>
    </>
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
const SEX_OPTIONS = [
  { value: "female", label: "Female" },
  { value: "male", label: "Male" },
]

function IntakeFlow({ switchToCheckin }) {
  const [area, setArea] = useState(null)
  const [situation, setSituation] = useState(null)
  const [timeline, setTimeline] = useState(null)
  const [ptName, setPtName] = useState("")
  const [notes, setNotes] = useState("")
  const [age, setAge] = useState("")
  const [sexAtBirth, setSexAtBirth] = useState(null)

  const handleSave = async () => {
    if (age && sexAtBirth) {
      try {
        await fetch("/user-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ age: parseInt(age, 10), sex_at_birth: sexAtBirth }),
        })
      } catch (e) {
        console.warn("Failed to save user context:", e)
      }
    }
    switchToCheckin()
  }

  return (
    <>
      {/* Greeting */}
      <div>
        <h2 className="text-[22px] font-bold text-ink tracking-tight">Welcome.</h2>
        <p className="text-[15px] text-ink-soft mt-1.5 max-w-md leading-relaxed">
          Let's get to know your situation so we can coach you better.
        </p>
      </div>

      {/* Disclaimer */}
      <div className="flex items-start gap-3 rounded-2xl bg-brand-bg p-5">
        <div className="w-8 h-8 rounded-xl bg-brand/10 flex items-center justify-center shrink-0">
          <i className="ti ti-info-circle text-brand text-[16px]" />
        </div>
        <p className="text-[14px] text-ink-soft leading-relaxed">
          PhysioFusion is a coaching and tracking tool, not a substitute for your
          physical therapist. We don't diagnose or prescribe exercises.
        </p>
      </div>

      {/* Q: Age */}
      <Card>
        <h3 className="text-[15px] font-semibold text-ink mb-1">Age</h3>
        <p className="text-[13px] text-ink-faint mb-4">
          Used for age-normed reference ranges (e.g. sit-to-stand assessment)
        </p>
        <input
          type="number"
          min="1"
          max="120"
          value={age}
          onChange={(e) => setAge(e.target.value)}
          placeholder="e.g. 72"
          className="w-36 px-4 min-h-[44px] rounded-xl border-0 bg-surface text-[14px] text-ink placeholder:text-ink-faint
            focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
      </Card>

      {/* Q: Biological sex */}
      <Card>
        <h3 className="text-[15px] font-semibold text-ink mb-1">
          Biological sex at birth
        </h3>
        <p className="text-[13px] text-ink-faint mb-4">
          Used for sex-stratified age-normed reference ranges
        </p>
        <div className="flex flex-wrap gap-2.5">
          {SEX_OPTIONS.map((opt) => (
            <Chip key={opt.value} selected={sexAtBirth === opt.value} onClick={() => setSexAtBirth(opt.value)}>
              {opt.label}
            </Chip>
          ))}
        </div>
      </Card>

      {/* Q: Body area */}
      <Card>
        <h3 className="text-[15px] font-semibold text-ink mb-4">
          What are you working on?
        </h3>
        <div className="flex flex-wrap gap-2.5">
          {BODY_AREAS.map((opt) => (
            <Chip key={opt} selected={area === opt} onClick={() => setArea(opt)}>
              {opt}
            </Chip>
          ))}
        </div>
      </Card>

      {/* Q: Situation */}
      <Card>
        <h3 className="text-[15px] font-semibold text-ink mb-4">
          What's the situation?
        </h3>
        <div className="flex flex-wrap gap-2.5">
          {SITUATIONS.map((opt) => (
            <Chip key={opt} selected={situation === opt} onClick={() => setSituation(opt)}>
              {opt}
            </Chip>
          ))}
        </div>
      </Card>

      {/* Q: Timeline */}
      <Card>
        <h3 className="text-[15px] font-semibold text-ink mb-4">
          When did this start?
        </h3>
        <div className="flex flex-wrap gap-2.5">
          {TIMELINES.map((opt) => (
            <Chip key={opt} selected={timeline === opt} onClick={() => setTimeline(opt)}>
              {opt}
            </Chip>
          ))}
        </div>
      </Card>

      {/* Optional inputs */}
      <Card>
        <h3 className="text-[15px] font-semibold text-ink mb-4">
          Your PT (optional)
        </h3>
        <input
          type="text"
          value={ptName}
          onChange={(e) => setPtName(e.target.value)}
          placeholder="PT name or clinic"
          className="w-full px-4 min-h-[44px] rounded-xl border-0 bg-surface text-[14px] text-ink placeholder:text-ink-faint
            focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
      </Card>

      <Card>
        <h3 className="text-[15px] font-semibold text-ink mb-4">
          Anything we should know? (optional)
        </h3>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Previous surgeries, restrictions, goals…"
          rows={3}
          className="w-full px-4 py-3 rounded-xl border-0 bg-surface text-[14px] text-ink placeholder:text-ink-faint resize-none
            focus:outline-none focus:ring-2 focus:ring-brand/30"
        />
      </Card>

      {/* Footer */}
      <div className="flex items-center justify-between pt-2">
        <button
          type="button"
          onClick={switchToCheckin}
          className="text-[13px] text-ink-faint font-medium hover:text-ink underline underline-offset-4 decoration-ink-faint/30
            min-h-[44px] flex items-center"
        >
          I'll do this later
        </button>
        <PrimaryButton onClick={handleSave} arrow>
          Save and start
        </PrimaryButton>
      </div>
    </>
  )
}

// ══════════════════════════════════════════════════════════════════════
//  ROOT COMPONENT
// ══════════════════════════════════════════════════════════════════════

export default function CheckIn({ setScreen }) {
  const [mode, setMode] = useState("checkin")
  const [micAvailable, setMicAvailable] = useState(false)

  useEffect(() => {
    if (!SR) return
    if (typeof SR.available === "function") {
      SR.available({ langs: ["en-US"], processLocally: true })
        .then((result) => {
          const ok = result === "available" || result?.available === true
          setMicAvailable(ok)
        })
        .catch(() => setMicAvailable(false))
    } else {
      const secure =
        location.protocol === "https:" || location.hostname === "localhost"
      setMicAvailable(secure)
    }
  }, [])

  if (mode === "intake") {
    return <IntakeFlow switchToCheckin={() => setMode("checkin")} />
  }

  return (
    <CheckInFlow
      setScreen={setScreen}
      switchToIntake={() => setMode("intake")}
      micAvailable={micAvailable}
    />
  )
}
