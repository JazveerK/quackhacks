/**
 * Deterministic, minimal during-set voice cues.
 *
 * The active set should be quiet and focused — no chit-chat, no LLM latency.
 * This returns at most ONE short line per rep, only at meaningful moments
 * (a form correction, the halfway mark, and the final countdown). Returns null
 * for reps that don't warrant a cue, so most reps pass in silence.
 *
 *   cueForRep({ reps, target, formFlag }) -> string | null
 *
 * `reps` is the new rep count (just incremented), `target` the set goal,
 * `formFlag` an optional backend form flag for this rep (e.g. "shallow").
 */
export function cueForRep({ reps, target, formFlag }) {
  // Form correction takes priority — it's the only thing worth interrupting for.
  // The caller (VoiceAssistant) rate-limits these so the same correction can't
  // repeat every rep; here we just classify the flag into a short line.
  if (formFlag) {
    const f = String(formFlag).toLowerCase()
    if (f.includes('shallow') || f.includes('depth')) return 'A little deeper.'
    if (f.includes('fast') || f.includes('tempo')) return 'Slow it down.'
    if (f.includes('valgus') || f.includes('knee')) return 'Knees out.'
  }

  if (!target || target <= 0) return null
  const left = target - reps

  // Final two reps only — keep the set quiet otherwise.
  if (left === 2) return 'Two more.'
  if (left === 1) return 'Last one.'
  if (left <= 0) return null // set completion is handled by the debrief flow

  // Halfway marker (only for sets long enough to have a meaningful midpoint).
  if (target >= 8 && reps === Math.ceil(target / 2)) return 'Halfway — keep it steady.'

  // Everything else passes in silence. No per-rep motivational chatter.
  return null
}
