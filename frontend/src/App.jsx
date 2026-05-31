import useSocket from './hooks/useSocket'
import AppHeader from './components/AppHeader'
import LiveSession from './components/LiveSession'
import DebriefScreen from './components/DebriefScreen'

export default function App() {
  const { connected, state, frame, summary, aiDebrief, profile, send, setSummary } = useSocket()

  const phase = state?.phase || 'REST'
  const isDebrief = phase === 'DEBRIEF' || phase === 'SET_END' || phase === 'REST'
  const showDebrief = isDebrief && summary != null

  const activeProfile = state?.profile || profile

  function handleEndSet() {
    send({ cmd: 'end_set' })
  }

  function handleStartNext() {
    send({ cmd: 'reset_set' })
    setSummary(null)
  }

  return (
    <div className="flex flex-col h-screen">
      <AppHeader connected={connected} state={state} profile={activeProfile} />

      {showDebrief ? (
        <DebriefScreen
          summary={summary}
          aiDebrief={aiDebrief}
          profile={activeProfile}
          onStartNext={handleStartNext}
        />
      ) : (
        <LiveSession
          state={state}
          frame={frame}
          profile={activeProfile}
          onEndSet={handleEndSet}
          onStartNext={handleStartNext}
        />
      )}
    </div>
  )
}
