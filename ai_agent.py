"""
SteadyPT — Gemini Flash wrapper.

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
DEBRIEF_CHAR_CAP = 850              # ~25s of spoken debrief (4-6 sentences)
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


_DEBRIEF_PROMPT_TEMPLATE = """You are a knowledgeable, supportive physical-therapy exercise coach
giving a patient real-time spoken feedback right after they finish a set of squats.
You do NOT diagnose conditions or prescribe medical treatment. You coach form,
depth, tempo, and consistency based strictly on what the sensors measured.

The patient is described in the PROFILE block. If a patient_name is set, address
them by it. If a condition is set, you may reference it briefly (don't over-emphasise).
If contraindications are listed, mention one ONLY if the data suggests they came
close to violating it.

This set earned a SET SCORE out of 100 (in SUMMARY.set_score, with a letter grade
and per-component breakdown in SUMMARY.score). Open by acknowledging the score in
plain language ("that's a solid 84" / "82 — good work"), then explain WHAT drove it.

Ground every claim in SPECIFIC numbers from the SUMMARY. Useful fields:
- set_score, score.components (depth / consistency / tempo / completion)
- analysis.depth.target_hit_rate, mean_deg, halves_delta_deg, trend
- analysis.tempo.eccentric_concentric_ratio_mean, trend, mean_sec
- analysis.form.shallow_rep_indices, fast_rep_indices
- analysis.rom.min_deg/max_deg, voided_reps, fatigue_signal

Structure (still ONE flowing spoken paragraph, NOT a list):
1. The score + the single biggest thing that went well.
2. The single most useful thing to improve, tied to a specific number or rep.
3. ONE concrete, actionable next-set adjustment (reps / depth / tempo).

Warm, encouraging, plain-language PT vocabulary. 4-6 sentences.
NO markdown, NO bullet points, NO headings, NO emoji. It will be read ALOUD.

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


_SESSION_REPORT_PROMPT_TEMPLATE = """You are a physical therapist writing a brief progress note for your patient's chart.
Audience is the CLINICIAN at the next visit, NOT the patient. No medical advice.

From the patient's profile and the sequence of completed sets below, give:
- A 2-4 sentence summary of how the session went, citing the per-set scores
  (set_score) and how they trended across the session.
- Adherence (did they hit the prescribed reps and depth?).
- Depth trend across sets (improving, holding, declining).
- Fatigue pattern (early, late, none).
- One concrete recommended focus for the next visit.

PROFILE:
{profile_json}

SETS (oldest first):
{sets_json}
"""


def generate_session_report(profile: PTProfile, set_rows: list[dict]) -> Optional[str]:
    """Synthesize a clinician-facing progress note across all sets in a session.

    `set_rows` is a list of per-set summaries (or BQ row dicts) — anything with
    the standard summary fields will do. Returns None on missing key, no rows,
    or API error; caller can show a rule-based fallback instead.
    """
    if not set_rows:
        return None
    genai = _client()
    if genai is None:
        return None
    try:
        # Compact each set down to the fields that matter for trend analysis.
        compact = []
        for r in set_rows:
            analysis = r.get("analysis") or {}
            depth = analysis.get("depth") or {}
            tempo = analysis.get("tempo") or {}
            compact.append({
                "set_index":         r.get("set_index"),
                "set_score":         r.get("set_score"),
                "reps_completed":    r.get("reps_completed", r.get("reps")),
                "rep_target":        r.get("rep_target"),
                "avg_depth_deg":     depth.get("mean_deg", r.get("avg_depth_deg")),
                "min_depth_deg":     depth.get("min_deg",  r.get("min_depth_deg")),
                "target_hit_rate":   depth.get("target_hit_rate"),
                "depth_trend":       depth.get("trend"),
                "tempo_mean_sec":    tempo.get("mean_sec"),
                "tempo_trend":       tempo.get("trend"),
                "fatigue_signal":    r.get("fatigue_signal"),
            })
        prompt = _SESSION_REPORT_PROMPT_TEMPLATE.format(
            profile_json=json.dumps(profile.to_dict(), indent=2),
            sets_json=json.dumps(compact, indent=2)[:6000],
        )
        model = genai.GenerativeModel(GEMINI_MODEL)
        response = model.generate_content(prompt)
        text = (response.text or "").strip()
    except Exception as e:
        print(f"[ai_agent] generate_session_report error: {e}")
        return None
    if not text:
        return None
    return text[:DEBRIEF_CHAR_CAP * 2]  # ~ paragraph


_PROGRESS_REPORT_PROMPT_TEMPLATE = """You are a physical therapist writing a brief CROSS-SESSION progress note for a patient's chart. Audience is the CLINICIAN. You do NOT diagnose; you summarize measured range of motion and adherence trends over time.

Knee-angle depth is in degrees: LOWER = deeper squat = BETTER range of motion.

From the patient's session history below (oldest first), write in plain language:
- 3-4 sentences on the trend in range of motion (avg depth), reps, and adherence across sessions.
- ONE concrete focus for the next session.
Encouraging, monitoring tone. No markdown, no bullet lists, no emoji.

SESSION HISTORY (oldest first):
{history_json}
"""


def _progress_fallback(history) -> str:
    """Structured templated cross-session summary used when Gemini is unavailable."""
    if not history:
        return (
            "No prior sessions on record yet — this establishes the baseline. "
            "Keep a consistent routine and the trend will start to build."
        )
    n = len(history)
    completed = sum(1 for s in history if s.get("adherence_flag"))
    d0 = history[0].get("avg_depth")
    d1 = history[-1].get("avg_depth")
    if d0 is not None and d1 is not None:
        # Lower angle = deeper squat = better ROM.
        if d1 < d0 - 2:
            trend = f"Range of motion is improving (average depth {d0:.0f}° to {d1:.0f}°; deeper is better)"
        elif d1 > d0 + 2:
            trend = f"Range of motion has dipped slightly (average depth {d0:.0f}° to {d1:.0f}°)"
        else:
            trend = f"Range of motion is holding steady (~{d1:.0f}°)"
    else:
        trend = "Range of motion is being tracked"
    return (
        f"{trend} across {n} session{'s' if n != 1 else ''}. "
        f"Adherence: {completed}/{n} sessions completed as prescribed. "
        f"Next session, focus on holding consistent depth through every rep."
    )


def generate_progress_report(history) -> str:
    """Gemini #3 — cross-session progress note over BigQuery session history.

    `history` is a list of per-session dicts (oldest first), each with at least
    started_at, sets_count, total_reps, avg_depth, adherence_flag (see
    bq.query_session_history). Falls back to a structured templated summary when
    Gemini is unavailable or errors. NEVER returns None.
    """
    fallback = _progress_fallback(history)
    genai = _client()
    if genai is None or not history:
        return fallback
    try:
        compact = [{
            "started_at": s.get("started_at"),
            "sets_count": s.get("sets_count"),
            "total_reps": s.get("total_reps"),
            "avg_depth_deg": s.get("avg_depth"),
            "adherence": bool(s.get("adherence_flag")),
        } for s in history]
        prompt = _PROGRESS_REPORT_PROMPT_TEMPLATE.format(
            history_json=json.dumps(compact, indent=2)[:6000]
        )
        model = genai.GenerativeModel(GEMINI_MODEL)
        response = model.generate_content(prompt)
        text = (response.text or "").strip()
    except Exception as e:
        print(f"[ai_agent] generate_progress_report error: {e}")
        return fallback
    return text[:DEBRIEF_CHAR_CAP * 2] or fallback


# ---------------------------------------------------------------------------
# Conversational voice agent.
# ---------------------------------------------------------------------------
AGENT_ACTIONS = {
    "none", "start_set", "end_set", "next_set", "end_session",
    # Navigation — lets the patient run the app entirely hands-free.
    "go_checkin", "go_live", "go_debrief", "go_clinician",
    # Read the full set debrief aloud (server supplies the actual debrief text).
    "read_debrief",
    # Record a symptom / observation onto the session for the clinician handoff.
    "note",
}

_AGENT_PROMPT = """You are SteadyPT's voice coach — a warm, encouraging physical-therapy
exercise assistant talking OUT LOUD with a patient during their squat session. The patient
controls the whole app by voice, hands-free, so you are also their navigator.
You are NOT a doctor: never diagnose or prescribe medical treatment. If the patient
mentions pain or a medical worry, respond with empathy and gently suggest they check
with their physical therapist; do not give clinical advice.

You can take ACTIONS by setting the "action" field (infer intent, don't match exact words):
- "start_set"   : the patient is ready to begin / "let's go" / "I'm ready" / "start".
- "end_set"     : they're done with the current set / "stop" / "that's enough".
- "next_set"    : move on to the next set after a debrief.
- "end_session" : finish the whole session / "I'm finished for today".
- "go_checkin"  : show the check-in screen / "go to check in" / "home".
- "go_live"     : show the live workout screen / "take me to the workout" / "live view".
- "go_debrief"  : show the debrief / results screen / "show my results" / "how did the set go" (screen).
- "read_debrief": the patient wants to HEAR their debrief read aloud — "read my debrief",
  "play my debrief", "read me my results", "talk me through my set". Leave "speech" empty
  (or a brief lead-in like "Sure —"); the full debrief is read out automatically.
- "go_clinician": show the clinician / PT screen / "open the clinician view" / "PT dashboard".
- "note"        : the patient wants to record a symptom/observation for their PT —
  "note that my right knee hurts", "make a note: felt a twinge", "my knee is sore today".
  Acknowledge warmly that you've noted it (and gently suggest telling their PT if it's pain).
- "none"        : just converse — answer a question, encourage, chat. No action.

Only choose start_set when the phase is WAITING_FOR_START or DEBRIEF. Only choose end_set
when phase is SET_ACTIVE. If an action doesn't fit the phase, use "none" and say why briefly.
For navigation, prefer a go_* action when the patient clearly wants to see a different screen;
if they're only asking a question (e.g. "how did I do"), answer it with "none" instead of navigating.

KEEP IT MINIMAL DURING AN ACTIVE SET: when phase is SET_ACTIVE, the patient is mid-exercise —
reply with at most a short word of encouragement (or nothing: empty speech) unless they clearly
asked something or told you to stop. Don't chit-chat mid-rep.

Use the CONTEXT (phase, prescription, reps, last set) to answer naturally and SPECIFICALLY
— e.g. "how did I do" -> cite the last set's score and depth; "what's my prescription" ->
read it back; "how many sets left" -> do the math.

Return ONLY JSON: {{"speech": string, "action": one of the actions above}}.
"speech" is SHORT and natural — one or two spoken sentences. No markdown, no lists, no emoji.
It will be read aloud, so write how a coach would actually talk.

CONTEXT (live session state):
{context_json}

CONVERSATION SO FAR (most recent last):
{history_text}

PATIENT JUST SAID:
{user_text}
"""


def _converse_fallback(text: str) -> dict:
    """Keyword-based intent so voice still controls the app when Gemini is
    unavailable. Mirrors the action vocabulary of the LLM path."""
    t = (text or "").lower()
    if t.startswith("note") or "make a note" in t or "note that" in t or (
        "note" in t and any(w in t for w in ("hurt", "sore", "pain", "twinge", "ache"))
    ):
        return {"speech": "Got it — I've noted that for your PT.", "action": "note"}
    if ("session" in t or "workout" in t) and any(w in t for w in ("end", "finish", "done", "wrap")):
        return {"speech": "Wrapping up your session now.", "action": "end_session"}
    if ("debrief" in t or "results" in t or "summary" in t) and any(
        w in t for w in ("read", "play", "hear", "tell", "talk")
    ):
        return {"speech": "", "action": "read_debrief"}
    if "next" in t:
        return {"speech": "On to the next set.", "action": "next_set"}
    if any(w in t for w in ("start", "ready", "let's go", "lets go", "begin", "go ahead")):
        return {"speech": "Starting your set — get into position!", "action": "start_set"}
    if any(w in t for w in ("done", "stop", "finished", "end set", "that's it", "thats it", "enough")):
        return {"speech": "Ending the set. Nice work.", "action": "end_set"}
    return {"speech": "", "action": "none"}


def converse(user_text: str, context: dict, history: Optional[list] = None) -> dict:
    """One conversational turn for the voice coach.

    Returns {"speech": str, "action": <one of AGENT_ACTIONS>}. Falls back to a
    keyword intent (still controls the app) if Gemini is unavailable or errors —
    never raises.
    """
    user_text = (user_text or "").strip()
    if not user_text:
        return {"speech": "", "action": "none"}
    genai = _client()
    if genai is None:
        return _converse_fallback(user_text)
    try:
        hist = history or []
        history_text = "\n".join(
            f"{h.get('role', 'patient')}: {h.get('text', '')}" for h in hist[-6:]
        ) or "(none)"
        prompt = _AGENT_PROMPT.format(
            context_json=json.dumps(context or {}, indent=2)[:3000],
            history_text=history_text,
            user_text=user_text[:500],
        )
        model = genai.GenerativeModel(
            GEMINI_MODEL,
            generation_config={"response_mime_type": "application/json"},
        )
        response = model.generate_content(prompt)
        data = json.loads(_strip_json_fence(response.text or "{}"))
    except Exception as e:
        print(f"[ai_agent] converse error: {e}")
        return _converse_fallback(user_text)
    action = data.get("action", "none")
    if action not in AGENT_ACTIONS:
        action = "none"
    speech = (data.get("speech") or "").strip()[:DEBRIEF_CHAR_CAP]
    return {"speech": speech, "action": action}


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
