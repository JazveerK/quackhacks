# Feature: Clinician Handoff with FHIR Observations

> Build spec for Claude Code. Implements the "Share with my PT" feature for real,
> replacing the demo mock. Adapt all file paths to the actual repo layout — names
> below are intent, not gospel.

## 1. Purpose

Today PhysioFusion measures a patient's sit-to-stand performance between clinic
visits but has no trustworthy way to get that data to their physical therapist.
The previous "Share with my PT" button was a mocked toast.

This feature turns each session into a **clinician-legible artifact**: a single
30-second Sit-to-Stand result, classified against validated age- and sex-normed
reference ranges, carrying full measurement provenance, emitted as a **FHIR R4
Observation** so it can drop into any EHR. A read-only handoff page renders it for
the PT.

The point is clinician *trust*: validated assessment + per-measurement provenance
+ a standard interop format (FHIR/LOINC), with explicit non-diagnostic framing.

## 2. Scope

**In scope**
- A norms/interpretation module (already built — see §4.1).
- A FHIR Observation builder (§4.2).
- A data-contract extension: intake captures age + sex; per-set summary carries
  mean tracking confidence; session summary stores the Observation (§3).
- A read-only clinician handoff route + view (§5).
- A measurement quality gate that suppresses low-confidence data (§6).

**Out of scope (for now)**
- Real EHR write-back / SMART on FHIR launch (mock the "Route to EHR" button).
- Auth on the handoff link (treat the link as if signed; no login for demo).
- Pushing to a GCP Healthcare API FHIR store (architecture should allow it later — §8).
- Any exercise other than squat / sit-to-stand.

## 3. Data contract changes

Lock these first so the existing workstreams stay in sync.

### 3.1 Intake / user context (NEW fields)
```json
{
  "age": 72,
  "sex_at_birth": "female"   // "male" | "female" — required for sex-stratified norms
}
```
Label `sex_at_birth` in the UI as "biological sex at birth (used for age-normed
reference ranges)" so it reads as clinical, not as a gender prompt. If only a
birthdate is available, derive age at session time.

### 3.2 Per-set summary (NEW field)
```json
{
  "tracking_confidence_mean": 0.92   // mean of per-frame fusion confidence across the set, 0-1
}
```
The fusion layer already produces per-frame confidence; just average it per set.

### 3.3 Session summary (NEW field)
```json
{
  "sts_observation": { /* FHIR Observation dict, generated at session end */ }
}
```

### 3.4 BigQuery
Add a column to the `sessions` table:
- `sts_observation` — type `JSON` (or `STRING` holding serialized JSON if JSON type
  is unavailable in the project).

No backfill needed; only new sessions populate it.

## 4. New modules

### 4.1 `sts_norms.py` — ALREADY BUILT, use as-is
Drop the provided `sts_norms.py` into the analytics/Workstream-C package. Public API:

```python
interpret_sts(reps: int, age: int, sex: Literal["male","female"]) -> StsInterpretation
```

Returns a dict with: `score`, `age_band`, `average_range` (tuple), `band`
("below_average" | "average" | "above_average"), `fall_risk_flag` (bool),
`fhir_interpretation_code` ("L" | "N" | "H"), `summary` (str), `reference` (str),
`notes` (list). Norms are Rikli & Jones 1999 (CDC STEADI). Pure function, no I/O.

Do NOT re-derive the norm bands — they are validated values in the module.

### 4.2 `fhir_observation.py` — BUILD THIS
A small builder that maps a session summary onto a FHIR R4 Observation dict.

```python
from sts_norms import interpret_sts

QUALITY_THRESHOLD = 0.80  # mean tracking confidence below this -> data suppressed

def build_sts_observation(session: dict) -> dict:
    """
    Build a FHIR R4 Observation for a 30-second Sit-to-Stand session.

    Expected keys in `session`:
      session_id: str
      patient_ref: str                 # e.g. "Patient/abc" (de-identified for demo)
      effective_dt: str                # ISO-8601, when the test was performed
      issued_dt: str                   # ISO-8601, when the record was generated
      reps: int
      age: int
      sex: "male" | "female"
      uses_arm_support: bool           # True -> LOINC 93125-3, else 66247-8
      tracking_source: str             # e.g. "fused"
      tracking_confidence_mean: float  # 0-1
      calibration_id: str
      mean_concentric_s: float
      mean_eccentric_s: float
      peak_knee_flexion_deg: float
      rom_delta_vs_baseline_deg: float
      pain_nprs: int | None
      adherence_completed: int
      adherence_prescribed: int
      clinical_flags: dict             # {rom_regression, tempo_guarding, progression_stalled}

    Returns a FHIR Observation dict. Raises ValueError on out-of-range age (handled
    upstream — see §6 quality gate for the suppression path).
    """
```

Implementation notes:
- LOINC code: `93125-3` if `uses_arm_support` else `66247-8`.
- `interpretation[0].coding[0].code` = `interp["fhir_interpretation_code"]`.
- `referenceRange[0]` low/high from `interp["average_range"]`; `appliesTo[0].text`
  describes the cohort (e.g. "Female, age 70-74, community-dwelling").
- Map every provenance + flag field into the `component[]` array (one entry each):
  tracking source, tracking confidence, quality gate result, calibration id,
  concentric/eccentric durations, tempo asymmetry (ecc/con ratio), peak knee
  flexion, ROM delta vs baseline, pain NPRS, adherence string, and each clinical flag.
- `meta.tag` = `patient-administered-remote-assessment`.
- `note[0].text` must state the data is observational, non-diagnostic, and intended
  for clinician review.

