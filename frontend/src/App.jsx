import { useState } from "react"
import AppHeader from "./components/AppHeader"
import VoiceAssistant from "./components/VoiceAssistant"
import CheckIn from "./screens/CheckIn"
import LiveDashboard from "./screens/LiveDashboard"
import Debrief from "./screens/Debrief"
import ClinicianView from "./screens/ClinicianView"

const SCREENS = [
  { key: "checkin",   label: "1 · Check-in" },
  { key: "live",      label: "2 · Live" },
  { key: "debrief",   label: "3 · Debrief" },
  { key: "clinician", label: "4 · Clinician (PT)" },
]

const phaseForScreen = {
  checkin:   { phase: "Check-in",   color: "blue" },
  live:      { phase: "Active",     color: "green" },
  debrief:   { phase: "Debrief",    color: "blue" },
  clinician: { phase: "Clinician",  color: "blue" },
}

export default function App() {
  const [screen, setScreen] = useState("checkin")
  // Today's workout plan, built on the check-in screen and driven through
  // the live session: [{ id, name, sets, reps }]. `workoutPos` tracks where we
  // are — which exercise (0-based) and which set (1-based).
  const [workout, setWorkout] = useState([])
  const [workoutPos, setWorkoutPos] = useState({ ex: 0, set: 1 })
  const { phase, color } = phaseForScreen[screen]

  return (
    <div className="flex flex-col h-full">
      <AppHeader
        context={["Bodyweight Squat"]}
        phase={phase}
        phaseColor={color}
      />

      {/* Dev nav — segmented control */}
      <nav className="flex justify-center py-3 shrink-0">
        <div className="inline-flex bg-surface rounded-full p-1 gap-0.5">
          {SCREENS.map(({ key, label }) => (
            <button
              key={key}
              type="button"
              onClick={() => setScreen(key)}
              className={`px-4 py-1.5 rounded-full text-xs font-medium transition-colors ${
                screen === key
                  ? "bg-white text-brand shadow-sm"
                  : "text-ink-soft hover:text-ink"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* Screen content */}
      <main className="flex-1 w-full max-w-5xl mx-auto px-4 pb-6">
        {screen === "checkin"   && (
          <CheckIn
            setScreen={setScreen}
            workout={workout}
            setWorkout={setWorkout}
            setWorkoutPos={setWorkoutPos}
          />
        )}
        {screen === "live"      && (
          <LiveDashboard
            setScreen={setScreen}
            workout={workout}
            workoutPos={workoutPos}
            setWorkoutPos={setWorkoutPos}
          />
        )}
        {screen === "debrief"   && <Debrief setScreen={setScreen} />}
        {screen === "clinician" && <ClinicianView setScreen={setScreen} />}
      </main>

      {/* Hands-free voice assistant — available on all screens */}
      <VoiceAssistant setScreen={setScreen} />
    </div>
  )
}
