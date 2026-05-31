import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from '../SocketContext'
import useVoice from '../hooks/useVoice'
import { cueForRep } from '../coach/setCues'

/**
 * Hands-free voice assistant. A single small control in the bottom-right corner:
 * tap once to enable, then run the whole app by voice. Outside an active set it's
 * a full assistant (navigate, start/end sets, answer questions); during a set it
 * stays quiet, speaking only short deterministic cues ("three to go").
 *
 * Deliberately minimal — a mic icon, a subtle status animation, and a small
 * transcript line that fades on its own. No panels, no chrome.
 */
const NAV_ACTIONS = {
  go_checkin: 'checkin',
  go_live: 'live',
  go_debrief: 'debrief',
  go_clinician: 'clinician',
  start_set: 'live',     // jumping into a set => show the live workout
  end_session: 'debrief', // wrapping up => show the results
}

export default function VoiceAssistant({ setScreen }) {
  const { state, send, agentReply } = useSession()

  const [thinking, setThinking] = useState(false)
  const [line, setLine] = useState(null) // { who: 'you' | 'coach', text }
  const [lineVisible, setLineVisible] = useState(false)
  const hideTimer = useRef(null)

  const showLine = useCallback((who, text) => {
    if (!text) return
    setLine({ who, text })
    setLineVisible(true)
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => setLineVisible(false), 4500)
  }, [])

  const onInterim = useCallback((text) => showLine('you', text), [showLine])
  const onFinal = useCallback((text) => {
    showLine('you', text)
    setThinking(true)
    send?.({ cmd: 'say', text })
  }, [showLine, send])

  const { supported, listening, toggle, speak } = useVoice({ onFinal, onInterim })

  // ── Coach replies: speak them, surface the line, run navigation ──
  useEffect(() => {
    if (!agentReply) return
    setThinking(false)
    if (agentReply.text) {
      showLine('coach', agentReply.text)
      speak(agentReply.text)
    }
    const screen = NAV_ACTIONS[agentReply.action]
    if (screen) setScreen?.(screen)
  }, [agentReply, showLine, speak, setScreen])

  // ── During an active set: minimal deterministic cues on each new rep ──
  const lastRep = useRef(0)
  const lastPhase = useRef(null)
  useEffect(() => {
    const phase = state?.phase
    const reps = state?.rep_count ?? 0
    if (phase !== 'SET_ACTIVE') {
      lastRep.current = reps
      lastPhase.current = phase
      return
    }
    // Reset the counter when a fresh set begins.
    if (lastPhase.current !== 'SET_ACTIVE') lastRep.current = reps
    lastPhase.current = phase

    if (reps > lastRep.current) {
      lastRep.current = reps
      if (listening) {
        const formFlag = Array.isArray(state.form_flags) ? state.form_flags[0] : null
        const cue = cueForRep({ reps, target: state.rep_target, formFlag })
        if (cue) speak(cue)
      }
    }
  }, [state, listening, speak])

  useEffect(() => () => clearTimeout(hideTimer.current), [])

  if (!supported) return null

  const status = thinking ? 'thinking' : listening ? 'listening' : 'idle'
  // "speaking" is visual-only and tracked inside the hook; fold it into the
  // listening ring so the button doesn't flicker between states mid-reply.

  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col items-end gap-2">
      {line && (
        <div
          className={`max-w-[260px] rounded-lg border border-hair bg-white px-3 py-2 shadow-sm transition-opacity duration-500 ${
            lineVisible ? 'opacity-100' : 'opacity-0'
          }`}
        >
          <div className="text-[9px] uppercase tracking-wide text-ink-faint mb-0.5">
            {line.who === 'you' ? 'You' : 'Coach'}
          </div>
          <div className="text-xs leading-snug text-ink-soft">{line.text}</div>
        </div>
      )}

      <button
        type="button"
        onClick={toggle}
        aria-pressed={listening}
        title={listening ? 'Voice on — tap to mute' : 'Tap to talk'}
        className="relative w-11 h-11 rounded-full border border-hair bg-white shadow-sm flex items-center justify-center text-ink-soft hover:bg-surface transition-colors"
      >
        {/* Breathing ring while the assistant is live */}
        {listening && (
          <span className="absolute inset-0 rounded-full border border-brand/40 voice-breathe" />
        )}

        {status === 'thinking' ? (
          <i className="ti ti-loader-2 text-[18px] text-brand animate-spin" />
        ) : status === 'listening' ? (
          <VoiceBars />
        ) : (
          <i className="ti ti-microphone text-[18px]" />
        )}
      </button>
    </div>
  )
}

/* Three slim bars that breathe while listening — quieter than a waveform. */
function VoiceBars() {
  return (
    <span className="flex items-end gap-[2px] h-[16px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="w-[2px] rounded-full bg-brand voice-bar"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </span>
  )
}
