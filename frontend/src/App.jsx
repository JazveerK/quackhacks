import { useState } from "react"
import AppHeader from "./components/AppHeader"
import CoachChat from "./components/CoachChat"
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
        {screen === "checkin"   && <CheckIn setScreen={setScreen} />}
        {screen === "live"      && <LiveDashboard setScreen={setScreen} />}
        {screen === "debrief"   && <Debrief setScreen={setScreen} />}
        {screen === "clinician" && <ClinicianView setScreen={setScreen} />}
      </main>

      {/* Floating coach chat — available on all screens */}
      <CoachChat />
    </div>
  )
}
