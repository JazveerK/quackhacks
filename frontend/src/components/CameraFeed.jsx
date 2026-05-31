import { useRef, useEffect } from 'react'

export default function CameraFeed({ frame, state }) {
  const imgRef = useRef(null)
  const src = state?.tracking_source || 'none'
  const vis = state?.landmark_visibility ?? 0

  useEffect(() => {
    if (frame && imgRef.current) {
      imgRef.current.src = 'data:image/jpeg;base64,' + frame
    }
  }, [frame])

  return (
    <div className="relative bg-[#1a1a1a] rounded-xl overflow-hidden flex items-center justify-center min-h-0">
      {frame ? (
        <img
          ref={imgRef}
          alt="Live feed"
          className="w-full h-full object-contain"
        />
      ) : (
        <div className="text-ink-faint text-sm">Waiting for camera...</div>
      )}

      {/* Top-left label */}
      <div className="absolute top-3 left-3 flex items-center gap-2">
        <span className="text-[10px] text-white/60 bg-black/40 px-2 py-0.5 rounded">
          Camera · side view
        </span>
      </div>

      {/* Top-right live indicator */}
      {frame && (
        <div className="absolute top-3 right-3 flex items-center gap-1.5 bg-black/40 px-2 py-0.5 rounded">
          <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
          <span className="text-[10px] text-white/80">Live</span>
        </div>
      )}

      {/* Bottom-left tracking info */}
      {frame && (
        <div className="absolute bottom-3 left-3">
          <span className="text-[10px] text-white/50 bg-black/40 px-2 py-0.5 rounded">
            Tracking 33 landmarks · 30 fps
          </span>
        </div>
      )}
    </div>
  )
}
