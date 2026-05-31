export default function SetupHint({ state }) {
  const setup = state?.setup_status
  if (!setup || setup.severity === 'good') return null

  const styles = {
    info: 'bg-surface text-tertiary-text',
    warning: 'bg-warning-fill text-warning-text border border-warning/20',
    blocking: 'bg-warning-fill text-warning-text border border-warning/30',
  }

  return (
    <div className={`rounded-xl p-3 text-xs ${styles[setup.severity] || styles.info}`}>
      {setup.hint}
    </div>
  )
}
