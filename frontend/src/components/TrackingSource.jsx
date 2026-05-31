export default function TrackingSource({ state }) {
  const src = state?.tracking_source || 'none'
  const vis = state?.landmark_visibility ?? 0
  const imuQ = state?.imu_quality ?? 0

  const isCamera = src === 'camera'
  const isImu = src === 'imu'
  const isFused = src === 'fused'

  const cameraBars = isCamera || isFused ? Math.min(4, Math.floor(vis * 5)) : 0
  const imuBars = Math.min(4, Math.floor(imuQ * 5))

  function SignalBars({ count, color }) {
    return (
      <div className="flex items-end gap-[3px]" aria-hidden="true">
        {[0, 1, 2, 3].map(i => (
          <div
            key={i}
            className="w-[4px] rounded-sm transition-colors duration-200 motion-reduce:transition-none"
            style={{
              height: `${8 + i * 3}px`,
              backgroundColor: i < count ? color : 'var(--color-surface)',
            }}
          />
        ))}
      </div>
    )
  }

  const pillLabel = isCamera
    ? 'Camera'
    : isImu
      ? 'IMU (holding)'
      : isFused
        ? 'Fused'
        : 'No signal'

  return (
    <div className="bg-white rounded-2xl p-5">
      <div className="text-[12px] text-ink-faint font-medium uppercase tracking-wide mb-4">Tracking</div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-brand-bg flex items-center justify-center">
              <i className="ti ti-camera text-[14px] text-brand" />
            </div>
            <span className="text-[13px] font-medium text-ink-soft">Camera</span>
            <SignalBars count={cameraBars} color="var(--color-brand)" />
          </div>
          <span className="text-[13px] tabular-nums font-medium text-ink-faint">
            {(vis * 100).toFixed(0)}%
          </span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${isImu ? 'bg-warn-bg' : 'bg-surface'}`}>
              <i className={`ti ti-cpu text-[14px] ${isImu ? 'text-warn' : 'text-ink-faint'}`} />
            </div>
            <span className="text-[13px] font-medium text-ink-soft">IMU</span>
            <SignalBars count={imuBars} color={isImu ? 'var(--color-warn)' : 'var(--color-brand)'} />
          </div>
          <span className="text-[13px] tabular-nums font-medium text-ink-faint">
            {(imuQ * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      <div className="mt-4" aria-live="polite" aria-label={`Tracking source: ${pillLabel}`}>
        <span
          className={`
            inline-flex items-center gap-2 text-[12px] font-semibold px-3.5 py-2 rounded-xl
            transition-all duration-300 ease-out motion-reduce:transition-none
            ${isCamera || isFused
              ? 'bg-brand-bg text-brand'
              : isImu
                ? 'bg-warn-bg text-warn'
                : 'bg-surface text-ink-faint'
            }
          `}
        >
          <span
            className={`w-2 h-2 rounded-full transition-colors duration-300 motion-reduce:transition-none ${
              isCamera || isFused ? 'bg-brand' : isImu ? 'bg-warn' : 'bg-ink-faint'
            }`}
          />
          {pillLabel}
        </span>
      </div>
    </div>
  )
}
