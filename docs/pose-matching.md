# PhysioFusion — Pose-Matching Setup Overlay

A "get into position" guide for the camera panel. A faint **ghost** shows how deep
to squat (anchored to where the user is standing), the live skeleton fills from
**sage → green** as they descend, the **panel edge** greens up and locks at the
match, and a short **hold-to-confirm** seals it. Purely a UX / positioning aid —
it sits on top of the existing measurement, it doesn't replace it.

## Install

```bash
npm i @mediapipe/tasks-vision
```

The WASM runtime and the `pose_landmarker_lite.task` model load from jsDelivr /
Google's model CDN at runtime (no bundling needed).

## File placement

```
src/coach/poseMath.js          # pure math: angles, smoothing, color ramp, ghost solver
src/coach/usePoseMatch.js      # landmarks + target -> match state + hold machine
src/coach/useMediaPipePose.js  # runs PoseLandmarker on a <video>
src/coach/PoseMatchOverlay.jsx # the SVG overlay (ghost, greening, border, chip, meter)
src/screens/SetupPoseGuide.jsx # example wiring with the browser webcam
```

## Usage

```jsx
import SetupPoseGuide from './screens/SetupPoseGuide';

<SetupPoseGuide
  personalTargetDepthDeg={session.personal_target_depth_deg}  // from the calibration squat
  onConfirmed={() => coach.speak('good_depth')}               // fire ElevenLabs cue + haptic
/>
```

## Two architectures

The overlay is **source-agnostic** — it only needs the 33-point landmark array.

- **Frontend owns the webcam** (this example): `useMediaPipePose` runs the model
  in-browser on a `getUserMedia` stream.
- **Backend owns the webcam** (your camera-conflict case): skip `useMediaPipePose`,
  render `<PoseMatchOverlay>` over your streamed video/`<img>`, and pass the landmarks
  your Python MediaPipe step already produces:

  ```jsx
  <div className="relative ..."> {/* your streamed camera panel */}
    <img src={mjpegUrl} className="h-full w-full object-cover" />
    <PoseMatchOverlay landmarks={session.pose_landmarks} targetDepthDeg={session.personal_target_depth_deg} mirrored={false} />
  </div>
  ```

## Data-contract mapping

- `personal_target_depth_deg` → `targetDepthDeg`. This replaces the hardcoded 90° —
  the ghost and the match threshold are computed from the user's own calibrated depth.
- Match progress maps cleanly onto `depth_state` (above target → amber-zone wording;
  at/below → green). The overlay never invents new field names.

## Design-system notes

- Chrome (chip, pills, labels) uses the locked Tailwind tokens: `text-ink`,
  `text-ink-soft`/`-faint`, `text-brand`, `bg-brand-bg`, `text-ok`, `bg-warn-bg`,
  `text-warn`, `bg-surface`.
- The skeleton/meter/border colors are **camera-overlay literals** (sage `#5DCAA5`
  → green `#16B57E`), the one place the system allows literals — they live only on
  the dark video panel. The match payoff is a **border**, not a fill, to stay calm.
  Nothing ever turns red.

## Accessibility (65+ audience)

- Meaning is redundant: coaching text + icon + arrow direction + depth meter + degree
  readout all say the same thing, so color is never the only signal.
- The coaching chip is an `aria-live="polite"` status region; the SVG is `aria-hidden`.
- Large coaching type (19px) and a large primary button.
- Degrades gracefully: if the camera or model is unavailable, the panel shows a calm
  notice and the flow continues — the guide never blocks setup.

## Tuning knobs (props / opts)

- `holdMs` (default 1200) — hold time to confirm.
- `standingAngle` (172) — the "legs straight" reference progress is measured from.
- `usePoseMatch` opts: `minVisibility` (0.6), `smoothing` (0.35 EMA), `exitAngle`.
- Swap `pose_landmarker_lite` for `_full` in `useMediaPipePose.js` if accuracy matters
  more than CPU; lite is the right call for older laptops.

## Caveat: the ghost is a sagittal-plane approximation

The target ghost keeps the user's real ankle position and limb lengths, then solves the
hip/knee for the target knee angle assuming a roughly side-on squat. It reads correctly
from the side (the demo's intended setup) and degrades sanely head-on (the hips still
drop to target). If you standardize on a frontal camera, consider a one-time "turn
side-on" step for calibration, or a frontal silhouette ghost.
