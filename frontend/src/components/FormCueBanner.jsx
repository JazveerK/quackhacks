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
  const timerRef = useRef(null)
  const flags = state?.form_flags || []
  const flagKey = flags.join(',')

  useEffect(() => {
    if (flags.length > 0) {
      const flag = flags[0]
      const label = FLAG_LABELS[flag] || flag
      setCue(label)

      // Play the pre-generated audio cue
      const cueId = FLAG_CUE_IDS[flag]
      if (cueId) playCue(cueId)

      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCue(null), 2500)
    }
  }, [flagKey])

  if (!cue) return null

  return (
    <div className="bg-warn-bg border-t border-warn/20 px-5 py-2.5 flex items-center gap-2.5">
      <i className="ti ti-volume text-warn text-base" />
      <span className="text-sm text-warn font-medium">&ldquo;{cue}&rdquo;</span>
    </div>
  )
}
