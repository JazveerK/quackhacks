"""
PhysioFusion — Gemini Flash wrapper.

Two pure functions used by pose_tracker / server:

- `parse_prescription(text)` -> PTProfile | None
  Take a PT's free-form prescription text and extract structured fields
  via gemini-2.5-flash with response_mime_type=application/json.

- `generate_debrief(profile, summary)` -> str | None
  Produce a clinical-voice end-of-set debrief grounded in the rich 4d
  summary + the active PT profile.

Both fail closed: if `GEMINI_API_KEY` is unset, if the API errors, or if the
response can't be parsed, return None. The caller falls back to defaults
(profile.DEFAULT_PROFILE for parse, summary.templated_debrief for debrief).
"""

from __future__ import annotations

import json
import os
import re
from typing import Optional

from profile import PTProfile, DEFAULT_PROFILE


GEMINI_MODEL = "gemini-2.5-flash"
DEBRIEF_CHAR_CAP = 600              # ~15-20s of ElevenLabs speech, plenty
MAX_PARSE_INPUT_CHARS = 4000        # cap the prescription text we send

# ---------------------------------------------------------------------------
# Prompts.
# ---------------------------------------------------------------------------
_PARSE_PROMPT = """You are extracting a physical therapist's exercise prescription from free-form text.
Return ONLY a JSON object with these keys (use null when a field is absent):

{
  "patient_name":      string | null,
  "condition":         string | null,
  "sets":              integer | null,
  "reps_per_set":      integer | null,
  "depth_deg":         number  | null,
  "tempo_sec":         number  | null,
  "focus":             string | null,
  "contraindications": [string]
}

Hints:
- "3x10" or "3 sets of 10" -> sets=3, reps_per_set=10.
- "deep" / "below parallel" -> depth_deg ~= 90.
- "to parallel" -> ~= 100. "shallow" / "quarter squat" -> ~= 120.
- "slow tempo" -> tempo_sec ~= 3.0. "controlled" -> 2.5. "fast" -> 1.2.
- Contraindications are short clinical phrases ("no valgus collapse",
  "no pain", "knees over toes ok").

TEXT:
"""


_DEBRIEF_PROMPT_TEMPLATE = """You are a supportive physical therapy exercise coach.
You do NOT diagnose conditions or prescribe medical treatment.
You coach form and range of motion based on what the sensors saw.

The patient is described in the PROFILE block. If a patient_name is set, address them by it.
If a condition is set, you may reference it briefly (do not over-emphasise).
If contraindications are listed, mention only if the data suggests the patient came close to violating one.

Reference SPECIFIC numbers from the SUMMARY block. Useful fields:
- analysis.depth.target_hit_rate, mean_deg, halves_delta_deg, trend
- analysis.tempo.eccentric_concentric_ratio_mean, trend, halves_delta_sec
- analysis.form.shallow_rep_indices, fast_rep_indices
- analysis.tracking.camera_frame_ratio
- voided_reps

Return a 3-5 sentence SPOKEN debrief in warm, plain-language PT vocabulary.
End with ONE concrete next-set adjustment (reps / depth / tempo).
NO markdown, NO bullet points, NO headings. One short paragraph.

PROFILE:
{profile_json}

SUMMARY:
{summary_json}
"""


# ---------------------------------------------------------------------------
# Internal helpers.
# ---------------------------------------------------------------------------
def _client():
    """Configure the SDK once. Returns the genai module, or None if no key."""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        return None
    try:
        import google.generativeai as genai
        genai.configure(api_key=key)
        return genai
    except Exception as e:
        print(f"[ai_agent] SDK configure error: {e}")
        return None


def _strip_json_fence(text: str) -> str:
    """Defensive: strip markdown code fences if Gemini returns them anyway."""
    t = text.strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    return t.strip()


# ---------------------------------------------------------------------------
# Public API.
# ---------------------------------------------------------------------------
def parse_prescription(text: str) -> Optional[PTProfile]:
    """Extract a PTProfile from free-form prescription text.

    Returns None on missing key, empty text, or API/parse error. Caller
    falls back to the existing active profile (often DEFAULT_PROFILE).
    """
    if not text or not text.strip():
        return None
    genai = _client()
    if genai is None:
        return None
    snippet = text.strip()[:MAX_PARSE_INPUT_CHARS]
    try:
        model = genai.GenerativeModel(
            GEMINI_MODEL,
            generation_config={"response_mime_type": "application/json"},
        )
        response = model.generate_content(_PARSE_PROMPT + snippet)
        raw = _strip_json_fence(response.text or "")
        data = json.loads(raw)
    except Exception as e:
        print(f"[ai_agent] parse_prescription error: {e}")
        return None

    # Merge parsed values over the default profile so missing fields keep
    # sensible values.
    base = DEFAULT_PROFILE.to_dict()
    for k, v in (data or {}).items():
        if v is None:
            continue
        if k == "contraindications" and not isinstance(v, list):
            continue
        base[k] = v
    base["source"] = "parsed"
    try:
        return PTProfile.from_dict(base)
    except Exception as e:
        print(f"[ai_agent] PTProfile.from_dict error: {e}")
        return None


def generate_debrief(profile: PTProfile, summary: dict) -> Optional[str]:
    """Produce a 3-5 sentence clinical debrief tailored to the profile.

    Returns None on missing key / API error / empty response. Caller falls
    back to `summary['templated_debrief']`.
    """
    genai = _client()
    if genai is None:
        return None
    try:
        prompt = _DEBRIEF_PROMPT_TEMPLATE.format(
            profile_json=json.dumps(profile.to_dict(), indent=2),
            summary_json=json.dumps(summary, indent=2)[:6000],
        )
        model = genai.GenerativeModel(GEMINI_MODEL)
        response = model.generate_content(prompt)
        text = (response.text or "").strip()
    except Exception as e:
        print(f"[ai_agent] generate_debrief error: {e}")
        return None
    if not text:
        return None
    return text[:DEBRIEF_CHAR_CAP]
