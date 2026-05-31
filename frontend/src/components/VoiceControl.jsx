/**
 * Voice coach control bar. A mic toggle plus a live transcript of what the
 * patient said and what the coach replied. Hands-free control: "start", "I'm
 * done", "next set", "end my session" all route through the backend agent.
 */
export default function VoiceControl({ voice, lastReply }) {
  const { supported, listening, toggle, transcript, speaking } = voice

  if (!supported) {
    return (
      <div className="flex items-center gap-2 text-[11px] text-tertiary-text">
        <MicOffIcon />
        Voice control needs Chrome or Edge
      </div>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <button
        onClick={toggle}
        aria-pressed={listening}
        className={`relative flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs font-medium transition-colors ${
          listening
            ? 'bg-info text-white'
            : 'bg-surface text-secondary-text hover:bg-surface-white border border-border'
        }`}
      >
        {listening ? <MicIcon /> : <MicOffIcon />}
        {listening ? 'Listening' : 'Voice off'}
        {listening && (
          <span className="absolute -right-0.5 -top-0.5 w-2 h-2 rounded-full bg-success animate-pulse" />
        )}
      </button>

      <div className="min-w-0 flex-1 flex flex-col leading-tight">
        {lastReply?.text && (
          <span className="truncate text-xs text-primary-text">
            <span className="text-info font-medium">Coach</span>
            {speaking ? ' (speaking) · ' : ' · '}
            {lastReply.text}
          </span>
        )}
        {listening && transcript && (
          <span className="truncate text-[11px] text-tertiary-text">
            You · {transcript}
          </span>
        )}
        {!lastReply?.text && !transcript && (
          <span className="truncate text-[11px] text-tertiary-text">
            Try “start my set”, “I’m done”, or “end my session”
          </span>
        )}
      </div>
    </div>
  )
}

function MicIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  )
}

function MicOffIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="1" y1="1" x2="23" y2="23" />
      <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6" />
      <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
      <line x1="12" y1="19" x2="12" y2="22" />
    </svg>
  )
}
