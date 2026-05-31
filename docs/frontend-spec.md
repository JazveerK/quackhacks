# PhysioFusion — Frontend Design Spec

Hand this to Claude Code to build the dashboard. It captures four screens, the shared design system, the data contracts they bind to, and the build order. Stack target: **React (Vite) + Tailwind CSS + WebSocket client**. Charts: recharts or hand-rolled SVG (both fine).

---

## 1. Project context

PhysioFusion is an AI physical-therapy exercise coach for people rehabbing an injury or surgery between clinician visits. It tracks bodyweight squats using two fused signals — a webcam (MediaPipe Pose) and an MPU6050 IMU on the mid-thigh — coaches form by voice in real time, and delivers an AI debrief between sets via Gemini Flash.

**Positioning:** objective range-of-motion tracking and form coaching. It does NOT diagnose and does NOT prescribe. This constraint drives real UI rules (see Section 8).

**Audiences:** the everyday user (no exercise vocabulary) is primary; physical therapists / clinicians are secondary and get an opt-in detailed view.

---

## 2. Design system

### Aesthetic
Clinical and calm, in the spirit of Apple Health. Flat surfaces, no gradients, no drop shadows, no neon. Generous whitespace. Large readable numbers. White/off-white backgrounds with navy as the accent. Color encodes meaning consistently across every screen.

### Color tokens
Map these into `tailwind.config.js` under `theme.extend.colors`. Each has a light fill, a strong/accent, and a dark text stop.

| Role | Fill (bg) | Accent / line | Text on fill | Meaning |
|------|-----------|---------------|--------------|---------|
| info (navy) | `#E6F1FB` | `#185FA5` | `#0C447C` | brand, primary actions, "camera" source, neutral-positive |
| success (green) | `#E1F5EE` | `#1D9E75` | `#0F6E56` | at/below target depth, completed reps, positive trend |
| warning (amber) | `#FAEEDA` | `#BA7517` | `#854F0B` | shallow depth, "IMU holding", caution flags |
| neutral text | — | — | `#2C2C2A` primary, `#5F5E5A` secondary, `#888780` tertiary | body, labels |
| surface | `#F1EFE8` (secondary bg) | — | — | metric tiles, soft cards |
| border | `rgba(0,0,0,0.15)` default, `rgba(0,0,0,0.3)` emphasis | — | — | hairlines |

Hero numbers use primary text color (near-black), not navy, so they stay legible. Navy is for accents, actions, and the brand wordmark.

Support a dark mode if time allows, but light mode is the demo default.

### Typography
- Sans-serif throughout (system font stack or Inter).
- Two weights only: 400 regular, 500 medium. Never 600/700.
- Hero metrics: 42–48px / weight 500 / tight letter-spacing.
- Section/metric values: 18–26px / 500.
- Body: 15–16px / 400 / line-height ~1.6.
- Micro-labels: 10–11px, letter-spacing ~0.06em, secondary color. Sentence case (e.g. "Knee depth", not "KNEE DEPTH") unless you deliberately choose small-caps styling.
- Use a monospace font only inside the clinician view for data readouts (timecodes, raw flag strings).

### Spacing & shape
- Card radius: 12px (`rounded-xl`). Inner elements: 8px (`rounded-lg`).
- Pills/badges/chips: fully rounded (`rounded-full`).
- Borders: 0.5px hairlines (use `border` with a 0.5px shim or 1px at low opacity).
- Card padding: 16–20px. Vertical rhythm between sections: 12–14px.
- No drop shadows except a functional focus ring on inputs.

---

## 3. Shared components

Build these once and reuse across screens.

**AppHeader** — thin top strip on every screen.
- Left: "PhysioFusion" wordmark (navy, weight 500), then dot-separated context (exercise, set X of Y, etc.).
- Right: phase indicator — a colored dot + phase label. Dot color matches phase (green = SET_ACTIVE, navy = DEBRIEF/CHECK_IN, etc.).

**Card** — white bg, 0.5px border, `rounded-xl`, padding 16–20px. Variant `soft` uses the secondary background and no border (for the coach card, metric tiles).

**MetricTile** — secondary bg, `rounded-lg`, padding ~12px. Micro-label on top, value below, optional sub-label. Used in grids of 3–4.

