# SteadyPT — Demo Script (recorded hackathon version)

> A beat-by-beat storyboard for the recorded demo video. Target length **2:30–3:00**.
> Camera-only build — **no IMU, no sensor-fusion claims** (see `PRESENTATION.md` §9).
> The goal: show a real patient running a full PT session hands-free, then show the
> clinician getting structured clinical data out the other end.
>
> Read `PRESENTATION.md` first for the "why." This file is the "what to film."

---

## 0. The one-sentence story

*"Sam is six weeks post-ACL surgery, doing prescribed squats at home. SteadyPT
coaches every rep on a webcam, scores the set with AI, lets Sam run the whole thing
by voice, and hands the physical therapist a real clinical report — all with no
wearable, no app install, just a browser and a camera."*

---

## 1. Pre-flight checklist (before you hit record)

**Environment**
- [ ] `.venv/bin/python run.py` running; `http://127.0.0.1:8000` open in the browser.
- [ ] `GEMINI_API_KEY`, `ELEVENLABS_API_KEY` set (check `GET /session` → `gemini_available: true`, `tts_available: true`). These make the AI debrief *spoken* and the voice agent smart.
- [ ] `gcloud auth application-default login` done **and** `seed_bigquery.py` run, so the Clinician view has real cross-session history. (Optional — it falls back gracefully, but the trend chart sells it.)
- [ ] Camera placed **side-on** at hip/knee height so the whole body is in frame. (Use the iPhone Continuity Camera — `run.py` auto-picks it; it's why we can stand to the side.)
- [ ] Browser mic permission granted (for the voice agent). Quiet room.
- [ ] Window zoom so the rep counter, depth arc, and skeleton are all clearly legible on the recording.

**Rehearse the squat reps** so depth and tempo look clean on camera — a couple of
crisp reps read far better than ten sloppy ones. Aim to **hit the rep target** so
the set ends naturally on a high note.

**Recording**
- [ ] Screen capture at 1080p; capture system audio (so the spoken coach voice is on the recording) + your narration mic.
- [ ] Have a second person read the voiceover, or narrate live and tighten in edit.

---

## 2. The shot list (what's on screen, in order)

| # | Screen | Proves |
|---|---|---|
| 1 | Check-in | It's grounded in a real prescription, not a toy |
| 2 | "Any exercise" load (optional headline) | The LLM-compiles-a-tracker differentiator |
| 3 | Live session — clean reps | Real-time pose tracking + coaching works |
| 4 | Live session — a deliberate bad rep | The coaching is *specific*, not cosmetic |
| 5 | Hands-free voice "stop" | The patient never touches the laptop |
| 6 | Debrief — score + spoken AI debrief | AI reasons over the whole set, grounded in numbers |
| 7 | Clinician view / FHIR handoff | Structured clinical data, real interop |
| 8 | Close | The one-liner + the team |

---

## 3. Beat-by-beat storyboard

### Beat 1 — Cold open + check-in (0:00–0:25)

- **On screen:** the Check-in screen. Sam's prescription is visible ("post-ACL
  repair, left knee, 6 weeks · 3 × 8 squats · controlled tempo").
- **Action:** confirm today's workout, tap through the quick pain/ROM check-in.
- **Voiceover:** *"This is Sam, six weeks after ACL surgery. Their physical therapist
  prescribed three sets of eight squats. SteadyPT loads that prescription — sets,
  reps, target depth, even the 'no valgus collapse' contraindication — and turns it
  into a live coaching session. No wearable. Just a webcam."*
- **Why this beat:** establishes it's a *clinical* tool driven by a real
  prescription, and quietly states the framing rule (coaching, not diagnosis).

### Beat 2 — "Any exercise" (optional, 0:25–0:45) — *the headline flex*

- **On screen:** the prescription-upload / exercise picker. Paste a *different*
  exercise's documentation (or upload a PDF prescription).
- **Action:** paste e.g. *"Standing lateral arm raise, lift to shoulder height, 12
  reps"* → submit → it appears in the picker and the gauge relabels.
- **Voiceover:** *"Here's the part most demos can't do. A therapist can describe
  ANY exercise in plain text, and SteadyPT compiles it — once, with Gemini — into a
  real-time tracker. No retraining, no new code. The squat, a push-up, an arm raise
  — same engine, different prescription."*
- **Why this beat:** this is the strongest differentiator. If you only have time for
  one "wow," it's this. (Switch back to the squat for the live reps.)
- **Cut-safe:** if the live generation is slow on the day, pre-generate it before
  recording and just show it already in the dropdown.

### Beat 3 — Live session, clean reps (0:45–1:15)

- **On screen:** Live dashboard. Skeleton overlay turns **green** when locked on; the
  rep counter ticks 1, 2, 3…; the depth arc fills toward the target marker.
- **Action:** do 3–4 clean, controlled squats. Let the deterministic voice cues fire
  ("good depth," "nice control").
- **Voiceover:** *"As Sam squats, MediaPipe tracks the knee angle in real time. The
  rep only counts if it's deep enough, controlled enough, and clearly tracked — so
  half-reps and twitches don't inflate the count. The coaching during the set is a
  fast rule loop. The AI never touches the per-frame path."*
- **Why this beat:** shows the core works and plants the "LLM is off the hot path"
  engineering point.

### Beat 4 — A deliberate bad rep (1:15–1:30)

- **On screen:** do one obviously **shallow** (or too-fast) rep.
- **Action:** the form-cue banner flags it; if it's shallow enough to void, the count
  doesn't advance and the reason surfaces.
- **Voiceover:** *"And it's specific. A shallow rep gets called out by name — and if
  it doesn't meet the prescribed depth, it simply doesn't count."*
- **Why this beat:** proves the coaching is real measurement, not decoration. Judges
  love seeing the system *refuse* a rep.

### Beat 5 — Hands-free voice control (1:30–1:45)

- **On screen:** finish the set's reps (ideally hit the target so it ends naturally),
  or say the wake phrase to stop.
- **Action:** speak **"Hey coach, that's it for this set."** The voice agent
  acknowledges and ends the set.
- **Voiceover:** *"Sam's hands are busy — so the whole app is voice-driven. 'Hey
  coach' wakes it; it understands intent, knows what phase you're in, and drives the
  session start to finish, completely hands-free."*
- **Why this beat:** the hands-free angle is a genuine PT-at-home insight, not a
  gimmick — you literally can't tap a laptop mid-squat.

### Beat 6 — The AI debrief (1:45–2:15)

- **On screen:** the Debrief screen. The set **score** lands (e.g. "84 — B"), per-rep
  depth bars render, trend chips show. The AI debrief text appears and is **spoken
  aloud** in the ElevenLabs coach voice.
- **Action:** let the spoken debrief play (it opens with the score, cites specific
  numbers, gives one concrete next-set adjustment).
- **Voiceover:** *"At set end, Gemini reasons over the entire set — every rep's
  depth, tempo, the trend, the fatigue signal — and speaks a debrief grounded in the
  actual numbers, plus one concrete adjustment for the next set. The instant
  templated version shows first, so there's never a blank wait, then the AI version
  swaps in."*
- **Why this beat:** this is the "AI agent" payoff. The key is that it's *specific*
  ("reps five and nine came up shallow"), which only works because the score and
  analytics are computed deterministically first.

### Beat 7 — The clinician handoff (2:15–2:45) — *the closer that sells the product*

- **On screen:** switch to the **Clinician** view: the cross-session ROM/adherence
  trend (BigQuery-backed) + the Gemini progress note. Then open the **`/share/<id>`
  FHIR handoff** page.
- **Action:** show the FHIR Observation: the quality gate ("pass"), the normative
  interpretation (L/N/H vs the age/sex reference range), and the raw FHIR JSON.
- **Voiceover:** *"And the therapist gets real data back. Every session is stored in
  BigQuery for trends, and exported as a proper FHIR Observation — LOINC-coded, with
  a measurement-quality gate and age- and sex-normed reference ranges aligned to CDC
  fall-risk screening. It's observational data for clinician review — clearly never a
  diagnosis — and it drops straight into a real clinical workflow."*
- **Why this beat:** elevates it from "cool fitness demo" to "digital-health
  product." The FHIR/interop story is what a serious judge remembers.

### Beat 8 — Close (2:45–3:00)

- **On screen:** back to a clean shot of the live dashboard or a title card.
- **Voiceover:** *"SteadyPT — an AI physical-therapy coach that runs on any webcam,
  works for any prescribed exercise, runs hands-free by voice, and closes the loop
  with the clinician. Built in 24 hours at QuackHacks."*
- **Optional:** quick team credit.

---

## 4. Voice-agent commands you can show (all real)

| Say (after "hey coach…") | What happens |
|---|---|
| "I'm ready" / "let's go" | starts the set (3-2-1 countdown) |
| "that's enough" / "stop" | ends the current set |
| "next set" | advances after the debrief |
| "read me my results" | reads the full debrief aloud |
| "note that my knee feels tight" | records a symptom for the clinician handoff |
| "how did I do?" | speaks the last set's score + depth |
| "take me to the clinician view" | navigates screens |
| "I'm finished for today" | ends the session, produces the report |

Pick 2–3 for the recording — don't list all of them on camera.

---

## 5. Fallback plan (if something flakes mid-record)

Everything degrades gracefully, so you can keep rolling:

- **Voice not recognized** → there are on-screen buttons for start/stop/next; use
  them and re-record the voice beat separately.
- **Gemini slow / errors** → the **templated debrief** still appears and the score is
  still computed; the set still completes. (TTS falls back to the browser voice.)
- **BigQuery empty / unreachable** → the Clinician handoff falls back to a baked-in
  demo FHIR Observation; the trend view falls back to the in-session data.
- **Camera loses you** → that's actually a fine beat to *show* (the "Can't see you"
  takeover), then step back in — it demonstrates we detect it and don't count garbage.
