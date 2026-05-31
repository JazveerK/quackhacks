"""
PhysioFusion — FHIR R4 Observation builder for 30-second Sit-to-Stand.

Builds a clinician-legible, interop-ready Observation dict from a session
summary. Applies a measurement quality gate (tracking confidence >= 0.80)
and handles out-of-range ages gracefully.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from sts_norms import interpret_sts

QUALITY_THRESHOLD = 0.80


def _component(code: str, display: str, value, unit: str | None = None, system: str = "urn:physiofusion:metrics") -> dict:
    """Build a single FHIR Observation.component entry."""
    comp: dict = {
        "code": {
            "coding": [{"system": system, "code": code, "display": display}],
            "text": display,
        },
    }
    if isinstance(value, bool):
        comp["valueBoolean"] = value
    elif isinstance(value, (int, float)) and unit:
        comp["valueQuantity"] = {"value": value, "unit": unit}
    elif isinstance(value, str):
        comp["valueString"] = value
    elif isinstance(value, (int, float)):
        comp["valueQuantity"] = {"value": value}
    else:
        comp["valueString"] = str(value)
    return comp


def build_sts_observation(session: dict) -> dict:
    """
    Build a FHIR R4 Observation for a 30-second Sit-to-Stand session.

    Expected keys in `session`:
      session_id, patient_ref, effective_dt, issued_dt, reps, age, sex,
      uses_arm_support, tracking_source, tracking_confidence_mean,
      calibration_id, mean_concentric_s, mean_eccentric_s,
      peak_knee_flexion_deg, rom_delta_vs_baseline_deg, pain_nprs,
      adherence_completed, adherence_prescribed, clinical_flags

    Returns a FHIR Observation dict.
    Raises ValueError for age < 60 (caller should catch and handle).
    """
    reps = int(session["reps"])
    age = int(session["age"])
    sex: str = session["sex"]
    confidence = float(session["tracking_confidence_mean"])
    uses_arm = bool(session.get("uses_arm_support", False))

    # ── Quality gate ──────────────────────────────────────────────
    low_quality = confidence < QUALITY_THRESHOLD

    # ── LOINC code selection ──────────────────────────────────────
    if uses_arm:
        loinc_code = "93125-3"
        loinc_display = "30-second Chair Stand Test — with arm support"
    else:
        loinc_code = "66247-8"
        loinc_display = "30-second Chair Stand Test"

    # ── Normative interpretation ──────────────────────────────────
    # interpret_sts raises ValueError for age < 60 — let it propagate
    # so the caller (server.py) can catch and handle it.
    # For age > 94, interpret_sts clamps to 90-94 with a note.
    interp = None
    age_out_of_range = False
    age_note = None
    if age < 60:
        raise ValueError(f"Age {age} is below the validated range (60-94).")
    interp = interpret_sts(reps, age, sex)

    # ── Status ────────────────────────────────────────────────────
    if low_quality:
        status = "preliminary"
    else:
        status = "final"

    # ── Build the Observation ─────────────────────────────────────
    obs: dict = {
        "resourceType": "Observation",
        "id": session["session_id"],
        "meta": {
            "tag": [
                {
                    "system": "urn:physiofusion:tags",
                    "code": "patient-administered-remote-assessment",
                    "display": "Patient-administered remote assessment",
                }
            ],
        },
        "status": status,
        "category": [
            {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/observation-category",
                        "code": "exam",
                        "display": "Exam",
                    }
                ]
            }
        ],
        "code": {
            "coding": [
                {
                    "system": "http://loinc.org",
                    "code": loinc_code,
                    "display": loinc_display,
                }
            ],
            "text": loinc_display,
        },
        "subject": {"reference": session["patient_ref"]},
        "effectiveDateTime": session["effective_dt"],
        "issued": session["issued_dt"],
        "valueQuantity": {
            "value": reps,
            "unit": "reps",
            "system": "http://unitsofmeasure.org",
            "code": "{count}",
        },
        "note": [
            {
                "text": (
                    "This observation is a measurement from a patient-administered "
                    "remote assessment using PhysioFusion. It is observational data "
                    "intended for clinician review and is NOT a clinical diagnosis. "
                    "Interpretation codes (L/N/H) represent normative comparisons "
                    "against validated reference ranges, not diagnostic conclusions."
                ),
            }
        ],
        "component": [],
    }

    # ── Interpretation + reference range (only if norms available and quality ok) ──
    if interp and not low_quality:
        obs["interpretation"] = [
            {
                "coding": [
                    {
                        "system": "http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation",
                        "code": interp["fhir_interpretation_code"],
                        "display": {
                            "L": "Low",
                            "N": "Normal",
                            "H": "High",
                        }[interp["fhir_interpretation_code"]],
                    }
                ],
                "text": interp["summary"],
            }
        ]
        low_val, high_val = interp["average_range"]
        sex_label = sex.capitalize()
        obs["referenceRange"] = [
            {
                "low": {"value": low_val, "unit": "reps"},
                "high": {"value": high_val, "unit": "reps"},
                "text": f"Average range for {sex_label}, age {interp['age_band']}, community-dwelling",
                "appliesTo": [
                    {
                        "text": f"{sex_label}, age {interp['age_band']}, community-dwelling",
                    }
                ],
            }
        ]
        if interp["fall_risk_flag"]:
            obs["note"].append(
                {
                    "text": (
                        "SCREENING SIGNAL: Score is below the CDC STEADI fall-risk "
                        "threshold for this age/sex cohort. This is a screening signal "
                        "for clinician review, not a clinical conclusion."
                    ),
                }
            )

    # ── Low quality note ──────────────────────────────────────────
    if low_quality:
        obs["note"].append(
            {
                "text": (
                    f"Tracking confidence ({confidence:.2f}) is below the quality "
                    f"threshold ({QUALITY_THRESHOLD}). This observation has status "
                    f"'preliminary' and should not be used for clinical decision-making."
                ),
            }
        )
        obs["dataAbsentReason"] = {
            "coding": [
                {
                    "system": "http://terminology.hl7.org/CodeSystem/data-absent-reason",
                    "code": "temp-unknown",
                    "display": "Temporarily Unknown",
                }
            ],
            "text": "Tracking quality below threshold; measurement not reliable.",
        }

    # ── Components: provenance + clinical flags ───────────────────
    components = obs["component"]

    components.append(_component("tracking-source", "Tracking source", session["tracking_source"]))
    components.append(_component("tracking-confidence", "Tracking confidence (mean)", confidence))
    components.append(_component(
        "quality-gate",
        "Quality gate result",
        "pass" if not low_quality else "fail",
    ))
    components.append(_component("calibration-id", "Calibration ID", session["calibration_id"]))
    components.append(_component(
        "mean-concentric-s", "Mean concentric duration",
        round(float(session["mean_concentric_s"]), 2), "s",
    ))
    components.append(_component(
        "mean-eccentric-s", "Mean eccentric duration",
        round(float(session["mean_eccentric_s"]), 2), "s",
    ))

    ecc = float(session["mean_eccentric_s"])
    con = float(session["mean_concentric_s"])
    ratio = round(ecc / con, 2) if con > 0 else 0.0
    components.append(_component("tempo-asymmetry", "Tempo asymmetry (ecc/con ratio)", ratio))

    components.append(_component(
        "peak-knee-flexion-deg", "Peak knee flexion",
        round(float(session["peak_knee_flexion_deg"]), 1), "deg",
    ))
    components.append(_component(
        "rom-delta-vs-baseline-deg", "ROM delta vs baseline",
        round(float(session["rom_delta_vs_baseline_deg"]), 1), "deg",
    ))

    pain = session.get("pain_nprs")
    if pain is not None:
        components.append(_component("pain-nprs", "Pain (NPRS 0-10)", int(pain)))
    else:
        components.append(_component("pain-nprs", "Pain (NPRS 0-10)", "not reported"))

    adherence_str = f"{session['adherence_completed']}/{session['adherence_prescribed']}"
    components.append(_component("adherence", "Adherence (completed/prescribed)", adherence_str))

    flags = session.get("clinical_flags") or {}
    components.append(_component(
        "flag-rom-regression", "Clinical flag: ROM regression",
        bool(flags.get("rom_regression", False)),
    ))
    components.append(_component(
        "flag-tempo-guarding", "Clinical flag: Tempo guarding",
        bool(flags.get("tempo_guarding", False)),
    ))
    components.append(_component(
        "flag-progression-stalled", "Clinical flag: Progression stalled",
        bool(flags.get("progression_stalled", False)),
    ))

    return obs
