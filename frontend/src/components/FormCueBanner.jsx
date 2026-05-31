import { useState, useEffect, useRef } from 'react'
import { playCue } from '../coach/cuePlayer'

const FLAG_LABELS = {
  shallow: 'Go deeper',
  too_fast: 'Slow it down',
}

const FLAG_CUE_IDS = {
  shallow: 'go_deeper',
  too_fast: 'too_fast',
}

export default function FormCueBanner({ state }) {
  const [cue, setCue] = useState(null)
  const [visible, setVisible] = useState(false)
  const [audioFailed, setAudioFailed] = useState(false)
  const timerRef = useRef(null)
  const flags = state?.form_flags || []
  const flagKey = flags.join(',')

  useEffect(() => {
    if (flags.length > 0) {
      const flag = flags[0]
      const label = FLAG_LABELS[flag] || flag
      setCue(label)
      setVisible(true)
      setAudioFailed(false)

      const cueId = FLAG_CUE_IDS[flag]
      if (cueId) {
        try { playCue(cueId) } catch { setAudioFailed(true) }
      }

      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setVisible(false), 2500)
    }
  }, [flagKey])

  useEffect(() => {
    if (!visible && cue) {
      const t = setTimeout(() => setCue(null), 200)
      return () => clearTimeout(t)
    }
  }, [visible, cue])

  if (!cue) return null

  return (
    <div
      role="status"
      aria-live="assertive"
      aria-label={`Form cue: ${cue}`}
      className={`
        shrink-0 mx-3 mb-3 rounded-2xl bg-warn-bg px-5 h-14 flex items-center gap-3
        transition-all duration-250 ease-out motion-reduce:transition-none
        ${visible
          ? 'translate-y-0 opacity-100 scale-100'
          : 'translate-y-2 opacity-0 scale-[0.98]'
        }
      `}
    >
      <div className="w-8 h-8 rounded-xl bg-warn/10 flex items-center justify-center">
        <i className={`ti ti-${audioFailed ? 'volume-off' : 'volume'} text-warn text-[16px]`} />
      </div>
      <span className="text-[15px] text-warn font-semibold">&ldquo;{cue}&rdquo;</span>
    </div>
  )
}
