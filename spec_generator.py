"""
PhysioFusion — Exercise Spec generator (the ONLY LLM in the exercise pipeline).

`generate_spec_from_docs(documentation_text)` calls Gemini ONCE, at
exercise-load time, to turn a PT's written exercise documentation into a
validated Exercise Spec (see `exercise_spec.py`). The real-time tracker then
runs that spec with NO further LLM calls — the model never touches the per-frame
rep path.

Fails safe: on a missing key, a parse error (after one retry), or a validation
failure, it returns the default squat spec and a clear error message so the
caller can surface it. Voice/AI is never load-bearing.
"""

from __future__ import annotations

import json
import os
import re
from typing import Optional

from exercise_spec import ExerciseSpec, SQUAT_SPEC, DEFAULT_EXERCISE


GEMINI_MODEL = "gemini-2.5-flash"
MAX_DOC_CHARS = 4000


_SYSTEM_PROMPT = """You convert a physical therapist's written exercise documentation into a
strict JSON "Exercise Spec" that a real-time pose tracker will use to count reps and coach form.
This is exercise coaching, NOT medical diagnosis — never output medical advice.

Return ONLY a JSON object (no prose, no markdown fences) with EXACTLY this shape:

{
  "name": string,                       // short exercise name
  "view": "front" | "side",            // best camera angle to see the motion
  "rom_metric": "min" | "max",         // "min" if a good rep means a SMALLER joint angle
                                          // (squat, curl: bend/go lower); "max" if it means a
                                          // LARGER joint angle (arm raise, leg extension: open up)
  "primary_joint": {
    "name": string,                     // e.g. "knee", "elbow", "shoulder_abduction"
    "landmarks": [A, VERTEX, C],        // 3 MediaPipe Pose landmark names; the angle is at VERTEX
    "side": "left" | "right" | "both"
  },
  "rep_definition": {                    // all degrees, 0..180
    "start_angle_deg":   number,        // resting position angle
    "trigger_angle_deg": number,        // must pass this (toward the active end) to begin a rep
    "target_angle_deg":  number,        // a GOOD rep reaches this
    "return_angle_deg":  number         // must cross back past this to finish the rep
  },
  "form_rules": [
    {"name": "too_fast", "type": "tempo", "min_sec": number},
    {"name": "incomplete", "type": "target_not_reached"}
  ],
  "cues": {                              // SHORT imperative spoken phrases
    "go_further": string, "good": string, "too_fast": string,
    "countdown": [string, string]
  },
  "rep_target": integer
}

Valid MediaPipe Pose landmark names include: NOSE, LEFT_SHOULDER, RIGHT_SHOULDER, LEFT_ELBOW,
RIGHT_ELBOW, LEFT_WRIST, RIGHT_WRIST, LEFT_HIP, RIGHT_HIP, LEFT_KNEE, RIGHT_KNEE, LEFT_ANKLE,
RIGHT_ANKLE. Use base names without the LEFT_/RIGHT_ prefix when side is "both".

Rules for choosing values:
- Pick the joint whose angle changes most across the movement; VERTEX is that joint.
- rom_metric "min" => start angle is large (limb extended) and the rep gets SMALLER; order is
  target < trigger < start, and return is just below start. "max" => start small and the rep gets
  LARGER; order is start < trigger < target, and return is just above start.
- Choose a "front" view for raises/abduction (motion is across the body) and "side" for
  squats/curls/push-ups (motion is in profile).
- Keep cues to 2-4 words, imperative ("raise higher", "slow it down").

WORKED EXAMPLES

Doc: "Bodyweight squat to parallel, controlled, 10 reps. Knees track over toes."
{"name":"bodyweight squat","view":"side","rom_metric":"min",
 "primary_joint":{"name":"knee","landmarks":["HIP","KNEE","ANKLE"],"side":"both"},
 "rep_definition":{"start_angle_deg":165,"trigger_angle_deg":115,"target_angle_deg":95,"return_angle_deg":155},
 "form_rules":[{"name":"too_fast","type":"tempo","min_sec":1.0},{"name":"shallow","type":"target_not_reached"}],
 "cues":{"go_further":"go a little deeper","good":"good depth","too_fast":"slow it down","countdown":["two more","last one"]},
 "rep_target":10}

Doc: "Standing lateral arm raise, lift arms out to shoulder height, 12 reps."
{"name":"standing lateral arm raise","view":"front","rom_metric":"max",
 "primary_joint":{"name":"shoulder_abduction","landmarks":["HIP","SHOULDER","ELBOW"],"side":"both"},
 "rep_definition":{"start_angle_deg":20,"trigger_angle_deg":60,"target_angle_deg":90,"return_angle_deg":30},
 "form_rules":[{"name":"too_fast","type":"tempo","min_sec":0.8},{"name":"incomplete","type":"target_not_reached"}],
 "cues":{"go_further":"raise a little higher","good":"good height","too_fast":"slow it down","countdown":["two more","last one"]},
 "rep_target":12}

Doc: "Standing biceps curl, full range, 15 reps each arm."
{"name":"biceps curl","view":"side","rom_metric":"min",
 "primary_joint":{"name":"elbow","landmarks":["SHOULDER","ELBOW","WRIST"],"side":"both"},
 "rep_definition":{"start_angle_deg":160,"trigger_angle_deg":120,"target_angle_deg":45,"return_angle_deg":150},
 "form_rules":[{"name":"too_fast","type":"tempo","min_sec":0.8},{"name":"incomplete","type":"target_not_reached"}],
 "cues":{"go_further":"curl all the way up","good":"full curl","too_fast":"slow it down","countdown":["two more","last one"]},
 "rep_target":15}

NOW CONVERT THIS DOCUMENTATION:
"""


