export default function TrackingSource({ state }) {
  const src = state?.tracking_source || 'none'
  const vis = state?.landmark_visibility ?? 0
  const imuQ = state?.imu_quality ?? 0

  const isCamera = src === 'camera'
  const isImu = src === 'imu'

  // Signal bars (0-4 scale)
  const cameraBars = isCamera ? Math.min(4, Math.floor(vis * 5)) : 0
  const imuBars = Math.min(4, Math.floor(imuQ * 5))

  function SignalBars({ count, color }) {
    return (
      <div className="flex items-end gap-[2px]">
        {[0, 1, 2, 3].map(i => (
          <div
            key={i}
            className="w-[3px] rounded-sm transition-colors duration-200"
            style={{
              height: `${6 + i * 3}px`,
              backgroundColor: i < count ? color : 'var(--color-surface)',
            }}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="bg-surface-white rounded-xl border border-border p-4">
      <div className="text-[10px] text-tertiary-text tracking-wide mb-3">Tracking</div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-secondary-text">Camera</span>
            <SignalBars count={cameraBars} color="var(--color-info)" />
          </div>
          <span className="text-xs tabular-nums text-tertiary-text">
            {(vis * 100).toFixed(0)}%
          </span>
        </div>

        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xs text-secondary-text">IMU</span>
            <SignalBars count={imuBars} color={isImu ? 'var(--color-warning)' : 'var(--color-info)'} />
          </div>
          <span className="text-xs tabular-nums text-tertiary-text">
            {(imuQ * 100).toFixed(0)}%
          </span>
        </div>
      </div>

      <div className="mt-3">
        <span
          className={`
            inline-flex items-center gap-1.5 text-[11px] px-3 py-1 rounded-full
            transition-all duration-300
            ${isCamera
              ? 'bg-info-fill text-info-text'
              : isImu
                ? 'bg-warning-fill text-warning-text'
                : 'bg-surface text-tertiary-text'
            }
          `}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full transition-colors duration-300 ${
              isCamera ? 'bg-info' : isImu ? 'bg-warning' : 'bg-tertiary-text'
            }`}
          />
          {isCamera ? 'Source: Camera' : isImu ? 'Source: IMU (holding)' : 'No signal'}
        </span>
      </div>
    </div>
  )
}
