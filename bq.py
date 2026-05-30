"""
PhysioFusion — BigQuery persistence (Google track #2).

Writes per-set rows on set end and per-session rows on session end. Reads
back for the PT progress view.

Auth: uses Application Default Credentials. On the laptop, run once:

    gcloud auth application-default login

Then `bigquery.Client()` finds the project automatically. In Cloud Shell
auth is already there.

All functions FAIL CLOSED: if BigQuery isn't configured (no credentials,
no project, no permissions, table doesn't exist), they log a one-line
warning and return False / []. Nothing on the live demo path can crash
because of storage problems. Live state stays in memory; BigQuery is for
cross-session history only (per CONTEXT.md §3, §8).

Streaming-insert note: a row you JUST wrote may not be queryable for a
few seconds. Trends are fine; don't expect read-your-writes.
"""

from __future__ import annotations

import os
from datetime import datetime, timezone
from typing import Optional

DATASET = os.environ.get("PF_BQ_DATASET", "physiofusion")
SETS_TABLE_NAME = "sets"
SESSIONS_TABLE_NAME = "sessions"

_client = None
_init_attempted = False


# ---------------------------------------------------------------------------
# Client init.
# ---------------------------------------------------------------------------
def init_client():
    """Return a configured google.cloud.bigquery.Client, or None.

    First call attempts to create the client; subsequent calls memoize the
    result (including None) so we don't repeatedly retry a missing auth.
    """
    global _client, _init_attempted
    if _init_attempted:
        return _client
    _init_attempted = True
    try:
        from google.cloud import bigquery
        _client = bigquery.Client()
        # Touch .project to validate ADC actually picked something.
        _ = _client.project
        return _client
    except Exception as e:
        print(f"[bq] init_client unavailable: {e.__class__.__name__}: {e}")
        _client = None
        return None


def is_available() -> bool:
    return init_client() is not None


def _sets_table() -> Optional[str]:
    c = init_client()
    return f"{c.project}.{DATASET}.{SETS_TABLE_NAME}" if c else None


def _sessions_table() -> Optional[str]:
    c = init_client()
    return f"{c.project}.{DATASET}.{SESSIONS_TABLE_NAME}" if c else None


# ---------------------------------------------------------------------------
# Per-set summary helpers (derive scalar columns from the rich 4d summary).
# ---------------------------------------------------------------------------
def _fatigue_score(summary: dict) -> float:
    sig = (summary.get("fatigue_signal") or "none").lower()
    return {
        "none": 0.0,
        "depth_decline": 0.5,
        "tempo_decline": 0.5,
        "both": 1.0,
    }.get(sig, 0.0)


def _next_recommendation(summary: dict) -> str:
    """One-line "what to change next set" derived from the analysis.

    We don't try to parse the prose `ai_debrief`; we synthesize a stable
    short string from the structured numbers so the PT view can sort/filter.
    """
    analysis = summary.get("analysis", {}) or {}
    depth_trend = (analysis.get("depth") or {}).get("trend", "consistent")
    tempo_trend = (analysis.get("tempo") or {}).get("trend", "consistent")
    hit_rate = (analysis.get("depth") or {}).get("target_hit_rate", 1.0)
    if depth_trend == "declining_late":
        return "drop 2 reps; focus depth"
    if tempo_trend == "slowing_down":
        return "drop tempo target; same reps"
    if hit_rate < 0.7:
        return "slow descent; pause at bottom"
    return "hold prescription; add 1 rep"


# ---------------------------------------------------------------------------
# Inserts.
# ---------------------------------------------------------------------------
def insert_set(session_id: str, set_index: int, summary: dict) -> bool:
    """Write one row to the `sets` table.

    Schema matches CONTEXT.md §4e:
        sets(session_id, set_index, reps, avg_depth_deg, min_depth_deg,
             fatigue_score, debrief_text, recommended_next)
    """
    table = _sets_table()
    if table is None:
        return False
    depths = summary.get("rep_depths_deg") or []
    avg_depth = round(sum(depths) / len(depths), 2) if depths else 0.0
    min_depth = float(min(depths)) if depths else 0.0
    # Prefer the AI debrief if it's already in the summary; otherwise the
    # always-on templated text.
    debrief_text = summary.get("ai_debrief") or summary.get("templated_debrief") or ""
    row = {
        "session_id": session_id,
        "set_index": int(set_index),
        "reps": int(summary.get("reps_completed", 0)),
        "avg_depth_deg": float(avg_depth),
        "min_depth_deg": min_depth,
        "fatigue_score": _fatigue_score(summary),
        "debrief_text": debrief_text[:1024],
        "recommended_next": _next_recommendation(summary)[:256],
    }
    try:
        client = init_client()
        errors = client.insert_rows_json(table, [row])
        if errors:
            print(f"[bq] insert_set row errors: {errors}")
            return False
        return True
    except Exception as e:
        print(f"[bq] insert_set exception: {e.__class__.__name__}: {e}")
        return False


def insert_session(
    session_id: str,
    user_id: str,
    started_at: datetime,
    sets_count: int,
    total_reps: int,
    avg_depth: float,
    adherence_flag: str,
) -> bool:
    """Write one row to the `sessions` table.

    Schema matches CONTEXT.md §4e:
        sessions(session_id, user_id, exercise, started_at, sets_count,
                 total_reps, avg_depth, adherence_flag)
    """
    table = _sessions_table()
    if table is None:
        return False
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    row = {
        "session_id": session_id,
        "user_id": user_id,
        "exercise": "bodyweight_squat",
        "started_at": started_at.isoformat(),
        "sets_count": int(sets_count),
        "total_reps": int(total_reps),
        "avg_depth": float(round(avg_depth, 2)),
        "adherence_flag": adherence_flag[:64],
    }
    try:
        client = init_client()
        errors = client.insert_rows_json(table, [row])
        if errors:
            print(f"[bq] insert_session row errors: {errors}")
            return False
        return True
    except Exception as e:
        print(f"[bq] insert_session exception: {e.__class__.__name__}: {e}")
        return False


# ---------------------------------------------------------------------------
# Reads (PT view).
# ---------------------------------------------------------------------------
def query_session_sets(session_id: str) -> list[dict]:
    """All sets belonging to a session, ordered by set_index."""
    table = _sets_table()
    if table is None:
        return []
    try:
        from google.cloud import bigquery
        client = init_client()
        job_config = bigquery.QueryJobConfig(
            query_parameters=[
                bigquery.ScalarQueryParameter("sid", "STRING", session_id),
            ]
        )
        rows = client.query(
            f"SELECT * FROM `{table}` WHERE session_id = @sid ORDER BY set_index",
            job_config=job_config,
        ).result()
        return [dict(r) for r in rows]
    except Exception as e:
        print(f"[bq] query_session_sets exception: {e.__class__.__name__}: {e}")
        return []


def query_recent_sets(limit: int = 50) -> list[dict]:
    """Most recent N sets across sessions, latest first. Powers the PT trend view."""
    table = _sets_table()
    if table is None:
        return []
    try:
        client = init_client()
        rows = client.query(
            f"SELECT session_id, set_index, reps, avg_depth_deg, min_depth_deg, "
            f"fatigue_score, debrief_text, recommended_next "
            f"FROM `{table}` ORDER BY session_id DESC, set_index DESC "
            f"LIMIT {int(limit)}"
        ).result()
        return [dict(r) for r in rows]
    except Exception as e:
        print(f"[bq] query_recent_sets exception: {e.__class__.__name__}: {e}")
        return []