- **A rep miscounts on camera** → re-take; clean reps with good side-on framing are
  the single biggest quality lever.

The mantra: **one flawless beat beats five flaky ones.** If a beat won't cooperate,
cut it and lean harder on Check-in → Live → Debrief → Clinician.

---

## 6. Hard rules for the recording

- ❌ **Do not** mention, show, or imply an IMU, wearable, "sensor fusion," or
  "tracking through occlusion." This build is camera-only. If asked live, the honest
  line is in `PRESENTATION.md` §9 — but it does **not** belong in the recorded demo.
- ❌ **Never** say "diagnose," "detect injury," or "fall risk detected." Always
  "measure," "coach," "screening signal for clinician review." The framing rule is
  load-bearing for a health product.
- ✅ Keep the camera **side-on** and the whole body in frame — it's the difference
  between clean reps and a frustrating take.
- ✅ Let the spoken coach voice be audible on the recording — it's half the magic.
- ✅ End on the clinician/FHIR beat or the one-liner; that's the lasting impression.

---

## 7. If you only have 60 seconds (lightning cut)

Check-in (5s) → one clean rep + the counter ticking (10s) → one shallow rep getting
called out (8s) → "hey coach, that's it" (5s) → the spoken AI debrief with the score
(17s) → the FHIR clinician handoff (15s). Drop Beat 2 (any-exercise) and the trend
chart. You still hit: real prescription, real-time coaching, specific feedback,
hands-free, AI reasoning, clinical interop.