def _client():
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not key:
        return None
    try:
        import google.generativeai as genai
        genai.configure(api_key=key)
        return genai
    except Exception as e:
        print(f"[spec_generator] SDK configure error: {e}")
        return None


def _strip_json_fence(text: str) -> str:
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    return t.strip()


def _call_once(genai, doc: str) -> Optional[ExerciseSpec]:
    model = genai.GenerativeModel(
        GEMINI_MODEL,
        generation_config={"response_mime_type": "application/json"},
    )
    response = model.generate_content(_SYSTEM_PROMPT + doc)
    raw = _strip_json_fence(response.text or "")
    data = json.loads(raw)
    return ExerciseSpec.from_dict(data)


def generate_spec_from_docs(documentation_text: str) -> dict:
    """Generate + validate an Exercise Spec from documentation text.

    Returns {"spec": <ExerciseSpec.to_dict()>, "source": str, "error": str|None}.
    `source` is "generated" on success, else "default" (squat fallback). Never
    raises — the caller can always proceed with a usable spec.
    """
    doc = (documentation_text or "").strip()[:MAX_DOC_CHARS]
    if not doc:
        return {"spec": DEFAULT_EXERCISE.to_dict(), "source": "default",
                "error": "empty documentation"}

    genai = _client()
    if genai is None:
        return {"spec": DEFAULT_EXERCISE.to_dict(), "source": "default",
                "error": "GEMINI_API_KEY not set — using default squat spec"}

    last_err = None
    for attempt in (1, 2):                       # one retry on parse/validation failure
        try:
            spec = _call_once(genai, doc)
            return {"spec": spec.to_dict(), "source": "generated", "error": None}
        except Exception as e:
            last_err = e
            print(f"[spec_generator] attempt {attempt} failed: {e}")

    return {"spec": DEFAULT_EXERCISE.to_dict(), "source": "default",
            "error": f"could not generate a valid spec ({last_err}); using default squat spec"}


def spec_object_from_docs(documentation_text: str) -> tuple[ExerciseSpec, str, Optional[str]]:
    """Same as generate_spec_from_docs but returns a live ExerciseSpec object."""
    result = generate_spec_from_docs(documentation_text)
    try:
        spec = ExerciseSpec.from_dict(result["spec"])
    except Exception:
        spec = SQUAT_SPEC
    return spec, result["source"], result["error"]
