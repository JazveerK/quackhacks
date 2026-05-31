"""
PhysioFusion — 30-second Sit-to-Stand normative interpretation.

Reference: Rikli & Jones (1999), Jones & Rikli (2002).
Aligned with CDC STEADI fall-risk screening thresholds.

Pure function, no I/O. Validated norm bands — do NOT re-derive.
"""

from __future__ import annotations
from typing import Literal

# ── Age-stratified norms (Rikli & Jones 1999) ─────────────────────────
# Format: (low_average, high_average)
# Below low = below_average; above high = above_average.
NORMS: dict[str, dict[str, tuple[int, int]]] = {
    "female": {
        "60-64": (12, 17),
        "65-69": (11, 16),
        "70-74": (10, 15),
        "75-79": (10, 15),
        "80-84": (9, 14),
        "85-89": (8, 13),
        "90-94": (4, 11),
    },
    "male": {
        "60-64": (14, 19),
        "65-69": (12, 18),
        "70-74": (12, 17),
        "75-79": (11, 17),
        "80-84": (10, 15),
        "85-89": (8, 14),
        "90-94": (7, 12),
    },
}

# CDC STEADI: below-average on 30s STS is a fall-risk indicator.
# We flag when score < low end of average range.

AGE_BANDS = ["60-64", "65-69", "70-74", "75-79", "80-84", "85-89", "90-94"]


def _age_band(age: int) -> str:
    """Map an integer age to the 5-year band string."""
    if age < 60:
        raise ValueError(f"Age {age} is below the validated range (60-94).")
    if age > 94:
        # Clamp to 90-94 with a note rather than raising.
        return "90-94"
    for band in AGE_BANDS:
        lo, hi = (int(x) for x in band.split("-"))
        if lo <= age <= hi:
            return band
    return "90-94"  # fallback


class StsInterpretation(dict):
    """Dict-like result so callers can use dot access or subscript."""
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError:
            raise AttributeError(key)


def interpret_sts(
    reps: int,
    age: int,
    sex: Literal["male", "female"],
) -> StsInterpretation:
    """
    Interpret a 30-second Sit-to-Stand score against age- and sex-normed
    reference ranges.

    Returns a dict with:
      score, age_band, average_range, band, fall_risk_flag,
      fhir_interpretation_code, summary, reference, notes
    """
    if sex not in ("male", "female"):
        raise ValueError(f"sex must be 'male' or 'female', got {sex!r}")

    notes: list[str] = []
    band_str = _age_band(age)  # raises for age < 60

    if age > 94:
        notes.append(
            "Age exceeds validated range (60-94); clamped to 90-94 band. "
            "Interpret with caution."
        )

    avg_range = NORMS[sex][band_str]
    low, high = avg_range

    if reps < low:
        band = "below_average"
        fhir_code = "L"
        fall_risk = True
    elif reps > high:
        band = "above_average"
        fhir_code = "H"
        fall_risk = False
    else:
        band = "average"
        fhir_code = "N"
        fall_risk = False

    sex_label = sex.capitalize()
    cohort = f"{sex_label}, age {band_str}, community-dwelling"
    summary = (
        f"{reps} reps in 30 s is {band.replace('_', ' ')} for "
        f"{cohort.lower()} (reference {low}-{high})."
    )
    if fall_risk:
        summary += " This is below the CDC STEADI threshold and may indicate elevated fall risk."

    return StsInterpretation(
        score=reps,
        age_band=band_str,
        average_range=(low, high),
        band=band,
        fall_risk_flag=fall_risk,
        fhir_interpretation_code=fhir_code,
        summary=summary,
        reference="Rikli RE, Jones CJ. J Aging Phys Act. 1999;7:129-161. CDC STEADI.",
        notes=notes,
    )
