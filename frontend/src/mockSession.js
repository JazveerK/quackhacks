import { useState, useEffect, useRef } from 'react'

const PROFILE = {
  patient_name: 'Sam',
  condition: 'post-ACL repair, left knee, 6 weeks',
  sets: 3,
  reps_per_set: 8,
  depth_deg: 100.0,
  tempo_sec: 3.0,
  focus: 'controlled eccentric; quad re-engagement',
  contraindications: ['no valgus collapse', 'no pain in L knee'],
  source: 'default',
}

function makeSummary(repDepths) {
  const depths = repDepths.length > 0 ? repDepths : [92]
  const targetDeg = 95
  const mean = depths.reduce((a, b) => a + b, 0) / depths.length
  const atTarget = depths.filter(d => d <= targetDeg).length
  const hitRate = atTarget / depths.length
  const mid = Math.floor(depths.length / 2)
  const firstHalf = depths.slice(0, mid)
  const secondHalf = depths.slice(mid)
  const firstAvg = firstHalf.length ? firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length : mean
  const secondAvg = secondHalf.length ? secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length : mean

  return {
    exercise: 'bodyweight_squat',
    reps_completed: depths.length,
    rep_target: 8,
    rep_depths_deg: depths,
    target_depth_deg: targetDeg,
    depth_trend: secondAvg - firstAvg > 4 ? 'declining_late' : 'consistent',
    form_flag_counts: { shallow: depths.filter(d => d > 100).length, too_fast: 0 },
    fatigue_signal: secondAvg - firstAvg > 4 ? 'depth_decline' : 'none',
    analysis: {
      set_duration_sec: depths.length * 4,
      voided_reps: 0,
      depth: {
        per_rep_deg: depths,
        mean_deg: Math.round(mean * 10) / 10,
        stddev_deg: 5.1,
        min_deg: Math.min(...depths),
        max_deg: Math.max(...depths),
        target_deg: targetDeg,
        reps_at_or_below_target: atTarget,
        target_hit_rate: Math.round(hitRate * 100) / 100,
        trend: secondAvg - firstAvg > 4 ? 'declining_late' : 'consistent',
        first_half_avg_deg: Math.round(firstAvg * 10) / 10,
        second_half_avg_deg: Math.round(secondAvg * 10) / 10,
        halves_delta_deg: Math.round((secondAvg - firstAvg) * 10) / 10,
      },
      tempo: {
        per_rep_sec: depths.map(() => 2.0),
        eccentric_per_rep_sec: depths.map(() => 0.9),
        concentric_per_rep_sec: depths.map(() => 1.1),
        mean_sec: 2.0,
        stddev_sec: 0.2,
        trend: 'consistent',
        halves_delta_sec: 0.1,
        eccentric_concentric_ratio_mean: 0.82,
      },
      rom: { min_deg: Math.min(...depths), max_deg: 175 },
      form: {
        flag_counts: { shallow: depths.filter(d => d > 100).length, too_fast: 0 },
        shallow_rep_indices: depths.map((d, i) => d > 100 ? i + 1 : null).filter(Boolean),
        fast_rep_indices: [],
        notes: [`${atTarget} of ${depths.length} reps at or below target.`],
      },
      tracking: { camera_frame_ratio: 0.91, imu_frame_ratio: 0.09, occlusion_events: 1 },
    },
    templated_debrief:
      `Completed ${depths.length} of 8 reps. Average depth ${Math.round(mean)}° ` +
      `(${Math.round(hitRate * 100)}% at target ${targetDeg}°). ` +
      'Next set, focus on hitting depth on every rep.',
    profile: PROFILE,
    ai_debrief:
      `Nice work Sam. You hit depth on ${atTarget} of ${depths.length} reps, ` +
      'and your eccentric stayed solid early. Next set, drop to 6 reps ' +
      'and hold one count at the bottom.',
  }
}

