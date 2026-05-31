import { useEffect, useState, useCallback } from 'react'

/**
 * Exercise picker + "generate from documentation".
 *
 * - Dropdown lists exercises from the backend (/exercises): the built-in presets
 *   (squat, push-up, arm raise) plus anything generated this session. Switching
 *   sends { cmd: 'select_exercise', id } via onSelect.
 * - The "From documentation" box is the actual "any exercise" feature: paste a
 *   PT's written exercise description, and the backend calls Gemini ONCE
 *   (POST /exercise/load) to generate an Exercise Spec, install it live, and add
 *   it to the dropdown. The real-time tracker then coaches it with no further LLM.
 *
 * Locked while a set is counting down or active.
 */
export default function ExerciseSelector({ state, onSelect }) {
  const [opts, setOpts] = useState({ list: [], active: null })
  const [open, setOpen] = useState(false)
  const [doc, setDoc] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)        // { kind: 'ok'|'warn'|'err', text }

  const phase = state?.phase
  const locked = phase === 'SET_ACTIVE' || phase === 'COUNTDOWN'
  const current = state?.exercise || opts.active

  const refresh = useCallback(async () => {
    try {
      const r = await fetch('/exercises')
      if (r.ok) {
        const d = await r.json()
        setOpts({ list: d.exercises || [], active: d.active })
        return d
      }
    } catch { /* dropdown just stays as-is; not load-bearing */ }
    return null
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function generate() {
    const text = doc.trim()
    if (!text || busy) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await fetch('/exercise/load', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) {
        setMsg({ kind: 'err', text: d.detail || `Failed (${r.status})` })
      } else if (d.source === 'generated') {
        await refresh()
        onSelect?.(d.active)              // make sure the new exercise is selected
        setMsg({ kind: 'ok', text: `Loaded “${d.spec?.name || d.active}”.` })
        setDoc('')
        setOpen(false)
      } else {
        // Generation fell back to the default (e.g. no GEMINI_API_KEY).
        setMsg({ kind: 'warn', text: d.error || 'Could not generate — using default.' })
      }
    } catch (e) {
      setMsg({ kind: 'err', text: 'Network error generating spec.' })
    } finally {
      setBusy(false)
    }
  }

  const list = opts.list || []
  const msgClass = {
    ok: 'text-success-text',
    warn: 'text-warning-text',
    err: 'text-warning-text',
  }[msg?.kind] || 'text-tertiary-text'

  return (
    <div className="bg-surface-white rounded-xl border border-border p-4">
      <div className="text-[10px] text-tertiary-text tracking-wide mb-2">Exercise</div>

      {list.length > 0 && (
        <div className="relative">
          <select
            value={current || ''}
            disabled={locked}
            onChange={(e) => onSelect?.(e.target.value)}
            className={`w-full appearance-none rounded-lg border border-border bg-surface px-3 py-2 pr-8 text-sm text-primary-text outline-none focus:border-info transition-colors ${
              locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-surface-white'
            }`}
          >
            {list.map((ex) => (
              <option key={ex.id} value={ex.id}>{ex.display_name}</option>
            ))}
          </select>
          <svg
            className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-tertiary-text"
            width="14" height="14" viewBox="0 0 24 24" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </div>
      )}

      {/* Generate from documentation */}
      <button
        onClick={() => { setOpen(!open); setMsg(null) }}
        disabled={locked}
        className={`mt-2 flex items-center gap-1 text-[11px] ${
          locked ? 'text-tertiary-text/50 cursor-not-allowed' : 'text-info hover:underline'
        }`}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        New exercise from documentation
      </button>

      {open && (
        <div className="mt-2 flex flex-col gap-2">
          <textarea
            value={doc}
            onChange={(e) => setDoc(e.target.value)}
            disabled={busy}
            rows={4}
            placeholder="Paste a PT's exercise description, e.g. “Standing lateral arm raise — lift arms out to shoulder height, controlled, 12 reps.”"
            className="w-full rounded-lg border border-border bg-surface px-2.5 py-2 text-xs text-primary-text outline-none focus:border-info resize-none"
          />
          <button
            onClick={generate}
            disabled={busy || !doc.trim()}
            className={`w-full text-xs rounded-lg px-3 py-2 font-medium transition-opacity ${
              busy || !doc.trim()
                ? 'bg-surface text-tertiary-text cursor-not-allowed'
                : 'bg-info text-white hover:opacity-90'
            }`}
          >
            {busy ? 'Generating…' : 'Generate & load'}
          </button>
        </div>
      )}

      {msg && <div className={`mt-2 text-[11px] ${msgClass}`}>{msg.text}</div>}
      {locked && <div className="mt-1.5 text-[10px] text-tertiary-text">Locked during a set</div>}
    </div>
  )
}
