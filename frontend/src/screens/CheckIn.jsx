import { useState, useEffect, useCallback } from "react"
import Card from "../components/Card"
import Chip from "../components/Chip"
import PrimaryButton from "../components/PrimaryButton"
import { useSession } from "../SocketContext"

// ══════════════════════════════════════════════════════════════════════
//  CHECK-IN FLOW
// ══════════════════════════════════════════════════════════════════════

const PAIN_OPTIONS = ["None", "Mild", "Moderate", "Sharp"]

// Small +/- number stepper used for sets and reps.
function Stepper({ label, value, min, max, onChange }) {
  const dec = () => onChange(Math.max(min, value - 1))
  const inc = () => onChange(Math.min(max, value + 1))
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[10px] text-ink-faint tracking-wide">{label}</span>
      <div className="flex items-center rounded-lg border border-hair bg-white">
        <button
          type="button"
          onClick={dec}
          className="w-8 h-9 flex items-center justify-center text-ink-soft hover:text-ink disabled:opacity-30"
          disabled={value <= min}
        >
          <i className="ti ti-minus text-sm" />
        </button>
        <span className="w-8 text-center text-sm font-medium text-ink tabular-nums">
          {value}
        </span>
        <button
          type="button"
          onClick={inc}
          className="w-8 h-9 flex items-center justify-center text-ink-soft hover:text-ink disabled:opacity-30"
          disabled={value >= max}
        >
          <i className="ti ti-plus text-sm" />
        </button>
      </div>
    </div>
  )
}

