import { useEffect, useState } from 'react'
import useSocket from './hooks/useSocket'
import useVoice from './hooks/useVoice'
import AppHeader from './components/AppHeader'
import LiveSession from './components/LiveSession'
import DebriefScreen from './components/DebriefScreen'
import SessionReport from './components/SessionReport'

export default function App() {
  const {
    connected, state, frame, summary, aiDebrief, profile, agentReply,
    send, setSummary, setAgentReply,
  } = useSocket()
  const voice = useVoice(send)

  const [sessionReport, setSessionReport] = useState(null)
  const [setsCompleted, setSetsCompleted] = useState(0)

  const activeProfile = state?.profile || profile
  const phase = state?.phase || 'WAITING_FOR_START'

  // Completed-set count comes from each set summary (set_index is 1-based).
  useEffect(() => {
    if (summary?.set_index != null) setSetsCompleted(summary.set_index)
  }, [summary])

  // React to every voice-agent reply: speak it, and surface the session report
  // when the agent ends the session by voice.
  useEffect(() => {
    if (!agentReply) return
    if (agentReply.text) voice.speak(agentReply.text)
    if (agentReply.action === 'end_session' && agentReply.report) {
      setSessionReport(agentReply.report)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentReply?.seq])

  function handleStartSet() {
    send({ cmd: 'start_set' })
  }
  function handleEndSet() {
    send({ cmd: 'end_set' })
  }
  function handleSelectExercise(id) {
    send({ cmd: 'select_exercise', id })
  }
  function handleStartNext() {
    send({ cmd: 'reset_set' })
    setSummary(null)
  }
  async function handleEndSession() {
    let report = null
    try {
      const res = await fetch('/session/end', { method: 'POST' })
      if (res.ok) report = await res.json()
    } catch { /* fall back to a minimal local summary */ }
    setSessionReport(report || { sets_count: setsCompleted, total_reps: 0, report: null })
  }
  function handleCloseReport() {
    setSessionReport(null)
    setSummary(null)
    setAgentReply(null)
    setSetsCompleted(0)
    send({ cmd: 'reset_set' })
  }

  // Routing priority: session report > per-set debrief > live session.
  const showDebrief = summary != null && (phase === 'DEBRIEF' || phase === 'SET_END')
  const totalSets = activeProfile?.sets || 3
  const headerSet = Math.min(
    showDebrief ? setsCompleted : setsCompleted + 1,
    totalSets,
  ) || 1

  let page
  if (sessionReport) {
    page = <SessionReport report={sessionReport} onClose={handleCloseReport} />
  } else if (showDebrief) {
    page = (
      <DebriefScreen
        summary={summary}
        aiDebrief={aiDebrief}
        profile={activeProfile}
        setsCompleted={setsCompleted}
        totalSets={totalSets}
        onStartNext={handleStartNext}
        onEndSession={handleEndSession}
      />
    )
  } else {
    page = (
      <LiveSession
        state={state}
        frame={frame}
        profile={activeProfile}
        voice={voice}
        lastReply={agentReply}
        onStartSet={handleStartSet}
        onEndSet={handleEndSet}
        onSelectExercise={handleSelectExercise}
      />
    )
  }

  return (
    <div className="flex flex-col h-screen">
      <AppHeader
        connected={connected}
        state={state}
        profile={activeProfile}
        currentSet={headerSet}
        totalSets={totalSets}
      />
      {page}
    </div>
  )
}
