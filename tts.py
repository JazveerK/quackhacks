"""
SteadyPT — backend text-to-speech (ElevenLabs).

A single pure function, `synthesize(text) -> bytes | None`, that turns a debrief
string into MP3 audio via ElevenLabs. Used by the `/tts` server endpoint so the
spoken AI debrief sounds like a real coach rather than the robotic browser voice.

Fails closed at every layer: if `ELEVENLABS_API_KEY` is unset, the network call
errors, or the response isn't audio, it returns None and the frontend falls back
to the browser's built-in SpeechSynthesis. Voice is never load-bearing.

No third-party HTTP dependency — uses stdlib urllib so it works with the existing
requirements.txt.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Optional

# Default ElevenLabs voice ("Rachel" — warm, clear, good for spoken coaching).
# Override with ELEVENLABS_VOICE_ID. eleven_turbo_v2_5 is the low-latency model.
DEFAULT_VOICE_ID = "21m00Tcm4TlvDq8ikWAM"
DEFAULT_MODEL_ID = "eleven_turbo_v2_5"
API_BASE = "https://api.elevenlabs.io/v1/text-to-speech"
REQUEST_TIMEOUT_SEC = 12
MAX_TTS_CHARS = 1200            # guard against runaway input cost


def _api_key() -> str:
    return os.environ.get("ELEVENLABS_API_KEY", "").strip()


def is_available() -> bool:
    """True if an ElevenLabs key is configured. Does not make a network call."""
    return bool(_api_key())


def synthesize(text: str, voice_id: Optional[str] = None) -> Optional[bytes]:
    """Render `text` to MP3 bytes via ElevenLabs. Returns None on any failure.

    Caller (the /tts endpoint) returns 503 on None so the browser falls back to
    its local SpeechSynthesis voice.
    """
    key = _api_key()
    if not key:
        return None
    text = (text or "").strip()
    if not text:
        return None
    text = text[:MAX_TTS_CHARS]

    voice = voice_id or os.environ.get("ELEVENLABS_VOICE_ID", "").strip() or DEFAULT_VOICE_ID
    url = f"{API_BASE}/{voice}"
    payload = json.dumps({
        "text": text,
        "model_id": DEFAULT_MODEL_ID,
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=payload, method="POST",
        headers={
            "xi-api-key": key,
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as resp:
            ctype = resp.headers.get("Content-Type", "")
            data = resp.read()
            if "audio" not in ctype or not data:
                print(f"[tts] unexpected response content-type={ctype!r}")
                return None
            return data
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        print(f"[tts] HTTPError {e.code}: {body}")
        return None
    except Exception as e:
        print(f"[tts] error: {e}")
        return None
