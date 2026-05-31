# PhysioFusion — ElevenLabs Coach Voice Integration

The coach speaks in two places. They use opposite strategies on purpose.

| Surface | Text source | Strategy | Why |
|---|---|---|---|
| **Live form cues** (footer banner during a set) | Fixed phrase set | **Pre-generate** to static `.mp3`, play client-side | Zero latency, zero API calls mid-set, works offline, near-zero credit burn |
| **Between-set debrief** ("Hear this") | Gemini, dynamic per set | **Generate on demand** via backend | Text isn't known until the set ends |

**Plan:** Creator — 100k credits/mo (~100 min), commercial license, 192 kbps, API access included. A debrief ≈ 300 chars, so the quota is effectively unlimited for the demo.

**Model:** `eleven_multilingual_v2` everywhere. *Do not use Flash for the debrief* — it mis-reads numbers ("10 squats", "6 of them"), which is exactly our copy. Multilingual v2 normalizes numbers and sounds warmer for a 65+ audience. Same `voice_id` for cues and debrief so the coach has one consistent voice.

**Security:** the API key lives ONLY on the Python backend. Never put it in a `VITE_`-prefixed var — those ship in the browser bundle.

---

## 0. Setup

```bash
# backend/.env  (gitignored)
ELEVENLABS_API_KEY=sk_...
ELEVENLABS_VOICE_ID=...   # pick one warm, clear voice from the library, copy its ID
```

Pick the voice once in the ElevenLabs dashboard (Voices → copy the Voice ID). A calm, mid-range voice reads best for the audience; audition against a debrief sentence, not "hello world".

---

## 1. Pre-generate the live cues (one-time script)

Run this once (and again whenever you edit a cue). It writes static files to the frontend's `public/` so the live loop just plays them — no network at runtime.

```python
# backend/scripts/generate_cues.py
import os, pathlib, requests

API_KEY  = os.environ["ELEVENLABS_API_KEY"]
VOICE_ID = os.environ["ELEVENLABS_VOICE_ID"]
MODEL    = "eleven_multilingual_v2"

# Keys here MUST match the cue IDs the live WebSocket loop emits.
CUES = {
    "good_depth":     "Good depth. Control the way up.",
    "go_deeper":      "Try going down a little deeper.",
    "slow_down":      "Nice and slow on the way down.",
    "steady_tempo":   "Good, steady pace.",
    "almost_there":   "Almost there. One more.",
    "great_set":      "Great set. Take a breath.",
    # ...add the full fixed set
}

out = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "public" / "cues"
out.mkdir(parents=True, exist_ok=True)

for cue_id, text in CUES.items():
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}",
        params={"output_format": "mp3_44100_192"},  # 192 kbps is Creator-tier
        headers={"xi-api-key": API_KEY, "Content-Type": "application/json"},
        json={
            "text": text,
            "model_id": MODEL,
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
        },
        timeout=30,
    )
    r.raise_for_status()
    (out / f"{cue_id}.mp3").write_bytes(r.content)
    print(f"  ✓ {cue_id}.mp3  ({len(text)} chars)")
```

```bash
cd backend && python scripts/generate_cues.py
# -> frontend/public/cues/good_depth.mp3, etc.
```

### Play a cue in the live loop (frontend)

The WebSocket already emits a cue id per frame. Preload once, play on change. Keep audio in sync with the footer banner text you already render.

```js
// frontend/src/coach/cuePlayer.js
const cache = new Map();
function clip(id) {
  if (!cache.has(id)) cache.set(id, new Audio(`/cues/${id}.mp3`));
  return cache.get(id);
}
let last = null;
export function playCue(id) {
  if (!id || id === last) return;   // don't retrigger the same cue every frame
  last = id;
  const a = clip(id);
  a.currentTime = 0;
  a.play().catch(() => {});         // ignore autoplay rejections pre-gesture
}
```

> Browser autoplay rule: the first `.play()` must follow a user gesture. The "Start set" tap counts — that unlocks audio for the rest of the session.

---

## 2. Debrief endpoint (backend, on demand)

Add one route to the existing FastAPI app. It takes the Gemini-written `coach_text` and returns audio.

```python
# backend/coach_voice.py
import os, requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter()
API_KEY  = os.environ["ELEVENLABS_API_KEY"]
VOICE_ID = os.environ["ELEVENLABS_VOICE_ID"]

class SpeakReq(BaseModel):
    text: str

@router.post("/coach/speak")
def speak(req: SpeakReq):
    text = req.text.strip()
    if not text:
        raise HTTPException(400, "empty text")
    if len(text) > 1200:                      # debriefs are short; cap as a guard
        raise HTTPException(413, "text too long")
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}",
        params={"output_format": "mp3_44100_192"},
        headers={"xi-api-key": API_KEY, "Content-Type": "application/json"},
        json={
            "text": text,
            "model_id": "eleven_multilingual_v2",   # NOT flash — reads numbers correctly
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
        },
        timeout=30,
    )
    if r.status_code != 200:
        raise HTTPException(502, f"tts failed: {r.text[:200]}")
    return Response(content=r.content, media_type="audio/mpeg")
```

Wire it up + CORS for the Vite origin:

```python
# backend/main.py
from coach_voice import router as coach_router
app.include_router(coach_router)
# ensure CORSMiddleware already allows http://localhost:5173 (your Vite dev origin)
```

### "Hear this" button (frontend)

```jsx
// frontend/src/coach/useDebriefAudio.js
import { useState } from "react";
const API = import.meta.env.VITE_API_BASE ?? "http://localhost:8000";

export function useDebriefAudio() {
  const [state, setState] = useState("idle"); // idle | loading | playing
  async function play(text) {
    try {
      setState("loading");
      const res = await fetch(`${API}/coach/speak`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(await res.text());
      const url = URL.createObjectURL(await res.blob());
      const audio = new Audio(url);
      audio.onended = () => { URL.revokeObjectURL(url); setState("idle"); };
      setState("playing");
      await audio.play();
    } catch (e) {
      console.error("debrief audio:", e);
      setState("idle");           // fall back to the silent progress-bar animation
    }
  }
  return { state, play };
}
```

In the Debrief screen, replace the fake 14s progress bar with:

```jsx
const { state, play } = useDebriefAudio();
<GhostButton onClick={() => play(summary.coach_text)} disabled={state === "loading"}>
  {state === "loading" ? "Loading…" : state === "playing" ? "Playing…" : "Hear this"}
</GhostButton>
```

---

## 3. Optional polish: pre-warm the debrief during REST

The set ends → you transition to REST → the user reads for a few seconds before tapping "Hear this." Use that window: kick off `/coach/speak` the moment the debrief text arrives, cache the blob URL, and have the button play the cached audio instantly. Removes the only latency the user would notice.

---

## Gotchas checklist

- [ ] API key is backend-only (no `VITE_` prefix).
- [ ] Same `voice_id` for cues and debrief.
- [ ] `eleven_multilingual_v2`, not Flash — number normalization.
- [ ] Cue IDs in `generate_cues.py` exactly match what the WebSocket emits.
- [ ] First audio play happens after the "Start set" gesture (autoplay policy).
- [ ] CORS allows the Vite dev origin.
- [ ] Audio failure degrades gracefully to the silent progress bar — never block the debrief UI on TTS.
- [ ] `voice_settings` tuned by ear against a real debrief sentence.
```