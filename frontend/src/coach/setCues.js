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
const MOTIVATION = ['Nice and controlled.', 'Good rep.', 'Strong.', 'Smooth.']

export function cueForRep({ reps, target, formFlag }) {
  // Form correction takes priority — it's the only thing worth interrupting for.
  if (formFlag) {
    const f = String(formFlag).toLowerCase()
    if (f.includes('shallow') || f.includes('depth')) return 'A little deeper.'
    if (f.includes('fast') || f.includes('tempo')) return 'Slow it down.'
    if (f.includes('valgus') || f.includes('knee')) return 'Knees out.'
  }

  if (!target || target <= 0) return null
  const left = target - reps

  // Final countdown.
  if (left === 3) return 'Three to go.'
  if (left === 2) return 'Two more.'
  if (left === 1) return 'Last one.'
  if (left <= 0) return null // set completion is handled by the debrief flow

  // Halfway marker (only for sets long enough to have a meaningful midpoint).
  if (target >= 6 && reps === Math.ceil(target / 2)) return 'Halfway — keep it steady.'

  // Otherwise stay quiet most of the time; an occasional light nudge.
  if (reps > 0 && reps % 3 === 0) return MOTIVATION[(reps / 3) % MOTIVATION.length | 0]
  return null
}
