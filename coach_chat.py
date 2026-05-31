"""
Conversational coach endpoint.

User speaks → text arrives here → Gemini generates a coaching reply →
ElevenLabs speaks it → we return both text + audio in one response.
"""

import json
import os
from typing import Optional

import requests as http_requests
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

router = APIRouter()

GEMINI_MODEL = "gemini-2.5-flash"
ELEVENLABS_API_KEY = os.environ.get("ELEVENLABS_API_KEY", "")
ELEVENLABS_VOICE_ID = os.environ.get("ELEVENLABS_VOICE_ID", "")

_SYSTEM_PROMPT = """You are a supportive, warm physical therapy exercise coach named Coach.
You are talking to a patient during or between sets of bodyweight squats.

Rules:
- Keep replies SHORT: 1-3 sentences max. You are speaking aloud — be concise.
- Use warm, encouraging, plain language. No jargon.
- You may reference their current session data (provided below) to give specific feedback.
- If they ask about pain or medical concerns, say "That's a great question for your PT" — never diagnose.
- If they ask you to adjust the workout (fewer reps, deeper, slower), acknowledge it supportively.
- If they just say hi or chat casually, be friendly and brief.
- End with encouragement when appropriate.
- NO markdown, NO bullet points. Just natural spoken sentences.
"""


class ChatReq(BaseModel):
    message: str
    session_state: Optional[dict] = None
    history: Optional[list] = None  # [{role: "user"|"coach", text: "..."}]


@router.post("/coach/chat")
def coach_chat(req: ChatReq):
    message = req.message.strip()
    if not message:
        raise HTTPException(400, "empty message")

    # Build Gemini prompt
    genai = _get_genai()
    if genai is None:
        raise HTTPException(503, "Gemini not configured (set GEMINI_API_KEY)")

    # Build context
    context_parts = [_SYSTEM_PROMPT]
    if req.session_state:
        context_parts.append(f"\nCURRENT SESSION STATE:\n{json.dumps(req.session_state, indent=2)[:2000]}")

    # Build conversation history for multi-turn
    contents = []
    if req.history:
        for msg in req.history[-6:]:  # keep last 6 turns to stay under token limits
            role = "user" if msg.get("role") == "user" else "model"
            contents.append({"role": role, "parts": [{"text": msg["text"]}]})

    contents.append({"role": "user", "parts": [{"text": message}]})

    try:
        model = genai.GenerativeModel(
            GEMINI_MODEL,
            system_instruction="\n".join(context_parts),
        )
        response = model.generate_content(contents)
        reply_text = (response.text or "").strip()
    except Exception as e:
        print(f"[coach_chat] Gemini error: {e}")
        raise HTTPException(502, f"Gemini error: {str(e)[:200]}")

    if not reply_text:
        raise HTTPException(502, "Empty response from Gemini")

    # Cap reply length for TTS
    reply_text = reply_text[:800]

    # Generate audio if ElevenLabs is configured
    audio_available = bool(ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID)
    result = {"text": reply_text, "audio_available": audio_available}

    return JSONResponse(result)


@router.post("/coach/chat/speak")
def coach_chat_speak(req: ChatReq):
    """Same as /coach/chat but returns audio/mpeg directly."""
    # Get text reply first
    resp = coach_chat(req)
    data = json.loads(resp.body)
    text = data["text"]

    if not ELEVENLABS_API_KEY or not ELEVENLABS_VOICE_ID:
        raise HTTPException(503, "ElevenLabs not configured")

    r = http_requests.post(
        f"https://api.elevenlabs.io/v1/text-to-speech/{ELEVENLABS_VOICE_ID}",
        params={"output_format": "mp3_44100_192"},
        headers={"xi-api-key": ELEVENLABS_API_KEY, "Content-Type": "application/json"},
        json={
            "text": text,
            "model_id": "eleven_multilingual_v2",
            "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
        },
        timeout=30,
    )
    if r.status_code != 200:
        # Fall back to text-only
        return JSONResponse({"text": text, "audio_available": False})

    # Return multipart-ish: we'll use a custom header for the text
    return Response(
        content=r.content,
        media_type="audio/mpeg",
        headers={"X-Coach-Text": text.replace("\n", " ")},
    )


def _get_genai():
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        return None
    try:
        import google.generativeai as genai
        genai.configure(api_key=key)
        return genai
    except Exception as e:
        print(f"[coach_chat] genai configure error: {e}")
        return None
