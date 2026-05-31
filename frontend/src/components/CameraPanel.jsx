import { useState, useRef, useCallback } from "react"
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
      className="relative bg-[#1a1a1a] rounded-2xl overflow-hidden flex items-center justify-center h-full"
      role="img"
      aria-label="Live camera feed showing squat exercise with pose skeleton overlay"
    >
      {/* Top bar — label + live indicator */}
      <div className="absolute top-0 left-0 right-0 z-10 flex items-center justify-between px-4 py-3">
        <span className="text-[12px] text-white/50 tracking-wide bg-black/30 backdrop-blur-sm px-3 py-1.5 rounded-lg font-medium">
          Camera · side view
        </span>
        <span className="flex items-center gap-2 text-[12px] text-white/70 bg-black/30 backdrop-blur-sm px-3 py-1.5 rounded-lg font-medium">
          <span className="w-2 h-2 rounded-full bg-ok animate-pulse motion-reduce:animate-none" />
          Live
        </span>
      </div>

      {/* Priority 1: MJPEG stream */}
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

      {/* Priority 4: Placeholder with silhouette */}
      {showPlaceholder && (
        <div className="flex flex-col items-center gap-4">
          <div className="relative w-24 h-24 rounded-full bg-white/5 flex items-center justify-center">
            <i className="ti ti-yoga text-white/15 text-5xl" />
            <div className="absolute -bottom-1 -right-1 w-8 h-8 rounded-full bg-white/10 flex items-center justify-center">
              <i className="ti ti-camera text-white/30 text-sm" />
            </div>
          </div>
          <div className="text-center">
            <div className="text-[14px] text-white/40 font-medium">Waiting for camera</div>
            <div className="text-[12px] text-white/25 mt-1">Stand to the side, full body in frame</div>
          </div>
        </div>
      )}

      {/* Pose match overlay — skeleton + ghost */}
      {landmarks && landmarks.length >= 33 && (
        <PoseMatchOverlay
          landmarks={landmarks}
          targetDepthDeg={target}
          width={640}
          height={480}
        />
      )}

      {/* Per-rep depth bars (bottom edge) */}
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
      {!showStream && !webcamActive && (
        <div className="absolute bottom-4 right-4 z-20">
          <GhostButton
            onClick={toggleWebcam}
            className="!text-[12px] !px-3 !py-1.5 !min-h-0 !bg-black/30 !backdrop-blur-sm !text-white/60 hover:!text-white/90"
          >
            <i className="ti ti-camera text-[13px]" />
            Preview webcam
          </GhostButton>
        </div>
      )}
      {!showStream && webcamActive && (
        <div className="absolute bottom-4 right-4 z-20">
          <GhostButton
            onClick={toggleWebcam}
            className="!text-[12px] !px-3 !py-1.5 !min-h-0 !bg-black/30 !backdrop-blur-sm !text-white/60 hover:!text-white/90"
          >
            Stop webcam
          </GhostButton>
        </div>
      )}
    </div>
  )
}
