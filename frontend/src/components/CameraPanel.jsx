import { useState, useRef, useCallback } from "react"
import GhostButton from "./GhostButton"

const VIDEO_URL = import.meta.env.VITE_VIDEO_URL

export default function CameraPanel({ frame }) {
  const [imgError, setImgError] = useState(false)
  const [webcamActive, setWebcamActive] = useState(false)
  const videoRef = useRef(null)
  const streamRef = useRef(null)

  const showStream = VIDEO_URL && !imgError
  const showWebcam = webcamActive
  const showPlaceholder = !showStream && !showWebcam && !frame

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
      // Attach after state update triggers render
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream
      })
    } catch (err) {
      console.warn("Webcam access denied:", err.message)
    }
  }, [webcamActive])

  return (
    <div className="relative bg-ink rounded-lg overflow-hidden flex items-center justify-center h-full min-h-[300px]">
      {/* Labels */}
      <span className="absolute top-3 left-3 text-[10px] text-white/60 tracking-wide z-10">
        Camera · side view
      </span>
      <span className="absolute top-3 right-3 flex items-center gap-1.5 text-[10px] text-white/80 z-10">
        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
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
        <span className="text-sm text-white/40">Waiting for camera...</span>
      )}

      {/* DEV-ONLY webcam toggle */}
      {!showStream && (
        <div className="absolute bottom-3 right-3 z-10">
          <GhostButton
            onClick={toggleWebcam}
            className="!text-[10px] !px-2 !py-1 !border-white/20 !text-white/50 hover:!text-white/80"
          >
            {webcamActive ? "Stop webcam" : "Use webcam preview"}
          </GhostButton>
        </div>
      )}
    </div>
  )
}
