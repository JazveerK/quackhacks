import { useState, useEffect, useRef } from 'react'

const FLAG_LABELS = {
  shallow: 'Go deeper',
  too_fast: 'Slow it down',
  incomplete: 'Reach full range',
}

export default function FormCueBanner({ state }) {
  const [cue, setCue] = useState(null)
  const timerRef = useRef(null)
  const flags = state?.form_flags || []

  useEffect(() => {
    if (flags.length > 0) {
      const label = FLAG_LABELS[flags[0]] || flags[0]
      setCue(label)
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => setCue(null), 2500)
    }
  }, [flags.join(',')])

  if (!cue) return null

  return (
    <div className="bg-warning-fill border-t border-warning/20 px-5 py-2.5 flex items-center gap-2.5">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-warning-text)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
        <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
      </svg>
      <span className="text-sm text-warning-text font-medium">"{cue}"</span>
    </div>
  )
}
