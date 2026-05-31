import { useState, useRef, useEffect } from "react"
import { useCoachChat } from "../coach/useCoachChat"

const STATUS_LABEL = {
  idle: "Talk to Coach",
  listening: "Listening…",
  thinking: "Thinking…",
  speaking: "Speaking…",
}

export default function CoachChat({ sessionState }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState("")
  const scrollRef = useRef(null)

  const { messages, status, startListening, stopListening, sendText, clearHistory } =
    useCoachChat(sessionState)

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [messages, open])

  function handleMicClick() {
    if (status === "listening") {
      stopListening()
    } else if (status === "idle") {
      startListening()
    }
  }

  function handleSend(e) {
    e.preventDefault()
    if (typed.trim() && status === "idle") {
      sendText(typed.trim())
      setTyped("")
    }
  }

  // Floating mic button when closed
  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-50 w-14 h-14 rounded-full bg-brand text-white shadow-lg flex items-center justify-center hover:opacity-90 transition-opacity"
        title="Talk to Coach"
      >
        <i className="ti ti-microphone text-xl" />
      </button>
    )
  }

  const busy = status === "thinking" || status === "speaking"

  return (
    <div className="fixed bottom-6 right-6 z-50 w-96 max-h-[520px] bg-white rounded-xl shadow-2xl border border-hair flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-hair shrink-0">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-full bg-brand-bg text-brand flex items-center justify-center">
            <i className="ti ti-activity text-sm" />
          </div>
          <div>
            <span className="text-sm font-medium text-ink">Coach</span>
            <span className="text-[10px] text-ink-faint ml-2">{STATUS_LABEL[status]}</span>
          </div>
        </div>
        <div className="flex items-center gap-1">
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearHistory}
              className="p-1.5 rounded-md text-ink-faint hover:text-ink hover:bg-surface transition-colors"
              title="Clear chat"
            >
              <i className="ti ti-trash text-sm" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="p-1.5 rounded-md text-ink-faint hover:text-ink hover:bg-surface transition-colors"
          >
            <i className="ti ti-x text-sm" />
          </button>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-[200px]">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full gap-2 text-center py-8">
            <div className="w-12 h-12 rounded-full bg-brand-bg text-brand flex items-center justify-center">
              <i className="ti ti-microphone text-xl" />
            </div>
            <p className="text-sm text-ink-soft">
              Tap the mic and ask your coach anything
            </p>
            <p className="text-xs text-ink-faint">
              "How's my form?" · "Should I go deeper?" · "I feel some tightness"
            </p>
          </div>
        )}
        {messages.map((msg, i) => (
          <div
            key={i}
            className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className={`max-w-[80%] px-3.5 py-2.5 rounded-xl text-sm leading-relaxed ${
                msg.role === "user"
                  ? "bg-brand text-white rounded-br-sm"
                  : "bg-surface text-ink rounded-bl-sm"
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {status === "thinking" && (
          <div className="flex justify-start">
            <div className="bg-surface text-ink-faint px-3.5 py-2.5 rounded-xl rounded-bl-sm text-sm">
              <span className="inline-flex gap-1">
                <span className="animate-bounce">·</span>
                <span className="animate-bounce" style={{ animationDelay: "0.1s" }}>·</span>
                <span className="animate-bounce" style={{ animationDelay: "0.2s" }}>·</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Input bar */}
      <div className="px-3 py-2.5 border-t border-hair shrink-0 flex items-center gap-2">
        {/* Mic button */}
        <button
          type="button"
          onClick={handleMicClick}
          disabled={busy}
          className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 transition-colors ${
            status === "listening"
              ? "bg-brand text-white animate-pulse"
              : busy
                ? "bg-surface text-ink-faint cursor-not-allowed"
                : "bg-surface text-ink-soft hover:text-ink"
          }`}
          title={status === "listening" ? "Stop listening" : "Tap to speak"}
        >
          <i className={`ti ti-${status === "listening" ? "player-stop" : "microphone"} text-base`} />
        </button>

        {/* Text input */}
        <form onSubmit={handleSend} className="flex-1 flex items-center gap-2">
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={busy ? STATUS_LABEL[status] : "Type a message…"}
            disabled={busy}
            className="flex-1 px-3 py-2 rounded-lg border border-hair bg-white text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-1 focus:ring-brand disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={busy || !typed.trim()}
            className="w-9 h-9 rounded-lg bg-brand text-white flex items-center justify-center shrink-0 disabled:opacity-40 hover:opacity-90 transition-opacity"
          >
            <i className="ti ti-send text-sm" />
          </button>
        </form>
      </div>
    </div>
  )
}