**Pill / Badge** — `rounded-full`, small text, semantic fill+text pair (success / warning / info). Used for depth status, source state, flag counts.

**Chip (selectable)** — `rounded-full`, hairline border, transparent when unselected; info fill + info text + info border when selected. Single-select within a group. Used in intake.

**PrimaryButton** — navy fill, white text, `rounded-lg`, weight 500, optional trailing `arrow-right` icon.

**GhostButton** — transparent, hairline border, hover fills with secondary bg. Used for "Play voice", "Export PDF", toggles.

Icons: Tabler outline set. Common ones used: `activity`, `volume`, `player-play`, `player-pause`, `check`, `minus`, `target`, `clock`, `trending-up`, `info-circle`, `message-circle`, `microphone`, `stethoscope`, `chevron-down`, `arrow-right`, `download`, `send`, `sparkles`, `clipboard-text`. No emoji anywhere.

---

## 4. Screen specs

### Screen A — Live session dashboard (phase: SET_ACTIVE)
The hero screen, on display ~90% of the demo. Full-viewport, single screen, no scroll.

**Layout:** AppHeader on top; a 3-column grid below (camera 60% / metrics 25% / sidebar 15%); a full-width form-cue banner pinned at the bottom.

- **Camera column (60%)**: the webcam feed with the MediaPipe skeleton overlaid (33 landmarks, edges between joints). Dark background (it's video). The active knee joint is highlighted with a colored ring and a live angle readout near it. Small overlay labels: "Camera · side view" top-left, a "Live" indicator top-right, "Tracking 33 landmarks · 30 fps" bottom-left.
- **Metrics column (25%)**, stacked, divided by hairlines:
  - **Rep counter (hero)**: large current number + "/ target", with a thin progress bar underneath.
  - **Knee depth**: current angle (26px) + a status badge ("At target" / "Approaching" / "Above target"), then a half-circle arc gauge that fills as the user descends, with a green target marker at the 90° (or personal target) position.
  - **Descent tempo**: seconds value + a state line ("Steady · within range").
- **Sidebar column (15%)** — the fusion money-shot, stacked:
  - **Tracking**: two rows ("Camera", "IMU") each with a 4-bar signal indicator, then a source pill that reads "Source: Camera" (info/navy) and FLIPS to "Source: IMU (holding)" (amber) when `landmark_visibility < 0.5`.
  - **IMU quality**: percentage.
  - **Visibility**: percentage (turns amber when low).
- **Form-cue banner (footer)**: a speaker icon + the current cue text in quotes, synced with the voice clip currently playing.

**Live behavior (from WebSocket per-frame state):** rep count, angle, depth gauge fill, depth badge, tempo, and the tracking-source flip all update in real time. When `tracking_source` switches to "imu", flip the source pill to amber, drop the camera signal bars, and drop the visibility number. Switch back on recovery. This handoff must be visible — it's the differentiator.

### Screen B — Between-set debrief (phase: DEBRIEF / REST)
Vertical stack. Plain language by default with an opt-in clinician layer.

- **AppHeader** with phase "Resting" and context "Set 2 done · take a breath".
- **Coach card (soft)**: avatar circle (`activity` icon) + a greeting line ("Nice work.") + a 2–3 sentence plain-language debrief (no degrees), then a "Hear this" ghost button that plays the ElevenLabs/Gemini audio (show a progress bar while playing).
- **"Your 10 squats" card**: a centered row of N circles, one per rep, each labeled with its rep number. Green circle + check = reached goal; amber circle + minus = shallow. Ordered left-to-right so the fatigue pattern reads visually. A two-item legend below.
- **"How it went" card**: a 3–4 item list, each with a small round status icon (success/warning/info) and a friendly one-line sentence. No jargon.
- **"Worth telling your PT" flag**: appears ONLY when a clinical flag fired. Info-blue (not red), `message-circle` icon, soft conversational copy ("…not a problem, just something they'll want to know"). Suppress this on clean sets for better demo storytelling.
- **"One more set to go" action bar (soft)**: title + sub ("10 squats · take it a bit slower this time") on the left, a PrimaryButton "Start" on the right → transitions to SET_ACTIVE (or CHECK_IN for a new session).
- **"Show clinical details" toggle**: a centered ghost pill with `stethoscope` icon. Expands a collapsible PT section containing: per-rep depth bar chart WITH degrees and a 90° target line (green bars = at/below target, amber = shallow); a 6-tile metric grid (avg depth, best depth, depth range, avg descent, tempo trend, fatigue signal); a horizontal stacked "tracking source" bar showing the camera vs IMU split for the set; and form-flag pills showing raw counts and `mobility_limited_at`. Collapsed by default.

### Screen C — Intake (first time) + Check-in (every session)
Two distinct flows, same brand header. Intake is a one-time sit-down; check-in is a recurring 30-second warm-up.

**Intake (phase: SETUP)** — form layout:
- Welcome heading + subtitle ("…You can change any of this later.").
- A soft disclaimer block at the top: "PhysioFusion is a coaching and tracking tool, not a substitute for your physical therapist. We don't diagnose or prescribe exercises." (`info-circle` icon, secondary styling.)
- Chip-select questions (single-select each): "What are you working on?" (Right knee / Left knee / Hip / Lower back / Ankle / Shoulder / Other); "What's the situation?" (Recovering from surgery / Sports injury / Chronic pain / Post-fall recovery / General strength / Something else); "When did this start?" (This week / This month / 1–3 months ago / 3–6 months ago / Longer).
- Optional text input: PT name / clinic. Optional textarea: "Anything we should know?".
- Footer: a "I'll do this later" ghost link on the left, "Save and start" PrimaryButton on the right.

**Check-in (phase: CHECK_IN)** — fast, voice-or-tap:
- Greeting ("Hi again.") + sub ("…tap an answer, or use the mic to speak.").
- A mic button (top-right): tap toggles a "Listening…" state with a pulse animation; both voice and tap must work (accessibility requirement). Voice is opt-in; tap buttons are the dominant path.
- Three question cards, each with a numbered status badge (done = green check / active = navy number / pending = gray):
  1. "How's your [region] today?" — a 1–10 scale of round buttons with "Rough"/"Great" end labels.
  2. "Any pain right now?" — option chips (None / Mild / Moderate / Sharp).
  3. "Ready to start your session?" — option chips (Yes, let's go / Give me a minute).
- The active card gets a navy border (not fill). PrimaryButton "Start session" at the bottom → CALIBRATE then SET_ACTIVE.

### Screen D — Clinician / progress view (MOCK for pitch deck)
Data-dense, degrees allowed, clinical language allowed. Do NOT build this as functional MVP — mock it.

- **AppHeader** "Clinician view" + right-aligned "Export PDF" (ghost) and "Share with PT" (primary) buttons. Both fire a confirmation toast (e.g. "Report sent to Dr. Aisha Patel") — no real sharing/permission change.
- **Patient bar**: initials avatar + name + meta line (region · condition · week X of Y · PT name).
- **Stat tiles (4)**: adherence %, total sessions, ROM gain (green), avg degrees to target.
- **Squat depth trend chart**: line chart of avg min knee angle per session over ~3 weeks, oriented so improvement rises toward a dashed 90° target line near the top; soft area fill; dots on alternating points. Caption clarifies "closer to 90° is deeper."
- **Adherence heatmap**: 3 rows × 7 days, cells = completed (info fill + check) / rest (secondary) / missed (dashed outline). Legend below.
- **Gemini progress report card**: `sparkles` icon + an uppercase-ish "Progress report" label + a plain-but-clinical narrative grounded in the numbers, followed by a flagged-patterns list (badge with frequency + description).
- **Prescription card**: `clipboard-text` icon + "Bodyweight squat · 3 sets × 10 · target 90° · 5×/week" + a "set by PT" tag (read-only — the app never edits a prescription).

---

## 5. Data contracts (locked — bind to these exact shapes)

Per-frame session state (WebSocket → Screen A):
```json
{
  "phase": "CHECK_IN | CALIBRATE | SET_ACTIVE | SET_END | DEBRIEF | REST",
  "angle": 92.4,
  "rep_count": 7,
  "rep_target": 10,
  "rom_min": 88.0,
  "rom_max": 172.0,
  "depth_state": "below_parallel | at_parallel | shallow",
  "form_flags": ["too_fast"],
  "tempo": 1.8,
  "imu_quality": 0.96,
  "landmark_visibility": 0.41,
  "tracking_source": "camera | imu",
  "rep_depths": [95, 93, 90, 96],
  "personal_target_depth_deg": 95.0,
  "mobility_limited_at_deg": null,
  "rehab_context": { "body_region": "right_knee", "protocol_name": "post_ACL_week_6" }
}
```

Per-set summary (backend → Gemini → Screen B):
```json
{
  "exercise": "bodyweight_squat",
  "reps_completed": 10,
  "rep_target": 10,
  "rep_depths_deg": [95, 92, 90, 91, 96, 98, 101, 104, 107, 110],
  "target_depth_deg": 90,
  "personal_target_depth_deg": 95.0,
  "depth_trend": "declining_after_rep_6",
  "avg_descent_sec": 1.6,
  "tempo_trend": "speeding_up",
  "form_flag_counts": { "too_fast": 3, "shallow": 4 },
  "fatigue_signal": "smoothness_down_22pct_over_set",
  "mobility_limited_at_deg": 112,
  "clinical_flags": { "rom_regression_vs_baseline_deg": -18, "tempo_guarding_pattern": true, "progression_stalled": false },
  "checkin": { "pain_today": 3, "knee_feel": 7 },
  "prior_sessions": [
    { "date": "2026-05-23", "avg_depth": 105, "reps": 24 },
    { "date": "2026-05-27", "avg_depth": 99, "reps": 27 }
  ],
  "asymmetry": "n/a_side_view"
}
```

BigQuery (Screen D reads): `sessions(session_id, user_id, exercise, started_at, sets_count, total_reps, avg_depth, adherence_flag)` and `sets(session_id, set_index, reps, avg_depth_deg, min_depth_deg, fatigue_score, debrief_text, recommended_next)`.

---

## 6. Phase machine → screen routing

```
CHECK_IN  → Screen C (check-in)
CALIBRATE → Screen A (calibration overlay: "do one squat to set your depth")
SET_ACTIVE→ Screen A (live)
SET_END   → Screen A (brief "set complete" state, then transition)
DEBRIEF   → Screen B
REST      → Screen B (debrief stays up; "Start" advances)
```
Full session: `CHECK_IN → CALIBRATE → SET_ACTIVE → SET_END → DEBRIEF → REST → SET_ACTIVE …`. A set ends when rep target is reached, ~4s of no movement, or a manual "End set" button (always available on Screen A).

---

## 7. Interactions & animation

- Screen A updates at WebSocket frame rate; keep render cheap (no heavy re-layout on the rep loop).
- Depth arc fills/empties smoothly; source pill flip is the key animation.
- Debrief: voice "Play" animates a progress bar; clinical toggle animates open/closed (max-height transition).
- Check-in: mic pulse on listening; chip/scale selection is instant.
- Clinician: chart and heatmap can draw in on mount; share/export show a 2.5s toast.
- Keep everything in component state — no browser localStorage in artifacts.

---

## 8. Guardrails (UI-enforced)

- Never render the words "diagnose", "diagnosis", "injury detected", or any prescription the app generated itself. The app coaches and tracks only.
- The everyday-user views (A, B-default, C) show NO raw degrees — translate to plain language and pass/fail visuals. Degrees live only in the clinician layer (B's "Show clinical details" toggle, and Screen D).
- Clinical flags are framed as "patterns to mention to your PT", in info-blue, never alarming red.
- The prescription on Screen D is read-only; the app never edits permissions or prescriptions.

---

## 9. Build order (protect the MVP)

1. **Screen A core loop** — camera + skeleton + rep counter + depth gauge + tracking-source flip + form-cue banner, driven by live/mock WebSocket. Nothing else matters until this is solid.
2. **Screen B (readable debrief)** — coach card + rep dots + "how it went" + Start button. Gemini text + voice playback.
3. **Screen C** — check-in (every session) first; intake second.
4. **Screen B clinical toggle** — the PT detail layer.
5. **Screen D** — mock only, for the pitch deck.

Fallbacks to keep working: IMU drops → pose-only, dashboard still works; camera bad → IMU-only, reps still count; Gemini fails → templated debrief; manual "End set" always available; all voice cue clips pre-generated.
