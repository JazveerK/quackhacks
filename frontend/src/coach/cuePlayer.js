/**
 * Plays pre-generated coach cue MP3s from /cues/<id>.mp3.
 * Caches Audio objects so each file is loaded once.
 * Deduplicates: won't retrigger the same cue on consecutive frames.
 */

const cache = new Map()

function clip(id) {
  if (!cache.has(id)) cache.set(id, new Audio(`/cues/${id}.mp3`))
  return cache.get(id)
}

let last = null

export function playCue(id) {
  if (!id || id === last) return
  last = id
  const a = clip(id)
  a.currentTime = 0
  a.play().catch(() => {}) // ignore autoplay rejections pre-gesture
}

export function resetCue() {
  last = null
}
