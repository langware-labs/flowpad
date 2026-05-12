"""Headless agent process runner for stress-matrix cells.

Runs INSIDE the docker container. Bootstraps a minimal flow_sdk SQLite DB
at ``/work/.stress_db.sqlite``, creates the @local user/project/compute_node,
saves an ``AgenticProcess(visible=False)``, invokes ``prompt()``, and waits
for the turn to complete via ``stream_transcript``.

Writes ``/work/_runner_complete.json`` with the turn outcome.

Exit codes:
  0  — turn completed cleanly: session_id captured, transcript entries seen.
  1  — turn ran but no session_id / no transcript entries.
  2  — uncaught exception (traceback on stderr).
  64 — usage error.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback
from pathlib import Path


SENTINEL_NAME = "_runner_complete.json"


async def _drive(prompt: str, workdir: str) -> dict:
    # Deferred imports so a flow_sdk load failure surfaces as exit code 2
    # with a traceback rather than a silent import-time crash.
    from flow_sdk.builtin.agentic_process import AgenticProcess
    from flow_sdk.db.database import init_db
    from flow_sdk.server.routes.bootstrap import (
        get_or_create_local_compute_node,
        get_or_create_local_project,
        get_or_create_local_user,
    )

    await init_db()

    user = await get_or_create_local_user()
    project = await get_or_create_local_project(desktop_user=user)
    cn = await get_or_create_local_compute_node(
        local_project=project,
        desktop_user=user,
    )

    ap = AgenticProcess(
        compute_node_id=f"compute_node-{cn.id}",
        cli_config={"permission_mode": "bypassPermissions"},
        workdir=workdir,
        visible=False,
    )
    # Stress cells can opt out of the pre-save to exercise the
    # exist_in_db gate at agentic_process.py:1088 (B1 / "no AP record").
    if os.environ.get("STRESS_NO_AP_SAVE") != "1":
        await ap.save([])

    response = await ap.prompt(prompt)
    response_status = (
        response.data.get("status")
        if hasattr(response, "data") and isinstance(response.data, dict)
        else repr(response)[:200]
    )

    # Wait briefly for Claude to actually write its first transcript line
    # (the ``system:init`` event). The driver pre-assigns ``ap.session_id``
    # before spawning, so session_id alone is NOT a reliable "claude
    # started" signal — we need to see bytes on disk.
    for _ in range(50):  # 5.0s in 100ms ticks
        tp = ap.driver.transcript_path(ap)
        if tp and tp.exists() and tp.stat().st_size > 0:
            break
        await asyncio.sleep(0.1)

    tp = ap.driver.transcript_path(ap)
    if not tp or not tp.exists() or tp.stat().st_size == 0:
        return {
            "n_entries": 0,
            "session_id": None,
            "last_text": "",
            "ap_id": ap.id,
            "response_status": response_status,
            "transcript_error": "no_transcript_within_5s",
        }

    n_entries = 0
    last_text = ""
    transcript_error: str | None = None
    try:
        async for entry in ap.stream_transcript(timeout=15):
            n_entries += 1
            if not isinstance(entry, dict):
                continue
            msg = entry.get("message")
            if isinstance(msg, dict):
                content = msg.get("content")
                if isinstance(content, list) and content:
                    last_block = content[-1] if isinstance(content[-1], dict) else None
                    if last_block:
                        text = last_block.get("text")
                        if text:
                            last_text = str(text)[:200]
    except Exception as e:
        transcript_error = f"{type(e).__name__}: {e}"
        print(f"stream_transcript: {transcript_error}", file=sys.stderr)

    return {
        "n_entries": n_entries,
        "session_id": ap.session_id,
        "last_text": last_text,
        "ap_id": ap.id,
        "response_status": response_status,
        "transcript_error": transcript_error,
    }


def main() -> int:
    if len(sys.argv) < 3:
        print(
            "RUNNER_BLOCKED: usage: runner_entrypoint.py <workdir> <prompt>",
            file=sys.stderr,
        )
        return 64

    workdir = sys.argv[1]
    prompt = sys.argv[2]

    # DB inside /work so cells can corrupt it via the bind mount.
    db_path = Path(workdir) / ".stress_db.sqlite"
    os.environ["SQLITE_DATABASE_PATH"] = str(db_path)

    def _stat(tag: str) -> None:
        if db_path.exists():
            st = db_path.stat()
            print(
                f"DB_STAT[{tag}]: path={db_path} size={st.st_size} "
                f"mode={oct(st.st_mode)} uid={st.st_uid}",
                file=sys.stderr,
            )
        else:
            print(f"DB_STAT[{tag}]: path={db_path} MISSING", file=sys.stderr)

    _stat("pre")

    sentinel_path = Path(workdir) / SENTINEL_NAME

    try:
        outcome = asyncio.run(_drive(prompt, workdir))
    except Exception as exc:
        # Surface a clean RUNNER_BLOCKED line instead of a raw traceback.
        # Known-class errors (sqlite/sqlalchemy OperationalError, OSError)
        # have specific shapes we tag so cells can recognise them. We
        # still dump the traceback to a sidecar file inside /work for
        # post-mortem inspection without polluting stderr.
        cls = type(exc).__name__
        msg = str(exc).splitlines()[0] if str(exc) else cls
        is_db_busy = (
            "OperationalError" in cls
            or "disk I/O error" in msg
            or "database is locked" in msg
        )
        tag = "DB_BUSY" if is_db_busy else cls.upper()
        print(f"RUNNER_BLOCKED: {tag}: {msg[:200]}", file=sys.stderr)
        try:
            (Path(workdir) / "_runner_traceback.txt").write_text(
                traceback.format_exc()
            )
        except Exception:
            pass
        try:
            sentinel_path.write_text(
                json.dumps({"error": cls, "message": msg[:500], "tag": tag})
            )
        except Exception:
            pass
        _stat("post")
        return 2

    sentinel_path.write_text(json.dumps(outcome))
    # Always echo the outcome to stderr so cells can diagnose without
    # needing to fish the sentinel out of a torn-down tmpdir.
    print(f"RUNNER_OUTCOME: {json.dumps(outcome)}", file=sys.stderr)
    _stat("post")

    if outcome["n_entries"] == 0 or not outcome["session_id"]:
        print(
            f"RUNNER_BLOCKED: no_session "
            f"(entries={outcome['n_entries']}, sid={outcome['session_id']}, "
            f"transcript_error={outcome['transcript_error']})",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
