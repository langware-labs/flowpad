"""Repro: server restart resets the per-session seq counter while the stream
file persists — two overlapping seq epochs poison the replay dedup contract.

The frontend dedups buffered live WS chunks against the replayed stream by
seq (``chunk.seq <= replay.lastSeq`` → skip). That contract requires output
seqs to be MONOTONIC within one stream file. On server restart, shell
recovery respawns the PTY into the SAME ``<pty_pid>.pty`` file, but
``PtyState`` (in-memory) restarts its counter at 1 — so post-restart
chunks carry seqs below the file's max and get wrongly skipped: the attach
repaint never lands and the terminal looks dead ("PTY disconnect" after
server restart).

Fix under test: a freshly-wired PtyStreamFile exposes ``max_seq`` so the
spawn path can resume the session counter past the persisted epoch.
"""

from pathlib import Path

from flow_sdk.compute.providers.desktop.pty_stream_file import PtyStreamFile


def _frames_max_seq(frames: dict) -> int:
    return max((e[2] for e in frames["events"] if e[0] == "o" and len(e) > 2), default=0)


def test_restart_epoch_collision_reproduced_and_fixed(tmp_path: Path):
    path = tmp_path / "session.pty"

    # ── Epoch A: original server process writes seqs 1..5 ──
    f1 = PtyStreamFile(path, cols=100, rows=30)
    for seq in range(1, 6):
        f1.write(f"epoch-A-{seq}".encode(), seq)

    # ── Server restart: recovery respawns the PTY → NEW PtyStreamFile over
    # the SAME path; the in-memory session counter would restart at 1. ──
    f2 = PtyStreamFile(path, cols=100, rows=30)

    # THE BUG (without the fix): epoch B writes seq 1, 2, ... which collide
    # below epoch A's max — frontend dedup (seq <= lastSeq) drops them all.
    # THE FIX: the spawn path resumes the counter from the persisted max.
    resume_from = f2.max_seq()
    assert resume_from == 5, "max_seq() must surface the persisted epoch's high-water mark"

    for i in range(1, 4):
        f2.write(f"epoch-B-{i}".encode(), resume_from + i)

    frames = f2.read_frames()
    seqs = [e[2] for e in frames["events"] if e[0] == "o"]
    # Monotonic across the restart — the dedup contract holds.
    assert seqs == sorted(seqs) == [1, 2, 3, 4, 5, 6, 7, 8]
    assert _frames_max_seq(frames) == 8


def test_max_seq_empty_and_legacy(tmp_path: Path):
    # No file yet → 0 (fresh session starts at 1)
    assert PtyStreamFile(tmp_path / "missing.pty").max_seq() == 0
    # Legacy raw file (no frames/seqs) → 0
    legacy = tmp_path / "legacy.pty"
    legacy.write_bytes(b"raw legacy bytes")
    assert PtyStreamFile(legacy).max_seq() == 0
