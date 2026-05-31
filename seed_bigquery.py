"""
seed_bigquery.py — DEMO SEED DATA for SteadyPT / PhysioFusion.

Populates the BigQuery `physiofusion` dataset with a few weeks of realistic
fake history for a demo patient so the clinician trend view (View B) has
something compelling to show at the booth.

The story it tells (knee angle in degrees — LOWER = deeper squat = better ROM):
  - range of motion improves week over week,
  - adherence is good...
  - ...except one "slacking week" where the patient did fewer sets and regressed.

This is DEMO SEED DATA ONLY — clearly marked, not real patient data.

Idempotent: every seeded row uses a deterministic session_id prefixed with
"seed-". Re-running first DELETEs all rows with that prefix, then re-loads via
a load job, so running it twice leaves the same clean dataset. It never touches
real sessions captured live (those use uuid session_ids).

Schema note: this script writes the ACTUAL live table schemas (verified against
the dataset), not the simplified CONTEXT.md §4e schema:
    sets(session_id, set_index, reps, avg_depth_deg, min_depth_deg,
         fatigue_score, debrief_text, recommended_next, created_at TIMESTAMP)
    sessions(session_id, user_id, exercise, started_at TIMESTAMP,
             ended_at TIMESTAMP, sets_count, total_reps, avg_depth,
             adherence_flag BOOLEAN)

Usage:
    .venv/bin/python seed_bigquery.py                 # seed "demo-patient"
    .venv/bin/python seed_bigquery.py --user someone   # seed another user_id
    .venv/bin/python seed_bigquery.py --clear-only     # just remove seed rows

Auth: ADC (gcloud auth application-default login) or
GOOGLE_APPLICATION_CREDENTIALS. Dataset from PF_BQ_DATASET (default
physiofusion). No service-account JSON is committed.
"""
from __future__ import annotations

import argparse
import os
from datetime import datetime, timedelta, timezone

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

from google.cloud import bigquery

DATASET = os.environ.get("PF_BQ_DATASET", "physiofusion")
SETS_TABLE = "sets"
SESSIONS_TABLE = "sessions"
SEED_PREFIX = "seed-"
DEFAULT_USER = "demo-patient"
EXERCISE = "bodyweight_squat"
PRESCRIBED_SETS = 3

# Per-week plan, oldest first. avg/min depth in degrees of knee angle:
# LOWER = deeper squat = better range of motion. The trend improves over time
# with a deliberate regression + missed work in the "slacking week".
WEEKS = [
    # weeks_ago, set avg depths, set min depths, reps per set, adherence
    {"weeks_ago": 6, "avgs": [114, 116, 119], "mins": [106, 108, 111], "reps": [8, 8, 7], "adherence": True},
    {"weeks_ago": 5, "avgs": [107, 109, 112], "mins": [99, 101, 104], "reps": [8, 8, 8], "adherence": True},
    {"weeks_ago": 4, "avgs": [100, 102, 105], "mins": [92, 94, 97], "reps": [8, 8, 8], "adherence": True},
    # slacking week: only 2 sets, fewer reps, ROM regressed, incomplete.
    {"weeks_ago": 3, "avgs": [106, 110], "mins": [98, 103], "reps": [6, 5], "adherence": False},
    {"weeks_ago": 2, "avgs": [95, 96, 99], "mins": [87, 89, 92], "reps": [8, 8, 8], "adherence": True},
    {"weeks_ago": 1, "avgs": [89, 90, 93], "mins": [82, 84, 87], "reps": [8, 9, 8], "adherence": True},
]


def _fatigue_score(set_idx: int, n_sets: int) -> float:
    """Crude fatigue heuristic: later sets in a session are more fatigued."""
    if n_sets <= 1:
        return 0.0
    return round(set_idx / (n_sets - 1) * 0.6, 2)


def _recommend(avg_depth: float, target: float = 90.0) -> str:
    if avg_depth > target + 15:
        return "slow descent; pause at bottom"
    if avg_depth <= target:
        return "hold prescription; add 1 rep"
    return "focus depth; controlled eccentric"


