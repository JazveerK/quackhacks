"""
DEPRECATED shim. The exercise abstraction now lives in `exercise_spec.py`
(the richer, LLM-generatable Exercise Spec). This module re-exports the common
names so any older import keeps working. New code should import from
`exercise_spec` directly.
"""

from __future__ import annotations

from exercise_spec import (  # noqa: F401
    ExerciseSpec,
    SQUAT_SPEC,
    SQUAT_SPEC as SQUAT,
    PUSHUP_SPEC,
    LATERAL_ARM_RAISE_SPEC,
    REGISTRY,
    DEFAULT_EXERCISE,
    get,
    options,
)
