/**
 * SetupPoseGuide.jsx — "Get into position" screen with pose-matching overlay.
 *
 * Two modes:
 * 1. Backend owns webcam (the live-session path): overlays landmarks + JPEG
 *    from the WS state — no second camera, no MediaPipe download.
 * 2. Frontend fallback: loads MediaPipe in-browser against a local webcam,
 *    used only when no backend feed is supplied.
 *
 * This component wraps the camera panel + PoseMatchOverlay and provides
 * a "Start when ready" flow.
 */

import { useState, useRef, useCallback, useEffect } from "react"
import PoseMatchOverlay from "../coach/PoseMatchOverlay"
import GhostButton from "../components/GhostButton"
import PrimaryButton from "../components/PrimaryButton"

/**
 * @param {object} props
 * @param {number} props.personalTargetDepthDeg — calibrated target depth (default 95)
 * @param {function} props.onConfirmed — called when the user holds at target
 * @param {function} props.onSkip — called if user skips the guide
 * @param {Array} props.backendLandmarks — landmarks from backend WS (if backend owns camera)
 * @param {string} props.backendFrame — base64 JPEG from backend (if backend owns camera)
 */
export default function SetupPoseGuide({
  personalTargetDepthDeg = 95,
  onConfirmed,
  onSkip,
  backendLandmarks = null,
  backendFrame = null,
}) {
  const [webcamActive, setWebcamActive] = useState(false)
  const [landmarks, setLandmarks] = useState(null)
  const [confirmed, setConfirmed] = useState(false)
  const [modelError, setModelError] = useState(null)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const containerRef = useRef(null)
  const [dims, setDims] = useState({ width: 640, height: 480 })

  const useBackend = backendLandmarks != null || backendFrame != null

  // Track container dimensions for overlay sizing
  useEffect(() => {
    if (!containerRef.current) return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (width > 0 && height > 0) {
        setDims({ width: Math.round(width), height: Math.round(height) })
      }
    })
    ro.observe(containerRef.current)
    return () => ro.disconnect()
  }, [])

  // Mirror backend landmarks (incl. null when the person leaves frame, so the
  // overlay clears instead of freezing on the last pose).
  useEffect(() => {
    if (useBackend) {
      setLandmarks(backendLandmarks)
    }
  }, [backendLandmarks, useBackend])

  // Start local webcam (only when backend doesn't own camera)
  const startWebcam = useCallback(async () => {
    if (useBackend) return
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 480 } },
      })
      streamRef.current = stream
      setWebcamActive(true)
      requestAnimationFrame(() => {
        if (videoRef.current) videoRef.current.srcObject = stream
      })
    } catch (err) {
      console.warn("Camera access denied:", err.message)
      setModelError("Camera access denied. Check permissions and try again.")
    }
  }, [useBackend])

  // Clean up webcam on unmount
  useEffect(() => {
    return () => {
      streamRef.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  // Simple in-browser pose detection using requestAnimationFrame
  // (Lightweight: just reads the video and runs through MediaPipe if available)
  useEffect(() => {
    if (!webcamActive || !videoRef.current || useBackend) return

    let running = true
    let landmarkerLoaded = false
    let landmarker = null

    // Try to load MediaPipe PoseLandmarker
    ;(async () => {
      try {
        const { PoseLandmarker, FilesetResolver } = await import(
          /* @vite-ignore */
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest"
        )
        const vision = await FilesetResolver.forVisionTasks(
          "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
        )
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: {
            modelAssetPath:
              "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task",
            delegate: "GPU",
          },
          runningMode: "VIDEO",
          numPoses: 1,
        })
        landmarkerLoaded = true
      } catch (err) {
        console.warn("[SetupPoseGuide] MediaPipe load failed:", err)
        setModelError("Pose model unavailable — you can still start your session.")
      }
    })()

    let lastTime = -1
    function detect() {
      if (!running) return
      const video = videoRef.current
      if (!video || video.paused || !video.videoWidth || !landmarkerLoaded) {
        requestAnimationFrame(detect)
        return
      }
      const now = video.currentTime
      if (now !== lastTime && landmarker) {
        lastTime = now
        try {
          const result = landmarker.detectForVideo(video, performance.now())
          if (result?.landmarks?.[0]) {
            setLandmarks(result.landmarks[0])
          }
        } catch {
          // skip frame
        }
      }
      requestAnimationFrame(detect)
    }
    requestAnimationFrame(detect)

    return () => {
      running = false
    }
  }, [webcamActive, useBackend])

  const handleConfirmed = useCallback(() => {
    setConfirmed(true)
    onConfirmed?.()
  }, [onConfirmed])

  // If camera is not available or model fails, degrade gracefully
  if (modelError && !useBackend && !webcamActive) {
    return (
      <div className="flex flex-col items-center gap-4 py-12">
        <div className="w-14 h-14 rounded-full bg-surface text-ink-faint flex items-center justify-center">
          <i className="ti ti-camera-off text-2xl" />
        </div>
        <p className="text-sm text-ink-soft text-center max-w-sm">{modelError}</p>
        <PrimaryButton onClick={onSkip} arrow>
          Continue without guide
        </PrimaryButton>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-ink">Get into position</h2>
          <p className="text-sm text-ink-soft mt-0.5">
            Stand side-on to the camera. Squat to your target depth and hold for a moment.
          </p>
        </div>
        <GhostButton onClick={onSkip}>
          Skip
        </GhostButton>
      </div>

      {/* Camera panel with overlay */}
      <div
        ref={containerRef}
        className="relative bg-ink rounded-lg overflow-hidden min-h-[350px] max-h-[500px] flex items-center justify-center"
      >
        {/* Backend-owned camera frame */}
        {useBackend && backendFrame && (
          <img
            src={`data:image/jpeg;base64,${backendFrame}`}
            alt="Camera feed"
            className="w-full h-full object-contain"
          />
        )}

        {/* Local webcam video */}
        {!useBackend && webcamActive && (
          <video
            ref={videoRef}
            autoPlay
            muted
            playsInline
            className="w-full h-full object-cover"
          />
        )}

        {/* Placeholder — prompt to start */}
        {!useBackend && !webcamActive && (
          <div className="flex flex-col items-center gap-3">
            <i className="ti ti-camera text-white/30 text-3xl" />
            <span className="text-[15px] text-white/50">Camera preview</span>
            <PrimaryButton onClick={startWebcam}>
              <i className="ti ti-camera text-base" />
              Start camera
            </PrimaryButton>
          </div>
        )}

        {/* Backend placeholder when no frame */}
        {useBackend && !backendFrame && (
          <div className="flex flex-col items-center gap-2">
            <i className="ti ti-camera-off text-white/30 text-2xl" />
            <span className="text-[15px] text-white/40">Waiting for camera feed…</span>
          </div>
        )}

        {/* Pose match overlay */}
        {(webcamActive || useBackend) && (
          <PoseMatchOverlay
            landmarks={landmarks}
            targetDepthDeg={personalTargetDepthDeg}
            width={dims.width}
            height={dims.height}
            onConfirmed={handleConfirmed}
          />
        )}
      </div>

      {/* Target info bar */}
      <div className="flex items-center justify-between bg-surface rounded-lg p-3">
        <div className="flex items-center gap-2 text-sm text-ink-soft">
          <i className="ti ti-target text-brand" />
          Target depth: <span className="font-medium text-ink">{personalTargetDepthDeg}°</span>
        </div>
        {confirmed && (
          <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ok">
            <i className="ti ti-check text-base" />
            Position confirmed
          </span>
        )}
      </div>

      {/* Model error (non-blocking) */}
      {modelError && (
        <div className="flex items-start gap-2 rounded-lg bg-surface p-3">
          <i className="ti ti-info-circle text-ink-faint shrink-0 mt-0.5" />
          <p className="text-xs text-ink-soft">{modelError}</p>
        </div>
      )}
    </div>
  )
}