export function useMockSession() {
  const [state, setState] = useState({
    phase: 'SET_ACTIVE',
    angle: 170,
    rep_count: 0,
    rep_target: 8,
    rom_min: 170,
    rom_max: 175,
    depth_state: 'shallow',
    form_flags: [],
    tempo: 0,
    imu_quality: 0.95,
    landmark_visibility: 0.88,
    tracking_source: 'camera',
    rep_depths: [],
    personal_target_depth_deg: 95,
    setup_status: { ok: true, severity: 'good', code: 'ok', hint: 'Tracking — go.' },
    profile: PROFILE,
  })

  const [summary, setSummary] = useState(null)
  const [aiDebrief, setAiDebrief] = useState(null)
  const internals = useRef({ t0: Date.now(), reps: 0, repDepths: [], setEnded: false })

  useEffect(() => {
    const interval = setInterval(() => {
      const r = internals.current
      if (r.setEnded) return

      const t = (Date.now() - r.t0) / 1000
      const repTarget = 8

      // Squat cycle: 4 seconds per rep
      const cycle = t * (2 * Math.PI / 4)
      const angle = 130 + 45 * Math.sin(cycle)

      // Count reps at top of each cycle
      const newReps = Math.min(Math.floor(t / 4), repTarget)
      if (newReps > r.reps && newReps <= repTarget) {
        r.repDepths.push(Math.round(85 + (newReps - 1) * 2.5))
        r.reps = newReps
      }

      // Occlusion: flip to IMU for 3s every 12s
      const occluded = (Math.floor(t) % 12) >= 9

      // Auto end set
      if (r.reps >= repTarget) {
        r.setEnded = true
        const sum = makeSummary(r.repDepths)
        setSummary(sum)
        setState(prev => ({ ...prev, phase: 'DEBRIEF', angle: 170, rep_count: r.reps }))
        setTimeout(() => {
          setAiDebrief({ text: sum.ai_debrief, summary_seq: 1 })
        }, 1500)
        return
      }

      // Form flags
      const flags = []
      if (angle > 100 && angle < 120 && r.reps >= 5) flags.push('shallow')

      const depth_state = angle < 95 ? 'below_parallel' : angle < 100 ? 'at_parallel' : 'shallow'

      setState({
        phase: 'SET_ACTIVE',
        angle: Math.round(angle * 10) / 10,
        rep_count: r.reps,
        rep_target: repTarget,
        rom_min: r.repDepths.length > 0 ? Math.min(...r.repDepths) : Math.round(angle),
        rom_max: 175,
        depth_state,
        form_flags: flags,
        tempo: r.reps > 0 ? 2.0 : 0,
        imu_quality: 0.95,
        landmark_visibility: occluded ? 0.15 : 0.88,
        tracking_source: occluded ? 'imu' : 'camera',
        rep_depths: [...r.repDepths],
        personal_target_depth_deg: 95,
        setup_status: occluded
          ? { ok: false, severity: 'warning', code: 'legs_out_of_frame', hint: 'Step back so your full body is in the camera.' }
          : { ok: true, severity: 'good', code: 'ok', hint: 'Tracking — go.' },
        profile: PROFILE,
      })
    }, 40) // ~25 fps

    return () => clearInterval(interval)
  }, [])

  function resetSet() {
    internals.current = { t0: Date.now(), reps: 0, repDepths: [], setEnded: false }
    setSummary(null)
    setAiDebrief(null)
  }

  function endSet() {
    const r = internals.current
    if (r.setEnded) return
    r.setEnded = true
    const sum = makeSummary(r.repDepths)
    setSummary(sum)
    setState(prev => ({ ...prev, phase: 'DEBRIEF', angle: 170 }))
    setTimeout(() => setAiDebrief({ text: sum.ai_debrief, summary_seq: 1 }), 1500)
  }

  return { state, summary, aiDebrief, profile: PROFILE, resetSet, endSet }
}
