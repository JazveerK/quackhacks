"""
ElevenLabs TTS endpoint for dynamic coach debrief audio.

Pre-generated cues are static MP3s served from frontend/public/cues/.
This module handles only the on-demand debrief speech.
"""

import os

import requests as http_requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

router = APIRouter()

API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "")
MODEL = "eleven_multilingual_v2"


class SpeakReq(BaseModel):
    text: str


@router.post("/coach/speak")
def speak(req: SpeakReq):
    if not API_KEY or not VOICE_ID:
        raise HTTPException(503, "ElevenLabs not configured")

    text = req.text.strip()
    if not text:
        raise HTTPException(400, "empty text")
    if len(text) > 1200:
        raise HTTPException(413, "text too long")

    r = http_requests.post(
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
    if r.status_code != 200:
        raise HTTPException(502, f"tts failed: {r.text[:200]}")

    return Response(content=r.content, media_type="audio/mpeg")
