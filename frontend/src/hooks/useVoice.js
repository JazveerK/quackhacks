import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Voice coach hook.
 *
 * - Listening: Web Speech API (SpeechRecognition). Each finalized utterance is
 *   sent to the backend as { cmd: 'say', text } so the Gemini agent can reply
 *   and drive the session (start/end/next set, end session).
 * - Speaking: speak(text) tries the server's /tts (ElevenLabs) for a natural
 *   voice and falls back to the browser's built-in SpeechSynthesis. Voice is
 *   never load-bearing — if everything fails it just stays silent.
 *
 * Returns { supported, listening, toggle, start, stop, transcript, speak, speaking }.
 */
export default function useVoice(send) {
  const RecognitionCtor =
    typeof window !== 'undefined'
      ? window.SpeechRecognition || window.webkitSpeechRecognition
      : null
  const supported = !!RecognitionCtor

  const [listening, setListening] = useState(false)
  const [speaking, setSpeaking] = useState(false)
  const [transcript, setTranscript] = useState('')
  const recRef = useRef(null)
  const wantRef = useRef(false) // user intends to keep listening (auto-restart)
  const audioRef = useRef(null)

  useEffect(() => {
    if (!supported) return
    const rec = new RecognitionCtor()
    rec.continuous = true
    rec.interimResults = true
    rec.lang = 'en-US'

    rec.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]
        const text = r[0].transcript.trim()
        if (r.isFinal) {
          if (text) send?.({ cmd: 'say', text })
          setTranscript(text)
        } else {
          interim += text
        }
      }
      if (interim) setTranscript(interim)
    }
    rec.onend = () => {
      // Chrome stops recognition periodically; restart if the user still wants it.
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
  }, [supported, send])

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

  const speak = useCallback(async (text) => {
    if (!text) return
    // Stop any in-flight speech first.
    try { audioRef.current?.pause() } catch { /* noop */ }
    if (typeof window !== 'undefined') window.speechSynthesis?.cancel()

    setSpeaking(true)
    try {
      const res = await fetch('/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (res.ok) {
        const buf = await res.blob()
        const url = URL.createObjectURL(buf)
        const audio = new Audio(url)
        audioRef.current = audio
        audio.onended = () => { setSpeaking(false); URL.revokeObjectURL(url) }
        audio.onerror = () => { setSpeaking(false); URL.revokeObjectURL(url) }
        await audio.play()
        return
      }
    } catch { /* fall through to browser TTS */ }

    // Fallback: browser SpeechSynthesis.
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.onend = () => setSpeaking(false)
      u.onerror = () => setSpeaking(false)
      window.speechSynthesis.speak(u)
    } catch {
      setSpeaking(false)
    }
  }, [])

  return { supported, listening, toggle, start, stop, transcript, speak, speaking }
}
