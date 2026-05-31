import { useCallback, useEffect, useRef, useState } from 'react'
import { useSession } from '../SocketContext'
import useVoice from '../hooks/useVoice'
import { cueForRep } from '../coach/setCues'

/**
 * Coach — a hands-free conversational voice agent that can reason over the live
 * session and drive the whole app.
 *
 * Closed: a floating mic button. Open: a chat panel (transcript + input bar).
 * It's voice-activated: while the panel is open the mic listens continuously,
 * but only utterances addressed with the wake word "hey coach …" are acted on
 * (so booth chatter can't fire commands). Typing works too — every turn goes
 * through the same backend agent over the WS, which answers with speech and an
 * optional action (navigate, start/end/next set, end session, note). During an
 * active set the agent stays quiet and we only play short deterministic cues.
 */
const NAV_ACTIONS = {
  go_checkin: 'checkin',
  go_live: 'live',
  go_debrief: 'debrief',
  read_debrief: 'debrief', // reading the debrief aloud => show it too
  go_clinician: 'clinician',
  start_set: 'live',      // jumping into a set => show the live workout
  end_session: 'debrief', // wrapping up => show the results
}

// "hey coach …" — only utterances addressed to the coach are acted on.
// Broadened to tolerate the Web Speech API's frequent mishears of the wake
// phrase ("hey couch", "a coach", "okay coach", "hey coatch", "hey coch").
const WAKE_RE = /\b(?:hey|hi|ok|okay|a)[\s,]+(?:coach|couch|coatch|coch|coaches?)\b/i

// Why a rep didn't count, in the coach's own words.
const VOID_PHRASES = {
  shallow: "That one didn't count — try to reach your depth.",
  too_fast: "Slow it down — that rep was too quick to count.",
  too_slow: "That one took too long to count — keep a steady pace.",
  not_tracked: "I lost sight of you there — that rep didn't count.",
  incomplete: "That one didn't count — go all the way through the movement.",
}

const STATUS_LABEL = {
  idle: 'Mic off',
  listening: 'Listening for “hey coach”',
  armed: 'Go ahead…',
  thinking: 'Thinking…',
  speaking: 'Speaking…',
}

const SUGGESTIONS = ['How did I do?', "What's my prescription?", 'Start my set']