function CheckInFlow({ setScreen, switchToIntake, workout, setWorkout, setWorkoutPos }) {
  const { send } = useSession()

  const [kneeScore, setKneeScore] = useState(null)
  const [pain, setPain] = useState(null)

  // IMU sensor fusion toggle. On (default) keeps tracking your depth when the
  // camera loses sight of the leg; off runs camera-only.
  const [useIMU, setUseIMU] = useState(true)

  // ── Exercise catalogue + workout builder ───────────────────────────
  const [exercises, setExercises] = useState([])
  const [exLoadError, setExLoadError] = useState(null)
  const [pickId, setPickId] = useState("")
  const [pickSets, setPickSets] = useState(3)
  const [pickReps, setPickReps] = useState(10)
  const [docOpen, setDocOpen] = useState(false)
  const [docText, setDocText] = useState("")
  const [generating, setGenerating] = useState(false)
  const [genError, setGenError] = useState(null)
  const [genSuccess, setGenSuccess] = useState(null)

  // Fetch the catalogue of exercises.
  const fetchExercises = useCallback(async () => {
    try {
      const res = await fetch("/exercises")
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      const list = Array.isArray(data?.exercises) ? data.exercises : []
      setExercises(list)
      setExLoadError(null)
      // Default the picker to the first option if nothing chosen yet.
      setPickId((cur) => cur || list[0]?.id || "")
      return data
    } catch {
      setExLoadError("Couldn't load exercises. Check your connection.")
      return null
    }
  }, [])

  useEffect(() => {
    fetchExercises()
  }, [fetchExercises])

  // Add the currently-picked exercise (with its sets/reps) to the workout.
  const addExercise = useCallback(() => {
    const ex = exercises.find((e) => e.id === pickId)
    if (!ex) return
    setWorkout((w) => [
      ...w,
      { id: ex.id, name: ex.display_name, sets: pickSets, reps: pickReps },
    ])
  }, [exercises, pickId, pickSets, pickReps, setWorkout])

  const removeExercise = useCallback(
    (idx) => setWorkout((w) => w.filter((_, i) => i !== idx)),
    [setWorkout]
  )

  // Generate a new exercise spec from pasted documentation.
  const handleGenerate = useCallback(async () => {
    const text = docText.trim()
    if (!text || generating) return
    setGenerating(true)
    setGenError(null)
    setGenSuccess(null)
    try {
      const res = await fetch("/exercise/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      const data = await res.json().catch(() => ({}))
      if (data?.source === "generated") {
        // Re-fetch the catalogue, then pre-select the newly loaded exercise.
        const refreshed = await fetchExercises()
        const newId = data?.active ?? refreshed?.active ?? data?.spec?.id ?? null
        if (newId) setPickId(newId)
        const name = data?.spec?.display_name || newId || "exercise"
        setGenSuccess(`Loaded "${name}" — add it to your workout below.`)
        setGenError(null)
      } else {
        setGenError(
          data?.error ||
            "Couldn't generate an exercise from that text. Try adding more detail."
        )
      }
    } catch {
      setGenError("Something went wrong while generating. Please try again.")
    } finally {
      setGenerating(false)
    }
  }, [docText, generating, fetchExercises])

  // Begin the session: install the first exercise + its rep target, then go live.
  // If the user hasn't explicitly "added" anything yet, fall back to whatever's
  // selected in the picker so a single tap on Start just works.
  const startSession = useCallback(() => {
    let plan = workout
    if (!plan.length) {
      const ex = exercises.find((e) => e.id === pickId)
      if (!ex) return
      plan = [{ id: ex.id, name: ex.display_name, sets: pickSets, reps: pickReps }]
      setWorkout(plan)
    }
    const first = plan[0]
    send({ cmd: "set_imu", enabled: useIMU })
    send({ cmd: "select_exercise", id: first.id })
    send({ cmd: "reset_set", rep_target: first.reps })
    send({ cmd: "start_set" })
    setWorkoutPos({ ex: 0, set: 1 })
    setScreen("live")
  }, [workout, exercises, pickId, pickSets, pickReps, useIMU, send, setWorkout, setWorkoutPos, setScreen])

  // The session can start once there's either a built plan or a valid pick.
  const canStart = workout.length > 0 || !!pickId
  const totalSets = workout.reduce((n, ex) => n + ex.sets, 0)

  // Which question is "active" (first unanswered)
  const activeQ = kneeScore == null ? 1 : pain == null ? 2 : 3

  function qBadge(n) {
    if (
      (n === 1 && kneeScore != null) ||
      (n === 2 && pain != null) ||
      (n === 3 && workout.length > 0)
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

  const cardBorder = (n) => (n === activeQ ? "ring-1 ring-brand" : "")

  return (
    <div className="flex flex-col gap-4">
      {/* Header area */}
      <div>
        <h2 className="text-lg font-semibold text-ink">Hi again.</h2>
        <p className="text-sm text-ink-soft mt-1 max-w-md">
          Quick check, then build today's workout — tap an answer, or use the
          voice assistant in the bottom corner.
        </p>
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

      {/* Step 3 — Build the workout */}
      <Card className={cardBorder(3)}>
        <div className="flex items-center gap-2 mb-1">
          {qBadge(3)}
          <h3 className="text-sm font-medium text-ink">Set up your workout</h3>
        </div>
        <p className="text-xs text-ink-soft mb-3 ml-8">
          Pick an exercise, choose sets and reps, then add it. Stack as many as
          you like.
        </p>

        {exLoadError && (
          <div className="flex items-start gap-2 rounded-lg bg-surface p-3 mb-3">
            <i className="ti ti-alert-triangle text-ink-faint text-sm shrink-0 mt-0.5" />
            <p className="text-xs text-ink-soft">{exLoadError}</p>
          </div>
        )}

        {/* Picker row */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1 flex-1 min-w-[180px]">
            <span className="text-[10px] text-ink-faint tracking-wide">
              Exercise
            </span>
            <select
              value={pickId}
              onChange={(e) => setPickId(e.target.value)}
              className="w-full h-9 px-3 rounded-lg border border-hair bg-white text-sm text-ink focus:outline-none focus:ring-1 focus:ring-brand"
            >
              <option value="" disabled>
                {exercises.length ? "Choose an exercise…" : "No exercises available"}
              </option>
              {exercises.map((ex) => (
                <option key={ex.id} value={ex.id}>
                  {ex.display_name}
                </option>
              ))}
            </select>
          </div>
          <Stepper label="Sets" value={pickSets} min={1} max={20} onChange={setPickSets} />
          <Stepper label="Reps" value={pickReps} min={1} max={50} onChange={setPickReps} />
          <button
            type="button"
            onClick={addExercise}
            disabled={!pickId}
            className="h-9 px-4 rounded-lg bg-brand text-white text-sm font-medium flex items-center gap-1.5 hover:opacity-90 disabled:opacity-40"
          >
            <i className="ti ti-plus text-sm" />
            Add
          </button>
        </div>

        {/* Collapsible: generate from documentation */}
        <button
          type="button"
          onClick={() => setDocOpen((v) => !v)}
          className="flex items-center gap-1.5 mt-3 text-xs text-ink-soft hover:text-ink transition-colors"
        >
          <i
            className={`ti ti-chevron-right text-sm transition-transform ${
              docOpen ? "rotate-90" : ""
            }`}
          />
          New exercise from documentation
        </button>

        {docOpen && (
          <div className="mt-3 flex flex-col gap-3">
            <textarea
              value={docText}
              onChange={(e) => setDocText(e.target.value)}
              placeholder="Paste exercise instructions or notes from your PT…"
              rows={4}
              disabled={generating}
              className="w-full px-3 py-2 rounded-lg border border-hair bg-white text-sm text-ink placeholder:text-ink-faint resize-none focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50"
            />

            {genSuccess && (
              <div className="flex items-start gap-2 rounded-lg bg-ok-bg p-3">
                <i className="ti ti-check text-ok text-sm shrink-0 mt-0.5" />
                <p className="text-xs text-ok">{genSuccess}</p>
              </div>
            )}
            {genError && (
              <div className="flex items-start gap-2 rounded-lg bg-surface p-3">
                <i className="ti ti-alert-triangle text-ink-faint text-sm shrink-0 mt-0.5" />
                <p className="text-xs text-ink-soft">{genError}</p>
              </div>
            )}

            <div className="flex justify-end">
              <PrimaryButton
                onClick={handleGenerate}
                className={
                  !docText.trim() || generating
                    ? "opacity-50 pointer-events-none"
                    : ""
                }
              >
                {generating ? "Generating…" : "Generate & load"}
              </PrimaryButton>
            </div>
          </div>
        )}

        {/* Workout list */}
        <div className="mt-4 border-t border-hair pt-4">
          {workout.length === 0 ? (
            <p className="text-xs text-ink-faint text-center py-2">
              No exercises yet — add one above to build your workout.
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {workout.map((ex, i) => (
                <li
                  key={i}
                  className="flex items-center gap-3 rounded-lg bg-surface px-3 py-2"
                >
                  <span className="w-6 h-6 rounded-full bg-white text-ink-soft flex items-center justify-center text-xs font-medium shrink-0">
                    {i + 1}
                  </span>
                  <span className="text-sm font-medium text-ink flex-1 truncate">
                    {ex.name}
                  </span>
                  <span className="text-xs text-ink-soft tabular-nums">
                    {ex.sets} × {ex.reps}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeExercise(i)}
                    className="text-ink-faint hover:text-bad transition-colors"
                    title="Remove"
                  >
                    <i className="ti ti-x text-sm" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {/* IMU sensor-fusion toggle */}
      <Card>
        <button
          type="button"
          onClick={() => setUseIMU((v) => !v)}
          aria-pressed={useIMU}
          className="flex items-center gap-3 w-full text-left"
        >
          <span
            className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 transition-colors ${
              useIMU ? "bg-brand-bg text-brand" : "bg-surface text-ink-faint"
            }`}
          >
            <i className="ti ti-cpu text-lg" />
          </span>
          <span className="flex-1 min-w-0">
            <span className="block text-sm font-medium text-ink">
              IMU sensor fusion
            </span>
            <span className="block text-xs text-ink-soft">
              Keeps tracking your depth when the camera loses sight of your leg.
            </span>
          </span>
          {/* Switch */}
          <span
            className={`relative w-11 h-6 rounded-full shrink-0 transition-colors ${
              useIMU ? "bg-brand" : "bg-hair"
            }`}
          >
            <span
              className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${
                useIMU ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </span>
        </button>
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
        <div className="flex items-center gap-3">
          {workout.length > 0 ? (
            <span className="text-xs text-ink-soft tabular-nums">
              {workout.length} exercise{workout.length > 1 ? "s" : ""} ·{" "}
              {totalSets} set{totalSets > 1 ? "s" : ""}
            </span>
          ) : canStart ? (
            <span className="text-xs text-ink-faint">
              Starts with {pickSets} × {pickReps}
            </span>
          ) : (
            <span className="text-xs text-ink-faint">No exercises added</span>
          )}
          <PrimaryButton
            onClick={startSession}
            arrow
            className={!canStart ? "opacity-50 pointer-events-none" : ""}
          >
            Start workout
          </PrimaryButton>
        </div>
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
  // Age + biological sex drive the age-normed sit-to-stand interpretation in
  // the clinician handoff. Posted to /user-context before the session ends.
  const [age, setAge] = useState("")
  const [sexAtBirth, setSexAtBirth] = useState(null)

  const handleSave = useCallback(async () => {
    const ageNum = parseInt(age, 10)
    if (ageNum >= 1 && ageNum <= 120 && (sexAtBirth === "male" || sexAtBirth === "female")) {
      try {
        await fetch("/user-context", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ age: ageNum, sex_at_birth: sexAtBirth }),
        })
      } catch {
        // Best-effort — the session still runs without norm-stratified handoff.
      }
    }
    switchToCheckin()
  }, [age, sexAtBirth, switchToCheckin])

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
          SteadyPT is a coaching and tracking tool, not a substitute for your
          physical therapist. We don't diagnose or prescribe exercises.
        </p>
      </div>

      {/* Profile basics — used for age-normed reference ranges (sit-to-stand) */}
      <Card>
        <h3 className="text-sm font-medium text-ink mb-1">Profile basics</h3>
        <p className="text-xs text-ink-soft mb-3">
          Used for age-normed reference ranges in your clinician handoff.
        </p>
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-ink-faint tracking-wide">Age</span>
            <input
              type="number"
              min="1"
              max="120"
              value={age}
              onChange={(e) => setAge(e.target.value)}
              placeholder="—"
              className="w-24 h-9 px-3 rounded-lg border border-hair bg-white text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-brand"
            />
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[10px] text-ink-faint tracking-wide">Sex at birth</span>
            <div className="flex flex-wrap gap-2">
              {["female", "male"].map((opt) => (
                <Chip key={opt} selected={sexAtBirth === opt} onClick={() => setSexAtBirth(opt)}>
                  {opt[0].toUpperCase() + opt.slice(1)}
                </Chip>
              ))}
            </div>
          </div>
        </div>
      </Card>

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
        <PrimaryButton onClick={handleSave} arrow>
          Save and start
        </PrimaryButton>
      </div>
    </div>
  )
}

// ══════════════════════════════════════════════════════════════════════
//  ROOT COMPONENT
// ══════════════════════════════════════════════════════════════════════

export default function CheckIn({ setScreen, workout, setWorkout, setWorkoutPos }) {
  const [mode, setMode] = useState("checkin")

  if (mode === "intake") {
    return (
      <IntakeFlow switchToCheckin={() => setMode("checkin")} />
    )
  }

  return (
    <CheckInFlow
      setScreen={setScreen}
      switchToIntake={() => setMode("intake")}
      workout={workout}
      setWorkout={setWorkout}
      setWorkoutPos={setWorkoutPos}
    />
  )
}
