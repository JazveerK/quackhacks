export default function SetupHint({ state }) {
  const setup = state?.setup_status
  if (!setup || setup.severity === 'good') return null

  const styles = {
    info: 'bg-surface text-ink-faint',
    warning: 'bg-warn-bg text-warn border border-warn/20',
    blocking: 'bg-warn-bg text-warn border border-warn/30',
  }

  return (
    <div className={`rounded-lg p-3 text-xs ${styles[setup.severity] || styles.info}`}>
      {setup.hint}
    </div>
  )
}