def build_rows(user_id: str, now: datetime):
    """Return (sessions_rows, sets_rows) as JSON-serializable dicts."""
    sessions_rows, sets_rows = [], []
    for wk_i, wk in enumerate(WEEKS):
        started = (now - timedelta(weeks=wk["weeks_ago"])).replace(
            hour=9, minute=0, second=0, microsecond=0
        )
        session_id = f"{SEED_PREFIX}{user_id}-{wk_i:02d}"
        avgs, mins, reps_plan = wk["avgs"], wk["mins"], wk["reps"]
        n_sets = len(avgs)

        total_reps = 0
        for set_i in range(n_sets):
            reps = reps_plan[set_i]
            total_reps += reps
            avg_depth = float(avgs[set_i])
            min_depth = float(mins[set_i])
            created = started + timedelta(minutes=3 * (set_i + 1))
            sets_rows.append({
                "session_id": session_id,
                "set_index": set_i + 1,
                "reps": reps,
                "avg_depth_deg": round(avg_depth, 1),
                "min_depth_deg": round(min_depth, 1),
                "fatigue_score": _fatigue_score(set_i, n_sets),
                "debrief_text": (
                    f"[demo seed] Set {set_i + 1}: {reps} reps at ~{avg_depth:.0f}deg "
                    f"average depth, deepest {min_depth:.0f}deg."
                ),
                "recommended_next": _recommend(avg_depth),
                "created_at": created.isoformat(),
            })

        ended = started + timedelta(minutes=3 * (n_sets + 1))
        sessions_rows.append({
            "session_id": session_id,
            "user_id": user_id,
            "exercise": EXERCISE,
            "started_at": started.isoformat(),
            "ended_at": ended.isoformat(),
            "sets_count": n_sets,
            "total_reps": total_reps,
            "avg_depth": round(sum(avgs) / len(avgs), 1),
            # BOOLEAN column: completed all prescribed sets without slacking.
            "adherence_flag": bool(wk["adherence"] and n_sets >= PRESCRIBED_SETS),
        })
    return sessions_rows, sets_rows


def _delete_existing(client: bigquery.Client, project: str, user_id: str) -> None:
    """Remove prior seed rows for this user so re-running is idempotent."""
    for table in (SETS_TABLE, SESSIONS_TABLE):
        fq = f"{project}.{DATASET}.{table}"
        sql = f"DELETE FROM `{fq}` WHERE session_id LIKE @prefix"
        cfg = bigquery.QueryJobConfig(query_parameters=[
            bigquery.ScalarQueryParameter("prefix", "STRING", f"{SEED_PREFIX}{user_id}-%"),
        ])
        try:
            client.query(sql, job_config=cfg).result()
            print(f"  cleared prior seed rows from {table}")
        except Exception as e:
            # Rows still in the streaming buffer can't be DML-deleted; harmless
            # for a load-job seed run ahead of the demo.
            print(f"  warn: could not clear {table}: {e.__class__.__name__}: {e}")


def _load(client: bigquery.Client, project: str, table: str, rows: list) -> None:
    """Load rows via a load job (managed storage, no streaming buffer) so the
    rows are immediately queryable AND DML-deletable on the next run."""
    if not rows:
        return
    fq = f"{project}.{DATASET}.{table}"
    job_config = bigquery.LoadJobConfig(
        source_format=bigquery.SourceFormat.NEWLINE_DELIMITED_JSON,
        write_disposition=bigquery.WriteDisposition.WRITE_APPEND,
    )
    client.load_table_from_json(rows, fq, job_config=job_config).result()
    print(f"  loaded {len(rows)} rows into {table}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Seed demo history into BigQuery.")
    parser.add_argument("--user", default=DEFAULT_USER, help="user_id to seed")
    parser.add_argument("--clear-only", action="store_true",
                        help="only remove existing seed rows, then exit")
    args = parser.parse_args()

    client = bigquery.Client()
    project = client.project
    print(f"DEMO SEED -> {project}.{DATASET} (user '{args.user}')")

    _delete_existing(client, project, args.user)
    if args.clear_only:
        print("Cleared. (--clear-only)")
        return

    now = datetime.now(timezone.utc)
    sessions_rows, sets_rows = build_rows(args.user, now)
    _load(client, project, SESSIONS_TABLE, sessions_rows)
    _load(client, project, SETS_TABLE, sets_rows)
    print(f"Done: {len(sessions_rows)} sessions, {len(sets_rows)} sets "
          f"(idempotent — safe to re-run).")


if __name__ == "__main__":
    main()
