import { useState, useRef, useCallback, useEffect } from "react"
import GhostButton from "./GhostButton"
import PoseMatchOverlay from "../coach/PoseMatchOverlay"

const VIDEO_URL = import.meta.env.VITE_VIDEO_URL

export default function CameraPanel({ frame, repDepths, targetDeg, landmarks }) {
  const [imgError, setImgError] = useState(false)
  const [webcamActive, setWebcamActive] = useState(false)
  const videoRef = useRef(null)
  const streamRef = useRef(null)

  const showStream = VIDEO_URL && !imgError
  const showWebcam = webcamActive
  const showPlaceholder = !showStream && !showWebcam && !frame

  const target = targetDeg ?? 95
  const depths = repDepths || []
  const atTarget = depths.filter(d => d <= target + 5).length

  // DEV-ONLY: Local webcam preview. Must not run while the backend owns the
  // camera (single-process camera lock). Use only for front-end development
  // when the backend is not running.
  const toggleWebcam = useCallback(async () => {
    if (webcamActive) {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      streamRef.current = null
      setWebcamActive(false)
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true })
      streamRef.current = stream
      setWebcamActive(true)
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream
      })
    } catch (err) {
      console.warn("Webcam access denied:", err.message)
    }
  }, [webcamActive])

  return (
    <div
      className="relative bg-ink rounded-2xl overflow-hidden flex items-center justify-center h-full min-h-[300px]"
      role="img"
      aria-label="Live camera feed showing squat exercise with pose skeleton overlay"
    >
      {/* Top-left label */}
      <span className="absolute top-4 left-4 text-[12px] text-white/60 tracking-wide z-10 bg-black/20 backdrop-blur-sm px-3 py-1.5 rounded-lg">
        Camera · side view
      </span>

      {/* Top-right live indicator */}
      <span className="absolute top-4 right-4 flex items-center gap-2 text-[12px] text-white/80 z-10 bg-black/20 backdrop-blur-sm px-3 py-1.5 rounded-lg">
        <span className="w-2 h-2 rounded-full bg-ok animate-pulse motion-reduce:animate-none" />
        Live
      </span>

      {/* Priority 1: MJPEG stream from backend */}
      {showStream && (
        <img
          src={VIDEO_URL}
          alt="Camera feed"
          className="w-full h-full object-cover"
          onError={() => setImgError(true)}
        />
      )}

      {/* Priority 2: Dev-only local webcam */}
      {!showStream && showWebcam && (
        <video
          ref={videoRef}
          autoPlay
          muted
          playsInline
          className="w-full h-full object-cover"
        />
      )}

      {/* Priority 3: WebSocket base64 frame */}
      {!showStream && !showWebcam && frame && (
        <img
          src={`data:image/jpeg;base64,${frame}`}
          alt="Camera feed"
          className="w-full h-full object-contain"
        />
      )}

      {/* Priority 4: Placeholder */}
      {showPlaceholder && (
        <div className="flex flex-col items-center gap-3">
          <div className="w-14 h-14 rounded-2xl bg-white/10 flex items-center justify-center">
            <i className="ti ti-camera-off text-white/30 text-2xl" />
          </div>
          <span className="text-[15px] text-white/40">Waiting for camera...</span>
        </div>
      )}

      {/* Pose match overlay — renders skeleton + ghost when landmarks available */}
      {landmarks && landmarks.length >= 33 && (
        <PoseMatchOverlay
          landmarks={landmarks}
          targetDepthDeg={target}
          width={640}
          height={480}
        />
      )}

      {/* Per-rep depth bars overlay (bottom edge of camera panel) */}
      {depths.length > 0 && (
        <div
          className="absolute bottom-0 left-0 right-0 z-10 px-5 pb-4 pt-10 bg-gradient-to-t from-black/60 to-transparent"
          role="img"
          aria-label={`Per-rep depth: ${atTarget} of ${depths.length} reps at target`}
        >
          <div className="flex items-end gap-1.5 h-12">
            {depths.map((d, i) => {
              const isShallow = d > target + 5
              const pct = Math.max(15, Math.min(100, ((180 - d) / 120) * 100))
              return (
                <div
                  key={i}
                  className="flex-1 rounded-t-md transition-all duration-200 ease-out motion-reduce:transition-none"
                  style={{
                    height: `${pct}%`,
                    backgroundColor: isShallow ? '#FAC775' : '#5DCAA5',
                  }}
                  title={`Rep ${i + 1}: ${Math.round(d)}°`}
                />
              )
            })}
          </div>
          <div className="flex justify-between mt-1.5">
            <span className="text-[11px] text-white/50 font-medium">Rep 1</span>
            <span className="text-[11px] text-white/50 font-medium">Rep {depths.length}</span>
          </div>
        </div>
      )}

      {/* DEV-ONLY webcam toggle */}
      {!showStream && (
        <div className="absolute bottom-4 right-4 z-20">
          <GhostButton
            onClick={toggleWebcam}
            className="!text-[12px] !px-3 !py-1.5 !bg-black/30 !backdrop-blur-sm !text-white/60 hover:!text-white/90"
          >
            {webcamActive ? "Stop webcam" : "Use webcam preview"}
          </GhostButton>
        </div>
      )}
    </div>
  )
}
