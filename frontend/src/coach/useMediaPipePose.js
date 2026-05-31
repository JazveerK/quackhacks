/**
 * useMediaPipePose.js — Runs PoseLandmarker on a <video> element.
 *
 * Loads the WASM runtime + lite model from CDN at first use.
 * Returns normalized 33-point landmarks per frame via a callback.
 *
 * Skip this hook entirely when the backend owns the camera —
 * just pass landmarks from your WS state directly.
 */

import { useRef, useCallback, useEffect, useState } from "react"

const WASM_CDN = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm"
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/latest/pose_landmarker_lite.task"

let _landmarkerPromise = null

async function getLandmarker() {
  if (_landmarkerPromise) return _landmarkerPromise
  _landmarkerPromise = (async () => {
    const { PoseLandmarker, FilesetResolver } = await import(
      "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest"
    )
    const vision = await FilesetResolver.forVisionTasks(WASM_CDN)
    const landmarker = await PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
      runningMode: "VIDEO",
      numPoses: 1,
    })
    return landmarker
  })()
  return _landmarkerPromise
}

/**
 * @param {object} opts
 * @param {React.RefObject<HTMLVideoElement>} opts.videoRef — ref to the <video>
 * @param {boolean} opts.enabled — toggle detection on/off
 * @param {function} opts.onLandmarks — callback(landmarks[]) per frame
 * @returns {{ loading, error }}
 */
export function useMediaPipePose({ videoRef, enabled = true, onLandmarks }) {
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const landmarkerRef = useRef(null)
  const rafRef = useRef(null)
  const lastTimeRef = useRef(-1)

  // Initialize the landmarker
  useEffect(() => {
    if (!enabled) return
    let cancelled = false

    getLandmarker()
      .then((lm) => {
        if (cancelled) return
        landmarkerRef.current = lm
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        console.warn("[useMediaPipePose] Failed to load:", err)
        setError(err.message || "Failed to load pose model")
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [enabled])

  // Run detection loop
  useEffect(() => {
    if (!enabled || loading || error || !landmarkerRef.current) return

    const video = videoRef?.current
    if (!video) return

    function detect() {
      if (!video || video.paused || video.ended || !video.videoWidth) {
        rafRef.current = requestAnimationFrame(detect)
        return
      }

      const now = video.currentTime
      if (now !== lastTimeRef.current) {
        lastTimeRef.current = now
        try {
          const result = landmarkerRef.current.detectForVideo(video, performance.now())
          if (result?.landmarks?.[0]) {
            onLandmarks?.(result.landmarks[0])
          }
        } catch {
          // skip frame
        }
      }

      rafRef.current = requestAnimationFrame(detect)
    }

    rafRef.current = requestAnimationFrame(detect)

    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current)
    }
  }, [enabled, loading, error, videoRef, onLandmarks])

  return { loading, error }
}
