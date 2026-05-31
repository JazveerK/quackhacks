import { useState, useRef, useCallback } from "react"

const SR =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null

// ── Offline fallback responses when backend is unavailable ──────────
const OFFLINE_RESPONSES = [
  "You're doing great — keep your core tight and control the descent.",
  "Focus on pushing through your heels as you come up.",
  "Try to keep your knees tracking over your toes.",
  "Nice steady pace. If you feel any pain, take a break.",
  "Remember: depth is more important than speed. Go slow.",
  "Your form looks consistent. Keep it up!",
]

function getOfflineReply(message) {
  const lower = message.toLowerCase()
  if (lower.includes("form") || lower.includes("doing"))
    return "Based on your session data, your form is looking solid. Focus on maintaining consistent depth across all reps."
  if (lower.includes("deeper") || lower.includes("depth"))
    return "Try widening your stance slightly and sitting back into your hips. Think about sitting into a chair behind you."
  if (lower.includes("pain") || lower.includes("hurt") || lower.includes("tight"))
    return "If you're feeling pain, stop and rest. Some muscle tightness is normal, but sharp pain is not. Let your PT know at your next visit."
  if (lower.includes("tired") || lower.includes("fatigue"))
    return "It's okay to feel fatigued. Reduce your rep count by 2 and focus on quality over quantity for the remaining reps."
  return OFFLINE_RESPONSES[Math.floor(Math.random() * OFFLINE_RESPONSES.length)]
}

// ── Browser TTS helper ──────────────────────────────────────────────
function speakBrowser(text) {
  if (!window.speechSynthesis) return Promise.resolve()
  return new Promise((resolve) => {
    const utt = new SpeechSynthesisUtterance(text)
    utt.rate = 0.95
    utt.pitch = 1.0
    utt.onend = resolve
    utt.onerror = resolve
    window.speechSynthesis.speak(utt)
  })
}

/**
 * Conversational coach: mic -> speech-to-text -> Gemini -> ElevenLabs -> speaker.
 * Falls back to offline responses + browser TTS when backend is unavailable.
 */
export function useCoachChat(sessionState) {
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState("idle")
  const recRef = useRef(null)
  const audioRef = useRef(null)

  const historyForApi = useCallback(
    () => messages.slice(-6).map((m) => ({ role: m.role, text: m.text })),
    [messages]
  )

  const sendText = useCallback(
    async (text) => {
      if (!text.trim()) return
      const userMsg = { role: "user", text: text.trim() }
      setMessages((prev) => [...prev, userMsg])
      setStatus("thinking")

      let replyText = null

      // Try backend (Gemini) first
      try {
        const chatRes = await fetch("/coach/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text.trim(),
            session_state: sessionState?.current ?? sessionState,
            history: [...historyForApi(), userMsg],
          }),
        })

        if (!chatRes.ok) throw new Error("backend unavailable")
        const data = await chatRes.json()
        replyText = data.text

        const coachMsg = { role: "coach", text: replyText }
        setMessages((prev) => [...prev, coachMsg])

        // Try ElevenLabs audio
        if (data.audio_available) {
          setStatus("speaking")
          try {
            const audioRes = await fetch("/coach/speak", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: replyText }),
            })
            if (audioRes.ok) {
              const blob = await audioRes.blob()
              const url = URL.createObjectURL(blob)
              const audio = new Audio(url)
              audioRef.current = audio
              audio.onended = () => {
                URL.revokeObjectURL(url)
                audioRef.current = null
                setStatus("idle")
              }
              await audio.play()
              return
            }
          } catch {
            // ElevenLabs failed — try browser TTS
          }
        }

        // Fall back to browser TTS for the response
        setStatus("speaking")
        await speakBrowser(replyText)
        setStatus("idle")
        return
      } catch {
        // Backend entirely unavailable — use offline responses
      }

      // Offline fallback
      replyText = getOfflineReply(text.trim())
      const coachMsg = { role: "coach", text: replyText }
      setMessages((prev) => [...prev, coachMsg])

      // Speak via browser TTS
      setStatus("speaking")
      await speakBrowser(replyText)
      setStatus("idle")
    },
    [sessionState, historyForApi]
  )

  const startListening = useCallback(() => {
    if (!SR) {
      console.warn("Speech recognition not supported")
      return
    }
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    window.speechSynthesis?.cancel()

    const rec = new SR()
    rec.lang = "en-US"
    rec.continuous = false
    rec.interimResults = false
    recRef.current = rec

    rec.onresult = (e) => {
      const transcript = e.results[0]?.[0]?.transcript
      if (transcript) sendText(transcript)
    }
    rec.onerror = (e) => {
      console.warn("Speech recognition error:", e.error)
      setStatus("idle")
    }
    rec.onend = () => {
      if (status === "listening") setStatus("idle")
    }

    setStatus("listening")
    rec.start()
  }, [sendText, status])

  const stopListening = useCallback(() => {
    recRef.current?.stop()
    setStatus("idle")
  }, [])

  const clearHistory = useCallback(() => {
    setMessages([])
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    window.speechSynthesis?.cancel()
    setStatus("idle")
  }, [])

  return { messages, status, startListening, stopListening, sendText, clearHistory }
}
