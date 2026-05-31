// Continuous sensor-fusion blend meter.
//
// The backend fuses camera + IMU every frame and emits `fusion_weight` in [0,1]
// (1.0 = fully camera, 0.0 = fully IMU). This panel renders that weight as one
// sliding blend — both sensors ALWAYS contribute, the share just shifts — rather
// than a binary "camera OR imu" switch. `tracking_source` is only a derived label.
const IMU_CARRY = 0.2  // matches backend KALMAN_K_IMU_THRESHOLD: below this, IMU leads
const MIN_SHARE = 0.06 // neither bar ever fully empties — honest about continuous fusion

export default function TrackingSource({ state }) {
  // When the IMU is toggled off the UI is camera-only everywhere.
  const imuEnabled = state?.imu_enabled !== false
  const src = state?.tracking_source || 'none'
  const vis = state?.landmark_visibility ?? 0
  const imuQ = state?.imu_quality ?? 0

  // Prefer the continuous weight; fall back to deriving one from the legacy
  // binary fields so the panel still animates if an older backend is attached.
  const rawW = state?.fusion_weight
  let weight
  if (typeof rawW === 'number') weight = rawW
  else if (src === 'imu') weight = 0.12
  else if (src === 'camera') weight = Math.max(0.6, vis * vis)
  else weight = null // no usable signal this frame

  const hasSignal = weight !== null

  // --- Camera-only mode (IMU fusion off) -----------------------------------
  if (!imuEnabled) {
    const camPct = Math.round(Math.min(1, Math.max(0, vis)) * 100)
    return (
      <Shell>
        <EndpointRow camLed imuLed={false} imuMuted />
        <BlendTrack camPct={hasSignal ? 100 : 0} imuPct={0} imuCarrying={false} dim={!hasSignal} />
        <div className="mt-3 text-[12px] text-ink-faint">
          Camera only · IMU sensor fusion off{hasSignal ? ` · ${camPct}% visibility` : ''}
        </div>
      </Shell>
    )
  }

  // --- No-signal state ------------------------------------------------------
  if (!hasSignal) {
    return (
      <Shell>
        <EndpointRow camLed={false} imuLed={false} />
        <BlendTrack camPct={50} imuPct={50} imuCarrying={false} dim />
        <div className="mt-3" aria-live="polite">
          <StatusPill tone="muted" icon="ti-radar-2" label="Searching for signal" />
        </div>
      </Shell>
    )
  }

  // --- Continuous blend -----------------------------------------------------
  // Clamp the displayed share so both sensors stay visibly lit at all times.
  const w = Math.min(1 - MIN_SHARE, Math.max(MIN_SHARE, weight))
  const camPct = Math.round(w * 100)
  const imuPct = 100 - camPct
  const imuCarrying = weight < IMU_CARRY

  return (
    <Shell>
      <EndpointRow camLed imuLed imuCarrying={imuCarrying} />
      <BlendTrack camPct={camPct} imuPct={imuPct} imuCarrying={imuCarrying} />

      {/* Live percentages — the continuous truth, always both sides. */}
      <div className="flex items-center justify-between mt-2.5">
        <span className="text-[12px] tabular-nums font-semibold text-brand transition-colors duration-300">
          Camera {camPct}%
        </span>
        <span
          className={`text-[12px] tabular-nums font-semibold transition-colors duration-300 ${
            imuCarrying ? 'text-warn' : 'text-ink-faint'
          }`}
        >
          IMU {imuPct}%
        </span>
      </div>

      {/* Dramatic occlusion beat: emphasize when the IMU takes the lead, while
          the blend bar above stays continuous so it's honest about the mechanism. */}
      <div className="mt-3" aria-live="polite">
        {imuCarrying ? (
          <StatusPill tone="warn" icon="ti-cpu" label="IMU now carrying tracking" pulse />
        ) : (
          <StatusPill tone="brand" icon="ti-affiliate" label="Fusion weighting · camera-led" />
        )}
      </div>
    </Shell>
  )
}

// ---------------------------------------------------------------------------
function Shell({ children }) {
  return (
    <div className="bg-white rounded-2xl p-5">
      <div className="text-[12px] text-ink-faint font-medium uppercase tracking-wide mb-4">
        Sensor fusion
      </div>
      {children}
    </div>
  )
}

// Endpoint labels that bookend the blend track.
function EndpointRow({ camLed, imuLed, imuCarrying = false, imuMuted = false }) {
  return (
    <div className="flex items-center justify-between mb-2">
      <div className="flex items-center gap-1.5">
        <i className={`ti ti-camera text-[13px] ${camLed ? 'text-brand' : 'text-ink-faint'}`} />
        <span className={`text-[12px] font-semibold ${camLed ? 'text-ink-soft' : 'text-ink-faint'}`}>
          Camera
        </span>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className={`text-[12px] font-semibold transition-colors duration-300 ${
            imuCarrying ? 'text-warn' : imuLed && !imuMuted ? 'text-ink-soft' : 'text-ink-faint'
          }`}
        >
          IMU
        </span>
        <i
          className={`ti ti-cpu text-[13px] transition-colors duration-300 ${
            imuCarrying ? 'text-warn' : imuLed && !imuMuted ? 'text-brand' : 'text-ink-faint'
          }`}
        />
      </div>
    </div>
  )
}

// The blend track: a camera fill (left) and an IMU fill (right) that slide
// against each other, with a knob marking the live boundary. Animated so the
// shift is legible across a room.
function BlendTrack({ camPct, imuPct, imuCarrying, dim = false }) {
  return (
    <div className="relative">
      <div className="h-3 rounded-full overflow-hidden bg-surface flex">
        <div
          className={`h-full transition-all duration-500 ease-out motion-reduce:transition-none ${
            dim ? 'bg-ink-faint/30' : 'bg-brand'
          }`}
          style={{ width: `${camPct}%` }}
        />
        <div
          className={`h-full transition-all duration-500 ease-out motion-reduce:transition-none ${
            dim ? 'bg-ink-faint/20' : imuCarrying ? 'bg-warn' : 'bg-brand/30'
          }`}
          style={{ width: `${imuPct}%` }}
        />
      </div>
      {!dim && (
        <div
          className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-1 h-5 rounded-full bg-white shadow-sm ring-1 ring-black/5 transition-all duration-500 ease-out motion-reduce:transition-none"
          style={{ left: `${camPct}%` }}
          aria-hidden="true"
        />
      )}
    </div>
  )
}

function StatusPill({ tone, icon, label, pulse = false }) {
  const tones = {
    brand: 'bg-brand-bg text-brand',
    warn: 'bg-warn-bg text-warn',
    muted: 'bg-surface text-ink-faint',
  }
  const dot = { brand: 'bg-brand', warn: 'bg-warn', muted: 'bg-ink-faint' }
  return (
    <span
      className={`inline-flex items-center gap-2 text-[12px] font-semibold px-3.5 py-2 rounded-xl transition-all duration-300 ease-out motion-reduce:transition-none ${tones[tone]}`}
      aria-label={label}
    >
      <span
        className={`w-2 h-2 rounded-full ${dot[tone]} ${
          pulse ? 'animate-pulse motion-reduce:animate-none' : ''
        }`}
      />
      <i className={`ti ${icon} text-[13px]`} />
      {label}
    </span>
  )
}