export default function VoiceAssistant({ setScreen, screen }) {
  const { state, send, agentReply } = useSession()

  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([]) // { role: 'user' | 'coach', text }
  const [thinking, setThinking] = useState(false)
  const [typed, setTyped] = useState('')
  const [partial, setPartial] = useState('') // live interim transcript
  const [muted, setMuted] = useState(false)  // user turned the mic off
  const [armedUi, setArmedUi] = useState(false) // wake word heard, awaiting command
  const scrollRef = useRef(null)
  const inputRef = useRef(null)
  const thinkTimer = useRef(null)

  const addMessage = useCallback((role, text) => {
    if (!text) return
    setMessages((m) => [...m.slice(-40), { role, text }])
  }, [])

  // ── Sending a turn to the agent (spoken or typed) ─────────────────
  const sendTurn = useCallback((text) => {
    const t = (text || '').trim()
    if (!t) return
    setPartial('')
    addMessage('user', t)
    setThinking(true)
    // Safety net: never leave the typing indicator spinning if a reply is lost.
    clearTimeout(thinkTimer.current)
    thinkTimer.current = setTimeout(() => setThinking(false), 12000)
    send?.({ cmd: 'say', text: t })
  }, [addMessage, send])

  // ── Wake-word gating ──────────────────────────────────────────────
  // The mic hears everything, so we only act on "hey coach …". Saying just
  // "hey coach" arms a short window so the next phrase ("end set") lands as a
  // command without repeating the wake word.
  const speakRef = useRef(null)        // breaks the onFinal → speak cycle
  const armedRef = useRef(false)
  const armTimer = useRef(null)
  const arm = useCallback((ms = 8000) => {
    armedRef.current = true
    setArmedUi(true)
    clearTimeout(armTimer.current)
    armTimer.current = setTimeout(() => {
      armedRef.current = false
      setArmedUi(false)
    }, ms)
  }, [])

  const disarm = useCallback(() => {
    armedRef.current = false
    setArmedUi(false)
    clearTimeout(armTimer.current)
  }, [])

  const onInterim = useCallback((text) => {
    // The moment the wake word is heard, pop the chat window open so the user
    // sees the coach is listening — no need to tap the mic first.
    if (WAKE_RE.test(text)) setOpen(true)
    // Surface the live partial transcript once addressed to the coach.
    if (armedRef.current || WAKE_RE.test(text)) setPartial(text)
  }, [])

  const onFinal = useCallback((text) => {
    const hasWake = WAKE_RE.test(text)
    let command = text
    if (hasWake) {
      setOpen(true)  // auto-open on wake (covers the case interim never fired)
      command = text.replace(WAKE_RE, ' ').replace(/^[\s,.:;-]+/, '').trim()
    } else if (!armedRef.current) {
      return  // not addressed to the coach — ignore ambient speech
    }
    if (!command) {
      // Just the wake word — acknowledge and listen for the actual command.
      arm()
      speakRef.current?.('Yeah? What do you need?')
      return
    }
    disarm()
    sendTurn(command)
  }, [arm, disarm, sendTurn])

  const { supported, listening, start, stop, speak, speaking } = useVoice({ onFinal, onInterim })
  useEffect(() => { speakRef.current = speak }, [speak])

  // Hands-free: listen app-wide whenever not muted — even with the panel closed
  // — so "hey coach" works from any screen without tapping anything first.
  const voiceOn = !muted
  useEffect(() => {
    if (!supported) return
    if (voiceOn && !listening) start()
    if (!voiceOn && listening) stop()
  }, [voiceOn, supported, listening, start, stop])

  // Belt-and-suspenders: some browsers block the mic until a user gesture grants
  // permission, so the on-mount start() above can no-op silently. Kick listening
  // off on the very first interaction anywhere on the page — the user never has
  // to find the mic button. Runs once, then removes itself.
  useEffect(() => {
    if (!supported) return
    const kick = () => { if (!muted) start() }
    window.addEventListener('pointerdown', kick, { once: true })
    window.addEventListener('keydown', kick, { once: true })
    return () => {
      window.removeEventListener('pointerdown', kick)
      window.removeEventListener('keydown', kick)
    }
  }, [supported, muted, start])

  // ── Coach replies: record, speak, navigate ────────────────────────
  const lastAgentAt = useRef(0)
  useEffect(() => {
    if (!agentReply) return
    clearTimeout(thinkTimer.current)
    setThinking(false)
    lastAgentAt.current = Date.now()
    if (agentReply.text) {
      addMessage('coach', agentReply.text)
      speak(agentReply.text)
    }
    const screen = NAV_ACTIONS[agentReply.action]
    if (screen) setScreen?.(screen)
  }, [agentReply, addMessage, speak, setScreen])

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
    addMessage('coach', summary)
    speak(summary)
  }, [state, speak, addMessage])

  // ── Announce camera / framing problems on the LIVE screen only ────
  // Hands-off guidance: if tracking is degraded or lost while the patient is on
  // the workout screen (getting into position or mid-set), say so out loud, and
  // confirm when it recovers — so they never have to look at the screen. Gated
  // to the live screen so it never fires while browsing check-in. Re-nags slowly
  // (~25s) and never talks over an in-flight reply or another cue.
  const lastSetupCodeRef = useRef('')
  const lastSetupAtRef = useRef(0)
  const wasBadRef = useRef(false)
  useEffect(() => {
    if (screen !== 'live') return
    const su = state?.setup_status
    if (!su) return
    // Don't talk over a conversational reply or any cue currently playing.
    if (speaking || Date.now() - lastAgentAt.current < 2500) return
    const sev = su.severity
    const code = su.code || ''
    const hint = su.hint || ''
    if (sev === 'warning' || sev === 'blocking') {
      // Speak a framing problem at most once every ~30s, and never re-announce
      // the same code twice in a row — so a camera that flickers between two
      // warning codes (or sits in one) doesn't repeat "step back" constantly.
      const changed = code !== lastSetupCodeRef.current
      const cooled = Date.now() - lastSetupAtRef.current > 30000
      if (hint && changed && cooled) {
        speak(hint)
        lastSetupAtRef.current = Date.now()
        wasBadRef.current = true
      }
      lastSetupCodeRef.current = code
    } else if (sev === 'good' || code === 'ok') {
      if (wasBadRef.current) {
        speak('Got you — go ahead.')
        wasBadRef.current = false
      }
      lastSetupCodeRef.current = code
    }
  }, [state, screen, speaking, speak])

  // ── Explain a rep that didn't count, in the moment ────────────────
  const lastVoidRef = useRef(0)
  useEffect(() => {
    const vc = state?.rep_void_count ?? 0
    if (vc > lastVoidRef.current && state?.phase === 'SET_ACTIVE') {
      const phrase = VOID_PHRASES[state?.rep_void_reason] ||
        "That one didn't count — reset and try again."
      speak(phrase)
    }
    lastVoidRef.current = vc
  }, [state, speak])

  // ── During an active set: minimal deterministic cues on each new rep ──
  // Rate-limited so the coach stays mostly quiet: at most one cue every ~8s, and
  // the SAME line never repeats back-to-back (so a persistently-flagged rep
  // doesn't trigger "slow it down" on every single rep). Keeping the coach quiet
  // also matters for the wake word — the mic is deaf while the coach is talking,
  // so constant cues would swallow "hey coach".
  const lastRep = useRef(0)
  const lastPhase = useRef(null)
  const lastCueAt = useRef(0)
  const lastCueText = useRef('')
  const CUE_MIN_GAP_MS = 8000
  useEffect(() => {
    const phase = state?.phase
    const reps = state?.rep_count ?? 0
    if (phase !== 'SET_ACTIVE') {
      lastRep.current = reps
      lastPhase.current = phase
      return
    }
    if (lastPhase.current !== 'SET_ACTIVE') lastRep.current = reps
    lastPhase.current = phase

    if (reps > lastRep.current) {
      lastRep.current = reps
      const formFlag = Array.isArray(state.form_flags) ? state.form_flags[0] : null
      const cue = cueForRep({ reps, target: state.rep_target, formFlag })
      if (!cue) return
      const now = Date.now()
      // Always allow the final-rep countdown through; rate-limit everything else.
      const isCountdown = cue === 'Two more.' || cue === 'Last one.'
      const tooSoon = now - lastCueAt.current < CUE_MIN_GAP_MS
      const repeat = cue === lastCueText.current
      if (!isCountdown && (tooSoon || repeat)) return
      lastCueAt.current = now
      lastCueText.current = cue
      speak(cue)
    }
  }, [state, speak])

  // Auto-scroll the transcript.
  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, thinking, partial, open])

  useEffect(() => () => {
    clearTimeout(armTimer.current)
    clearTimeout(thinkTimer.current)
  }, [])

  if (!supported) return null

  const status = thinking ? 'thinking'
    : speaking ? 'speaking'
    : !voiceOn ? 'idle'
    : armedUi ? 'armed'
    : 'listening'

  const handleSubmit = (e) => {
    e.preventDefault()
    const t = typed.trim()
    if (!t) return
    sendTurn(t)
    setTyped('')
    inputRef.current?.focus()
  }

  // ── Closed: floating mic FAB ──────────────────────────────────────
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => { setOpen(true); if (!muted) start() }}
        title={voiceOn ? 'Listening for “hey coach” — tap to open' : 'Talk to Coach'}
        className="fixed bottom-5 right-5 z-50 w-14 h-14 rounded-full bg-brand text-white shadow-lg flex items-center justify-center hover:opacity-90 transition-opacity active:scale-95"
      >
        {/* When hands-free listening is active, show a subtle breathing ring so
            it's clear the wake word works even with the panel closed. */}
        {voiceOn && (
          <span className="absolute inset-0 rounded-full border-2 border-white/50 voice-breathe" />
        )}
        <i className="ti ti-microphone text-xl" />
      </button>
    )
  }

  // ── Open: chat panel ──────────────────────────────────────────────
  return (
    <div className="fixed bottom-5 right-5 z-50 w-[min(92vw,24rem)] max-h-[min(70vh,32rem)] bg-white rounded-2xl shadow-2xl border border-hair flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-hair shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="relative w-8 h-8 rounded-full bg-brand-bg text-brand flex items-center justify-center">
            <i className="ti ti-activity text-sm" />
            {voiceOn && (
              <span className="absolute inset-0 rounded-full border border-brand/40 voice-breathe" />
            )}
          </div>
          <div className="leading-tight">
            <div className="text-sm font-medium text-ink">Coach</div>
            <div className="text-[10px] text-ink-faint">{STATUS_LABEL[status]}</div>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={() => setMessages([])}
              title="Clear chat"
              className="p-1.5 rounded-md text-ink-faint hover:text-ink hover:bg-surface transition-colors"
            >
              <i className="ti ti-trash text-sm" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            title="Close"
            className="p-1.5 rounded-md text-ink-faint hover:text-ink hover:bg-surface transition-colors"
          >
            <i className="ti ti-x text-sm" />
          </button>
        </div>
      </div>

      {/* Transcript */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2.5 min-h-[180px]">
        {messages.length === 0 && !partial && (
          <div className="flex flex-col items-center justify-center h-full gap-3 text-center py-6">
            <div className="w-12 h-12 rounded-full bg-brand-bg text-brand flex items-center justify-center">
              <i className="ti ti-microphone text-xl" />
            </div>
            <p className="text-sm text-ink-soft px-4">
              Say <span className="font-medium text-ink">“hey coach”</span> then your request — or type below.
            </p>
            <div className="flex flex-wrap justify-center gap-1.5 px-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => sendTurn(s)}
                  className="text-xs text-ink-soft bg-surface hover:bg-hair/60 rounded-full px-3 py-1.5 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div
              className={`max-w-[80%] px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
                msg.role === 'user'
                  ? 'bg-brand text-white rounded-br-md'
                  : 'bg-surface text-ink rounded-bl-md'
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {partial && !thinking && (
          <div className="flex justify-end">
            <div className="max-w-[80%] px-3.5 py-2.5 rounded-2xl rounded-br-md text-sm leading-relaxed bg-brand/40 text-white italic">
              {partial}
            </div>
          </div>
        )}
        {thinking && (
          <div className="flex justify-start">
            <div className="bg-surface text-ink-faint px-3.5 py-2.5 rounded-2xl rounded-bl-md text-sm">
              <span className="inline-flex gap-1">
                <span className="animate-bounce">·</span>
                <span className="animate-bounce" style={{ animationDelay: '0.1s' }}>·</span>
                <span className="animate-bounce" style={{ animationDelay: '0.2s' }}>·</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Input bar */}
      <form onSubmit={handleSubmit} className="px-3 py-2.5 border-t border-hair shrink-0 flex items-center gap-2">
        {/* Mic on/off toggle */}
        <button
          type="button"
          onClick={() => setMuted((m) => !m)}
          title={muted ? 'Turn the mic on' : 'Mute the mic'}
          aria-pressed={!muted}
          className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${
            voiceOn
              ? 'bg-brand text-white'
              : 'bg-surface text-ink-soft hover:text-ink'
          }`}
        >
          <i className={`ti ti-microphone${muted ? '-off' : ''} text-base ${armedUi ? 'animate-pulse' : ''}`} />
        </button>

        {/* Text input */}
        <input
          ref={inputRef}
          type="text"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Message Coach…"
          className="flex-1 px-3 py-2 rounded-xl border border-hair bg-white text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-brand"
        />
        <button
          type="submit"
          disabled={!typed.trim()}
          title="Send"
          className="w-9 h-9 rounded-xl bg-brand text-white flex items-center justify-center shrink-0 disabled:opacity-40 hover:opacity-90 transition-opacity"
        >
          <i className="ti ti-send text-sm" />
        </button>
      </form>
    </div>
  )
}
