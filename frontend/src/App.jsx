import { useState, useEffect } from "react"
import AppHeader from "./components/AppHeader"
import CoachChat from "./components/CoachChat"
import CheckIn from "./screens/CheckIn"
import LiveDashboard from "./screens/LiveDashboard"
import Debrief from "./screens/Debrief"
import ClinicianView from "./screens/ClinicianView"
import ClinicianHandoff from "./screens/ClinicianHandoff"

const SCREENS = [
  { key: "checkin",   label: "Check-in",  icon: "ti-clipboard-heart" },
  { key: "live",      label: "Live",       icon: "ti-heartbeat" },
  { key: "debrief",   label: "Debrief",    icon: "ti-report-analytics" },
  { key: "clinician", label: "Clinician",  icon: "ti-stethoscope" },
]

const phaseForScreen = {
  checkin:   { phase: "Check-in",   color: "blue" },
  live:      { phase: "Active",     color: "green" },
  debrief:   { phase: "Debrief",    color: "blue" },
  clinician: { phase: "Clinician",  color: "blue" },
  handoff:   { phase: "Handoff",    color: "blue" },
}

export default function App() {
  const [screen, setScreen] = useState("checkin")
  const [handoffSessionId, setHandoffSessionId] = useState(null)

  // Check if the URL is a /share/<session_id> handoff link
  useEffect(() => {
    const path = window.location.pathname
    const match = path.match(/^\/share\/([a-zA-Z0-9_-]+)$/)
    if (match) {
      setHandoffSessionId(match[1])
      setScreen("handoff")
    }
  }, [])

  const { phase, color } = phaseForScreen[screen] || phaseForScreen.checkin

  // Standalone handoff view (no nav, no chat — clinician-facing)
  if (screen === "handoff") {
    return (
      <div className="flex flex-col h-full">
        <AppHeader
          context={["Clinician Handoff"]}
          phase="Handoff"
          phaseColor="blue"
        />
        <main className="flex-1 w-full max-w-4xl mx-auto px-5 pb-8 pt-5">
          <ClinicianHandoff sessionId={handoffSessionId} />
        </main>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <AppHeader
        context={["Bodyweight Squat"]}
        phase={phase}
        phaseColor={color}
      />

      {/* Apple-style segmented control */}
      <nav className="flex justify-center py-4 shrink-0">
        <div className="inline-flex bg-surface/70 backdrop-blur-sm rounded-2xl p-1.5 gap-1">
          {SCREENS.map(({ key, label, icon }) => (
            <button
              key={key}
              type="button"
              onClick={() => setScreen(key)}
              className={`flex items-center gap-2 px-5 min-h-[44px] rounded-xl text-[13px] font-medium
                transition-all duration-200 motion-reduce:transition-none
                focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2
                active:scale-[0.97] motion-reduce:active:scale-100 ${
                screen === key
                  ? "bg-white text-brand"
                  : "text-ink-faint hover:text-ink-soft"
              }`}
            >
              <i className={`ti ${icon} text-[15px]`} />
              {label}
            </button>
          ))}
        </div>
      </nav>

      {/* Screen content — live dashboard gets full width, others get constrained */}
      {screen === "live" ? (
        <main className="flex-1 min-h-0">
          <LiveDashboard setScreen={setScreen} />
        </main>
      ) : (
        <main className="flex-1 w-full max-w-4xl mx-auto px-5 pb-8">
          <div className="stagger-enter flex flex-col gap-5">
            {screen === "checkin"   && <CheckIn setScreen={setScreen} />}
            {screen === "debrief"   && <Debrief setScreen={setScreen} />}
            {screen === "clinician" && <ClinicianView setScreen={setScreen} />}
          </div>
        </main>
      )}

      {/* Floating coach chat — available on all screens */}
      <CoachChat />
    </div>
  )
}
