"""
Round-trip test for the FHIR Observation builder.

Run: python -m tests.test_fhir_observation
"""
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import json
from fhir_observation import build_sts_observation, QUALITY_THRESHOLD

# ── Fixture: the acceptance criteria case (reps=9, age=72, female) ───
FIXTURE_SESSION = {
    "session_id": "test-session-001",
    "patient_ref": "Patient/demo-user",
    "effective_dt": "2026-05-30T10:00:00+00:00",
    "issued_dt": "2026-05-30T10:05:00+00:00",
    "reps": 9,
    "age": 72,
    "sex": "female",
    "uses_arm_support": False,
    "tracking_source": "fused",
    "tracking_confidence_mean": 0.92,
    "calibration_id": "cal-test-001",
    "mean_concentric_s": 1.2,
    "mean_eccentric_s": 1.8,
    "peak_knee_flexion_deg": 88.5,
    "rom_delta_vs_baseline_deg": 3.0,
    "pain_nprs": None,
    "adherence_completed": 3,
    "adherence_prescribed": 3,
    "clinical_flags": {
        "rom_regression": False,
        "tempo_guarding": False,
        "progression_stalled": False,
    },
}


def test_acceptance_criteria():
    """§9 acceptance: reps=9, age=72, female → LOINC 66247-8, value=9, interp=L, ref 10-15."""
    obs = build_sts_observation(FIXTURE_SESSION)

    # Parses as valid JSON
    json_str = json.dumps(obs)
    parsed = json.loads(json_str)
    assert parsed["resourceType"] == "Observation"

    # LOINC code
    assert obs["code"]["coding"][0]["code"] == "66247-8"

    # Value
    assert obs["valueQuantity"]["value"] == 9

    # Interpretation = L (below average for female 70-74)
    assert obs["interpretation"][0]["coding"][0]["code"] == "L"

    # Reference range
    assert obs["referenceRange"][0]["low"]["value"] == 10
    assert obs["referenceRange"][0]["high"]["value"] == 15

    # Status = final (confidence > threshold)
    assert obs["status"] == "final"

    # Non-diagnostic note present
    assert any("NOT a clinical diagnosis" in n["text"] for n in obs["note"])

    # Fall-risk note present (score 9 < low 10)
    assert any("fall-risk" in n["text"].lower() for n in obs["note"])

    print("  PASS: acceptance criteria (reps=9, age=72, female)")


def test_low_quality_suppression():
    """§6: confidence < 0.80 → status=preliminary, no interpretation."""
    session = {**FIXTURE_SESSION, "tracking_confidence_mean": 0.60}
    obs = build_sts_observation(session)

    assert obs["status"] == "preliminary"
    assert "interpretation" not in obs
    assert "referenceRange" not in obs
    assert "dataAbsentReason" in obs
    assert any("quality" in n["text"].lower() for n in obs["note"])

    print("  PASS: low quality suppression (confidence=0.60)")


def test_age_outside_range():
    """§6: age < 60 → raw rep count without norm classification."""
    session = {**FIXTURE_SESSION, "age": 55}
    try:
        obs = build_sts_observation(session)
        # Should not reach here — age < 60 raises ValueError
        assert False, "Expected ValueError for age < 60"
    except ValueError:
        pass

    print("  PASS: age below 60 raises ValueError")


def test_age_above_94():
    """§6: age > 94 → clamped to 90-94 with a note."""
    session = {**FIXTURE_SESSION, "age": 98}
    obs = build_sts_observation(session)

    # Should still have interpretation (clamped band)
    assert "interpretation" in obs
    # Should have a note about clamping
    interp_text = obs["interpretation"][0].get("text", "")
    assert "90-94" in interp_text or any("caution" in n["text"].lower() for n in obs.get("note", []))

    print("  PASS: age above 94 clamped with note")


def test_arm_support_loinc():
    """uses_arm_support=True → LOINC 93125-3."""
    session = {**FIXTURE_SESSION, "uses_arm_support": True}
    obs = build_sts_observation(session)
    assert obs["code"]["coding"][0]["code"] == "93125-3"

    print("  PASS: arm support LOINC code (93125-3)")


def test_components_present():
    """All provenance + flag components present."""
    obs = build_sts_observation(FIXTURE_SESSION)
    codes = [c["code"]["coding"][0]["code"] for c in obs["component"]]

    expected = [
        "tracking-source", "tracking-confidence", "quality-gate",
        "calibration-id", "mean-concentric-s", "mean-eccentric-s",
        "tempo-asymmetry", "peak-knee-flexion-deg",
        "rom-delta-vs-baseline-deg", "pain-nprs", "adherence",
        "flag-rom-regression", "flag-tempo-guarding", "flag-progression-stalled",
    ]
    for exp in expected:
        assert exp in codes, f"Missing component: {exp}"

    print("  PASS: all components present")


def test_meta_tag():
    """meta.tag = patient-administered-remote-assessment."""
    obs = build_sts_observation(FIXTURE_SESSION)
    tags = [t["code"] for t in obs["meta"]["tag"]]
    assert "patient-administered-remote-assessment" in tags

    print("  PASS: meta tag present")


if __name__ == "__main__":
    print("Running FHIR Observation builder tests...\n")
    test_acceptance_criteria()
    test_low_quality_suppression()
    test_age_outside_range()
    test_age_above_94()
    test_arm_support_loinc()
    test_components_present()
    test_meta_tag()
    print("\nAll tests passed.")
