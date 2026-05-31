"""
One-time script: pre-generate coach voice cues as static MP3 files.

Usage:
    export ELEVENLABS_API_KEY=sk_...
    export ELEVENLABS_VOICE_ID=...
    python backend/scripts/generate_cues.py

Writes to frontend/public/cues/<cue_id>.mp3
"""

import os
import pathlib
import requests

API_KEY = os.environ["ELEVENLABS_API_KEY"]
VOICE_ID = os.environ["ELEVENLABS_VOICE_ID"]
MODEL = "eleven_multilingual_v2"

# Keys MUST match the cue IDs the live WebSocket loop emits in form_flags / cue fields.
CUES = {
    "good_depth": "Good depth. Control the way up.",
    "go_deeper": "Try going down a little deeper.",
    "slow_down": "Nice and slow on the way down.",
    "steady_tempo": "Good, steady pace.",
    "almost_there": "Almost there. One more.",
    "great_set": "Great set. Take a breath.",
    "knees_caving": "Push your knees out over your toes.",
    "too_fast": "Slow it down. Control the movement.",
}

out = pathlib.Path(__file__).resolve().parents[2] / "frontend" / "public" / "cues"
out.mkdir(parents=True, exist_ok=True)

for cue_id, text in CUES.items():
    print(f"  Generating {cue_id}...", end=" ", flush=True)
    r = requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}",
        params={"output_format": "mp3_44100_192"},
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
    print(f"✓ ({len(text)} chars)")

print(f"\nDone — {len(CUES)} cues written to {out}")
