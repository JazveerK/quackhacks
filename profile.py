"""
PhysioFusion — PT prescription profile.

The PT uploads a free-form prescription text; `ai_agent.parse_prescription`
turns it into a `PTProfile`. The tracker holds the active profile and uses its
prescribed targets (reps, depth, tempo) to drive the live session.

`DEFAULT_PROFILE` is the hard-coded demo persona (Sam, post-ACL recovery) so
the app has a sensible story even before any prescription is uploaded.
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional


@dataclass
class PTProfile:
    """Patient + prescription. Field defaults give a clinically reasonable
    bodyweight-squat session if a parser only partially fills the structure."""

    patient_name: str = "Patient"
    condition: str = ""                # e.g. "post-ACL repair, L knee, 6 weeks"
    sets: int = 3
    reps_per_set: int = 10
    depth_deg: float = 95.0            # prescribed knee angle at bottom (deg)
    tempo_sec: float = 2.0             # minimum acceptable total rep time
    focus: str = ""                    # e.g. "controlled eccentric, posterior chain"
    contraindications: list[str] = field(default_factory=list)
    source: str = "default"            # "default" | "uploaded" | "parsed"

    # Sanity bounds. Applied on every load so a bad parse can't break the app.
    def clamp(self) -> "PTProfile":
        self.sets = max(1, min(20, int(self.sets)))
        self.reps_per_set = max(1, min(50, int(self.reps_per_set)))
        self.depth_deg = max(60.0, min(170.0, float(self.depth_deg)))
        self.tempo_sec = max(0.8, min(8.0, float(self.tempo_sec)))
        return self

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "PTProfile":
        # Accept partial dicts — fill missing keys with defaults.
        allowed = {f for f in cls.__dataclass_fields__}
        clean = {k: v for k, v in data.items() if k in allowed and v is not None}
        return cls(**clean).clamp()


# ---------------------------------------------------------------------------
# Demo persona. Loaded on startup so the dashboard has a story out of the box.
# ---------------------------------------------------------------------------
DEFAULT_PROFILE = PTProfile(
    patient_name="Sam",
    condition="post-ACL repair, left knee, 6 weeks",
    sets=3,
    reps_per_set=8,
    depth_deg=100.0,           # PT-prescribed, deeper than generic
    tempo_sec=3.0,             # slow + controlled
    focus="controlled eccentric; quad re-engagement",
    contraindications=["no valgus collapse", "no pain in L knee"],
    source="default",
).clamp()
