import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Hands-free speech I/O for the voice assistant.
 *
 * Listening: Web Speech API (SpeechRecognition), continuous + auto-restarting
 *   (Chrome drops recognition every ~minute). Interim results stream to
 *   `onInterim(text)`; each finalized utterance fires `onFinal(text)`. The
 *   caller decides what to do with them (send to the agent, drive status, …).
 * Speaking: speak(text) hits the server's /tts (ElevenLabs) for a natural voice
 *   and falls back to the browser's SpeechSynthesis. Recognition is muted while
 *   speaking so the coach's own voice doesn't feed back into the mic.
 *
 * Returns { supported, listening, start, stop, toggle, speak, cancelSpeak, speaking }.
 */
export default function useVoice({ onFinal, onInterim } = {}) {
  const RecognitionCtor =
    typeof window !== 'undefined'
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null
  const supported = !!RecognitionCtor

  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)

  const recRef = useRef(null)
  const wantRef = useRef(false)      // user intends to keep listening (auto-restart)
  const speakingRef = useRef(false)  // gate mic input while the coach talks
  const audioRef = useRef(null)
  // Keep the latest callbacks without re-creating the recognizer each render.
  const finalRef = useRef(onFinal)
  const interimRef = useRef(onInterim)
  useEffect(() => { finalRef.current = onFinal }, [onFinal])
  useEffect(() => { interimRef.current = onInterim }, [onInterim])

  useEffect(() => {
    if (!supported) return
    const rec = new RecognitionCtor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'

    rec.onresult = (e) => {
      // Drop anything captured while the coach is speaking — that's just the
      // TTS bleeding back through the mic, not the patient.
      if (speakingRef.current) return
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const text = r[0].transcript.trim()
        if (r.isFinal) {
          if (text) finalRef.current?.(text)
        } else {
          interim += text
        }
      }
      if (interim) interimRef.current?.(interim)
    }
    rec.onend = () => {
      if (wantRef.current) {
        try { rec.start() } catch { /* already starting */ }
      } else {
        setListening(false)
      }
    }
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        wantRef.current = false
        setListening(false)
      }
    }
    recRef.current = rec
    return () => {
      wantRef.current = false
      try { rec.stop() } catch { /* noop */ }
    }
  }, [supported, RecognitionCtor])

  const start = useCallback(() => {
    if (!recRef.current) return
    wantRef.current = true
    try { recRef.current.start(); setListening(true) } catch { /* already running */ }
  }, [])

  const stop = useCallback(() => {
    wantRef.current = false
    try { recRef.current?.stop() } catch { /* noop */ }
    setListening(false)
  }, [])

  const toggle = useCallback(() => {
    if (listening) stop()
    else start()
  }, [listening, start, stop])

  const cancelSpeak = useCallback(() => {
    try { audioRef.current?.pause() } catch { /* noop */ }
    audioRef.current = null
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel()
    speakingRef.current = false
    setSpeaking(false)
  }, [])

  const speak = useCallback(async (text) => {
    if (!text) return
    cancelSpeak()
    speakingRef.current = true
    setSpeaking(true)

    const done = () => {
      speakingRef.current = false
      setSpeaking(false)
      audioRef.current = null
    }

    try {
      const res = await fetch('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (res.ok) {
        const url = URL.createObjectURL(await res.blob())
        const audio = new Audio(url)
        audioRef.current = audio
        audio.onended = () => { done(); URL.revokeObjectURL(url) }
        audio.onerror = () => { done(); URL.revokeObjectURL(url) }
        await audio.play()
        return
      }
    } catch { /* fall through to browser TTS */ }

    // Fallback: browser SpeechSynthesis.
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.onend = done
      u.onerror = done
      window.speechSynthesis.speak(u)
    } catch {
      done()
    }
  }, [cancelSpeak])

  return { supported, listening, start, stop, toggle, speak, cancelSpeak, speaking }
}
