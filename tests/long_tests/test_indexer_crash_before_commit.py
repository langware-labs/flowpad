"""Reproduces the index skip-fresh desync via a REAL crash — no mocks.

Root cause: the indexer stamps the non-transactional ``.hash`` sentinel
(``probe.write_hash()``) per record BEFORE the deferred ``_idx_session.commit()``
(batched every 50). If the process dies in that window, the sentinel survives on
disk while the row was never committed. On the next ordinary (non-``force``)
index, skip-fresh trusts the sentinel and never recreates the row — the record
is lost from search forever.

This drives the real fault: a real subprocess indexes a directory and is
SIGKILLed the instant the first real sentinel appears (well before the first
batch commit at 50 records), exactly as a server restart mid-index would. A
second real subprocess then runs a normal index; every source file must end up
with a committed row.

Fix (write_hash AFTER commit) → the killed run leaves no sentinel → all rows
recreated → green. Today the stranded files stay skipped → row count < N → red.
"""
from __future__ import annotations

import os
import signal
import subprocess
import sys
import time
from pathlib import Path

import pytest

# do not increase timeout without approval
pytestmark = pytest.mark.timeout(30)

WORKER = "tests.long_tests._index_crash_worker"
N_FILES = 120  # > one commit batch (50), so killing on sentinel #1 strands rows


def _spawn(db: Path, root: Path, records: Path, role: str) -> subprocess.Popen:
    env = {**os.environ, "FS_RECORD_PATH": str(records), "FLOW_INSTANCE": "test-crash"}
    return subprocess.Popen(
        [sys.executable, "-m", WORKER, str(db), str(root), role],
        env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
    )


def test_crash_before_commit_does_not_strand_records(tmp_path: Path) -> None:
    db = tmp_path / "crash.db"
    records = tmp_path / "records"
    docs = tmp_path / "proj" / "docs"
    docs.mkdir(parents=True)
    for i in range(N_FILES):
        (docs / f"d{i:03d}.md").write_text(f"# doc {i}\n", encoding="utf-8")

    # Phase 1: real index, SIGKILLed the moment the first real .hash sentinel
    # lands (before the first batch commit at 50) — a server restart mid-index.
    p = _spawn(db, tmp_path / "proj", records, "crash")
    deadline = time.time() + 20
    killed = False
    while time.time() < deadline:
        if p.poll() is not None:
            break  # finished before we could kill — retry window below handles it
        if any(records.rglob("*.hash")):
            os.kill(p.pid, signal.SIGKILL)
            killed = True
            break
        time.sleep(0.001)
    p.wait(timeout=10)
    assert killed, "never observed a sentinel to kill on (indexer too fast / layout changed)"
    assert any(records.rglob("*.hash")), "no sentinel survived the kill — repro setup wrong"

    # Phase 2: ordinary (non-force) index in a fresh process. Every source file
    # must now have a committed row.
    v = _spawn(db, tmp_path / "proj", records, "verify")
    out, _ = v.communicate(timeout=20)
    line = next((l for l in out.splitlines() if l.startswith("MARKDOWN_ROWS=")), None)
    assert line is not None, f"verify worker produced no count:\n{out}"
    rows = int(line.split("=", 1)[1])
    assert rows == N_FILES, (
        f"{N_FILES - rows} record(s) stranded: a fresh sentinel survived the crash "
        f"with no committed row, and skip-fresh skipped re-creating it (got {rows})"
    )
