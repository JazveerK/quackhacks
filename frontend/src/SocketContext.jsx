import { createContext, useContext } from 'react'
import useSocket from './hooks/useSocket'
import useBrowserTracker from './hooks/useBrowserTracker'

// Static/serverless deploys (Vercel, GitHub Pages) set VITE_CLIENT_TRACKING=1:
// there is no backend, so tracking runs entirely in the visitor's browser
// (their camera + MediaPipe). The hook reference is fixed at module load so the
// same hook is called every render (Rules of Hooks safe).
const CLIENT_TRACKING = import.meta.env.VITE_CLIENT_TRACKING === '1'
const useTracker = CLIENT_TRACKING ? useBrowserTracker : useSocket

/**
 * One shared live backend connection for the whole app.
 *
 * Every screen (Check-in, Live, Debrief, Clinician) and the floating CoachChat
 * read from the SAME WebSocket via this context, instead of each opening its own
 * connection or running the old `useMockSession` fake feed. This is the seam
 * that turns the mock UI into a live one: `state`, `frame`, `summary`,
 * `aiDebrief`, `profile`, and `agentReply` are all real backend data, and
 * `send(...)` drives the tracker (start_set / end_set / reset_set /
 * select_exercise / say).
 *
 * Shape (from hooks/useSocket.js):
 *   { connected, state, frame, summary, aiDebrief, profile, agentReply,
 *     send, setSummary, setAgentReply }
 */
const SocketContext = createContext(null)

export function SocketProvider({ children }) {
  const socket = useTracker()
  return <SocketContext.Provider value={socket}>{children}</SocketContext.Provider>
}

export function useSession() {
  const ctx = useContext(SocketContext)
  if (ctx === null) {
    throw new Error('useSession must be used inside <SocketProvider>')
  }
  return ctx
}

export default SocketContext