**Use `sts_fhir_observation.json` (the provided sample) as the exact target shape.**
The builder's output for the sample patient (reps=9, age=72, female) should match it
field-for-field.

Add a round-trip test: build from a fixture session dict, then assert the JSON
parses and key fields equal expected values.

## 5. Clinician handoff route + view

### 5.1 Route (NEW)
`GET /share/<session_id>` — read-only, no auth (demo). Reads the session's
`sts_observation` from BigQuery and renders the handoff view. Return 404 if the
session has no Observation (e.g. suppressed by the quality gate — show a friendly
"insufficient tracking quality for this session" state instead of a broken page).

### 5.2 View (NEW)
Render the Observation two ways on one page:
1. **Human-readable clinical view** (default): the assessment card (score, band,
   reference range visualization, fall-risk indicator), a "patterns to discuss"
   list driven by the clinical flags, and a measurement-quality panel.
2. **Raw FHIR view**: the Observation JSON, toggled by a "View as FHIR Observation"
   control. This is the demo money-moment — keep it one tap away.

The approved UI mockup for this view was prototyped in the design chat
(`physiofusion_view_b_clinician_handoff_v1`). Match its layout: header strip,
patient strip, STS assessment card with the norm-range bar, two-column
(patterns | quality) row, action buttons, FHIR payload block. Keep the
non-diagnostic reference line visible in the assessment card.

Buttons "What would a PT do with this?" and "Route to EHR (mock)" are demo affordances —
the EHR one shows a mocked SMART-on-FHIR launch screen; do not build a real launch.

## 6. Measurement quality gate (NON-NEGOTIABLE)

A clinician must never receive a number the system isn't confident in.

- If `tracking_confidence_mean < QUALITY_THRESHOLD` (0.80), do NOT build a normal
  Observation. Either skip emitting the Observation for that session, or emit one
  with `status: "preliminary"` and a `dataAbsentReason`-style note that the session
  did not meet the tracking-quality bar. The handoff view must clearly show
  "insufficient tracking quality — not reported" rather than a low number that
  looks real.
- If `age` is outside 60-94, still report the raw rep count but omit the norm
  classification and fall-risk flag (norms are not validated there). `interpret_sts`
  raises for age < 60 and clamps for > 94 with a note — handle both: catch the
  raise and emit an Observation without `interpretation`/`referenceRange`.

## 7. Guardrails (NON-NEGOTIABLE)

These mirror the existing Gemini coaching guardrails — apply them here too.
- Never diagnose. The Observation is a **measurement**; `interpretation` codes
  ("L"/"N"/"H") are normative comparisons, not diagnoses.
- The fall-risk flag is a **screening signal** aligned with CDC STEADI, surfaced
  for clinician review — never phrased as a clinical conclusion.
- Every handoff artifact carries the non-diagnostic note (§4.2).
- No PHI claims beyond what the patient entered; de-identify for the demo.

## 8. Integration points (existing code to touch)

```
intake form / user_context        -> add age + sex_at_birth (§3.1)
fusion layer (per-frame conf)      -> already emits confidence; no change
per-set aggregator                 -> add tracking_confidence_mean (§3.2)
session-end handler                -> call build_sts_observation(); apply quality
                                      gate; write sts_observation to BigQuery (§3.3, §6)
BigQuery sessions schema           -> add sts_observation column (§3.4)
router                             -> add GET /share/<session_id> (§5.1)
frontend                           -> add clinician handoff view (§5.2)
"Share with my PT" button          -> point at /share/<session_id> instead of toast
```

End-to-end flow:
```
session_end
  -> aggregate_sts_session(session)            # existing aggregate + new conf mean
  -> quality gate check                         # §6
  -> build_sts_observation(session)             # §4.2
  -> BigQuery.sessions.sts_observation = obs    # §3.4
  -> "Share with my PT" links to /share/<id>
  -> GET /share/<id> -> read obs -> render view # §5
  -> (future) POST obs to GCP Healthcare FHIR store
```

## 9. Acceptance criteria

- [ ] `from sts_norms import interpret_sts` works; module unchanged.
- [ ] `build_sts_observation(fixture)` for (reps=9, age=72, female) produces JSON
      that parses and matches `sts_fhir_observation.json` on: `code.coding[0].code`
      == "66247-8", `valueQuantity.value` == 9, `interpretation[0].coding[0].code`
      == "L", `referenceRange[0].low.value` == 10, `.high.value` == 15.
- [ ] Intake captures age + sex_at_birth; session summary persists `sts_observation`.
- [ ] BigQuery `sessions` table has the `sts_observation` column and new rows populate it.
- [ ] `GET /share/<session_id>` renders the human-readable view and exposes the raw
      FHIR payload via a toggle.
- [ ] A session with `tracking_confidence_mean` 0.6 does NOT surface a normal score;
      the view shows the insufficient-quality state.
- [ ] An age-outside-60-94 session reports the rep count without norm classification.
- [ ] Non-diagnostic note present on every emitted Observation and visible in the view.

## 10. Demo notes (for the team, not for Claude Code to build)

- The handoff view is the pitch's money screen — budget demo time for it.
- Sequence: finish session -> tap "Share with my PT" -> handoff view -> toggle
  "View as FHIR" for two seconds -> "this drops into Epic, Cerner, WebPT."
- Have the three trust sentences ready: validated assessment (STS / CDC STEADI),
  per-measurement provenance (confidence + quality gate), FHIR/LOINC interop.

## Reference files (provided)
- `sts_norms.py` — the validated norms + `interpret_sts()`. Use as-is.
- `sts_fhir_observation.json` — the exact target shape for the builder output.
