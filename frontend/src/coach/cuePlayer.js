/**
 * Plays coach cue audio.
 * Tries pre-generated MP3s from /cues/<id>.mp3 first.
 * Falls back to browser speechSynthesis if the file doesn't exist.
 * Deduplicates: won't retrigger the same cue on consecutive frames.
 */

const cache = new Map()
const failedIds = new Set()

// Spoken text for each cue ID (used by browser TTS fallback)
const CUE_TEXT = {
  go_deeper: "Go deeper",
  too_fast: "Slow it down",
  good_depth: "Good depth",
  nice_form: "Nice form",
  hold_it: "Hold it",
}

function clip(id) {
  if (!cache.has(id)) cache.set(id, new Audio(`/cues/${id}.mp3`))
  return cache.get(id)
}

function speakFallback(id) {
  if (!window.speechSynthesis) return
  const text = CUE_TEXT[id] || id.replace(/_/g, " ")
  const utt = new SpeechSynthesisUtterance(text)
  utt.rate = 1.0
  utt.pitch = 1.0
  utt.volume = 0.8
  window.speechSynthesis.speak(utt)
}

let last = null

export function playCue(id) {
  if (!id || id === last) return
  last = id

  // If we already know the MP3 doesn't exist, go straight to TTS
  if (failedIds.has(id)) {
    speakFallback(id)
    return
  }

  const a = clip(id)
  a.currentTime = 0
  a.play().catch(() => {
    // MP3 not found or autoplay blocked — use browser TTS
    failedIds.add(id)
    speakFallback(id)
  })
}

export function resetCue() {
  last = null
}
