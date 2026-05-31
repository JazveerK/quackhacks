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

// "hey coach …" — only utterances addressed to the coach are acted on.
const WAKE_RE = /\bhey,?\s+coach\b/i

// Why a rep didn't count, in the coach's own words.
const VOID_PHRASES = {
  shallow: "That one didn't count — try to reach your depth.",
  too_fast: "Slow it down — that rep was too quick to count.",
  too_slow: "That one took too long to count — keep a steady pace.",
  not_tracked: "I lost sight of you there — that rep didn't count.",
  incomplete: "That one didn't count — go all the way through the movement.",
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

  // ── Wake-word gating ──────────────────────────────────────────────
  // Continuous recognition picks up everything, which felt janky. Now we only
  // respond to "hey coach …". Saying just "hey coach" arms a short follow-up
  // window so the next phrase ("end set") lands without repeating the wake word.
  const speakRef = useRef(null)        // breaks the onFinal → speak cycle
  const armedRef = useRef(false)
  const armTimer = useRef(null)
  const arm = useCallback(() => {
    armedRef.current = true
    clearTimeout(armTimer.current)
    armTimer.current = setTimeout(() => { armedRef.current = false }, 8000)
  }, [])

  const onInterim = useCallback((text) => {
    if (armedRef.current || WAKE_RE.test(text)) showLine('you', text)
  }, [showLine])

  const onFinal = useCallback((text) => {
    const hasWake = WAKE_RE.test(text)
    let command = text
    if (hasWake) {
      command = text.replace(WAKE_RE, ' ').replace(/^[\s,.:;-]+/, '').trim()
    } else if (!armedRef.current) {
      return  // not addressed to the coach — ignore ambient speech
    }
    showLine('you', text)
    if (!command) {
      // Just the wake word — acknowledge and listen for the actual command.
      arm()
      speakRef.current?.('Yeah? What do you need?')
      return
    }
    armedRef.current = false
    clearTimeout(armTimer.current)
    setThinking(true)
    send?.({ cmd: 'say', text: command })
  }, [showLine, send, arm])

  const { supported, listening, toggle, speak } = useVoice({ onFinal, onInterim })
  useEffect(() => { speakRef.current = speak }, [speak])

  // ── Coach replies: speak them, surface the line, run navigation ──
  const lastAgentAt = useRef(0)
  useEffect(() => {
    if (!agentReply) return
    setThinking(false)
    lastAgentAt.current = Date.now()
    if (agentReply.text) {
      showLine('coach', agentReply.text)
      speak(agentReply.text)
    }
    const screen = NAV_ACTIONS[agentReply.action]
    if (screen) setScreen?.(screen)
  }, [agentReply, showLine, speak, setScreen])

  // ── Announce the result when a set ends ───────────────────────────
  const lastPhaseRef = useRef(null)
  useEffect(() => {
    const phase = state?.phase
    const prev = lastPhaseRef.current
    lastPhaseRef.current = phase
    const ended = prev === 'SET_ACTIVE' && (phase === 'SET_END' || phase === 'DEBRIEF')
    if (!ended) return
    // If the agent just spoke (e.g. the user said "end set"), don't talk over it.
    if (Date.now() - lastAgentAt.current < 3000) return
    const reps = state?.rep_count ?? 0
    const target = state?.rep_target
    const voids = state?.rep_void_count ?? 0
    let summary = `Set complete. You logged ${reps} ${reps === 1 ? 'rep' : 'reps'}`
    if (target) summary += ` of ${target}`
    summary += '.'
    summary += voids > 0
      ? ` ${voids} ${voids === 1 ? 'rep' : 'reps'} didn't count.`
      : ' Nice work.'
    showLine('coach', summary)
    speak(summary)
  }, [state, speak, showLine])

  // ── Explain a rep that didn't count, in the moment ────────────────
  const lastVoidRef = useRef(0)
  useEffect(() => {
    const vc = state?.rep_void_count ?? 0
    if (vc > lastVoidRef.current && state?.phase === 'SET_ACTIVE' && listening) {
      const phrase = VOID_PHRASES[state?.rep_void_reason] ||
        "That one didn't count — reset and try again."
      showLine('coach', phrase)
      speak(phrase)
    }
    lastVoidRef.current = vc
  }, [state, listening, speak, showLine])

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
        title={listening ? 'Voice on — say “hey coach”' : 'Tap to enable voice'}
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
