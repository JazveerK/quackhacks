import { useState, useRef, useCallback } from "react"

/**
 * Hook for on-demand debrief TTS.
 * Tries ElevenLabs via /coach/speak first; falls back to browser speechSynthesis.
 * Returns { audioState, play, stop }
 *   audioState: "idle" | "loading" | "playing"
 */
export function useDebriefAudio() {
  const [audioState, setAudioState] = useState("idle")
  const audioRef = useRef(null)
  const urlRef = useRef(null)
  const uttRef = useRef(null)

  const cleanup = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
    if (uttRef.current) {
      window.speechSynthesis?.cancel()
      uttRef.current = null
    }
  }, [])

  // Browser TTS fallback
  const playBrowserTTS = useCallback((text) => {
    if (!window.speechSynthesis) {
      setAudioState("idle")
      return
    }
    const utt = new SpeechSynthesisUtterance(text)
    utt.rate = 0.95
    utt.pitch = 1.0
    uttRef.current = utt
    utt.onend = () => {
      uttRef.current = null
      setAudioState("idle")
    }
    utt.onerror = () => {
      uttRef.current = null
      setAudioState("idle")
    }
    setAudioState("playing")
    window.speechSynthesis.speak(utt)
  }, [])

  const play = useCallback(async (text) => {
    if (!text) return
    cleanup()
    setAudioState("loading")

    // Try ElevenLabs backend first
    try {
      const res = await fetch("/coach/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error("backend unavailable")
      const url = URL.createObjectURL(await res.blob())
      urlRef.current = url
      const audio = new Audio(url)
      audioRef.current = audio
      audio.onended = () => {
        cleanup()
        setAudioState("idle")
      }
      setAudioState("playing")
      await audio.play()
      return
    } catch {
      // ElevenLabs unavailable — fall back to browser TTS
    }

    playBrowserTTS(text)
  }, [cleanup, playBrowserTTS])

  const stop = useCallback(() => {
    cleanup()
    setAudioState("idle")
  }, [cleanup])

  return { audioState, play, stop }
}
