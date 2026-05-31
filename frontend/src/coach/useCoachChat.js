import { useState, useRef, useCallback } from "react"

const SR =
  typeof window !== "undefined"
    ? window.SpeechRecognition || window.webkitSpeechRecognition
    : null

/**
 * Conversational coach: mic → speech-to-text → Gemini → ElevenLabs → speaker.
 *
 * Returns {
 *   messages,       // [{role: "user"|"coach", text}]
 *   status,         // "idle" | "listening" | "thinking" | "speaking"
 *   startListening, // begin mic capture
 *   stopListening,  // cancel mic
 *   sendText,       // send typed text directly
 *   clearHistory,
 * }
 */
export function useCoachChat(sessionState) {
  const [messages, setMessages] = useState([])
  const [status, setStatus] = useState("idle") // idle | listening | thinking | speaking
  const recRef = useRef(null)
  const audioRef = useRef(null)

  const historyForApi = useCallback(
    () => messages.slice(-6).map((m) => ({ role: m.role, text: m.text })),
    [messages]
  )

  // ── Send text to backend and play response ──
  const sendText = useCallback(
    async (text) => {
      if (!text.trim()) return
      const userMsg = { role: "user", text: text.trim() }
      setMessages((prev) => [...prev, userMsg])
      setStatus("thinking")

      try {
        // Step 1: get text reply from Gemini
        const chatRes = await fetch("/coach/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: text.trim(),
            session_state: sessionState?.current ?? sessionState,
            history: [...historyForApi(), userMsg],
          }),
        })

        if (!chatRes.ok) throw new Error(await chatRes.text())
        const { text: replyText, audio_available } = await chatRes.json()

        const coachMsg = { role: "coach", text: replyText }
        setMessages((prev) => [...prev, coachMsg])

        // Step 2: generate audio via /coach/speak
        if (audio_available) {
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
          } catch (e) {
            console.warn("Coach audio failed, text-only:", e)
          }
        }
        setStatus("idle")
      } catch (e) {
        console.error("Coach chat error:", e)
        setMessages((prev) => [
          ...prev,
          { role: "coach", text: "Sorry, I couldn't process that. Try again?" },
        ])
        setStatus("idle")
      }
    },
    [sessionState, historyForApi]
  )

  // ── Mic: speech recognition ──
  const startListening = useCallback(() => {
    if (!SR) {
      console.warn("Speech recognition not supported")
      return
    }
    // Stop any playing audio
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }

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
    setStatus("idle")
  }, [])

  return { messages, status, startListening, stopListening, sendText, clearHistory }
}
