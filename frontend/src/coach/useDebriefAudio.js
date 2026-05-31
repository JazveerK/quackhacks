import { useState, useRef, useCallback } from "react"

/**
 * Hook for on-demand debrief TTS via the backend /coach/speak endpoint.
 * Returns { audioState, play, stop }
 *   audioState: "idle" | "loading" | "playing"
 */
export function useDebriefAudio() {
  const [audioState, setAudioState] = useState("idle")
  const audioRef = useRef(null)
  const urlRef = useRef(null)

  const cleanup = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause()
      audioRef.current = null
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current)
      urlRef.current = null
    }
  }, [])

  const play = useCallback(async (text) => {
    if (!text) return
    cleanup()
    try {
      setAudioState("loading")
      const res = await fetch("/coach/speak", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      })
      if (!res.ok) throw new Error(await res.text())
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
    } catch (e) {
      console.error("debrief audio:", e)
      cleanup()
      setAudioState("idle")
    }
  }, [cleanup])

  const stop = useCallback(() => {
    cleanup()
    setAudioState("idle")
  }, [cleanup])

  return { audioState, play, stop }
}
