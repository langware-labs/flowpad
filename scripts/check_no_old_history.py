#!/usr/bin/env python3
"""Fail when the checked-out history contains a retired commit.

``.github/old-history.sha256`` holds one-way fingerprints (SHA-256) of commit ids that must never
be pushed again: a branch cut from a clone that predates the history clean-up carries them as
ancestors. Only fingerprints are stored. A commit id is an address (a host can serve any commit by
id, and follows parent links), so the ids themselves must not appear here, and a failure prints
COUNTS only, never the matching ids.

    python scripts/check_no_old_history.py [--repo DIR] [--hashes FILE]
"""
from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
from pathlib import Path

DEFAULT_HASHES = Path(__file__).resolve().parents[1] / ".github" / "old-history.sha256"

MESSAGE = (
    "This branch contains commits from a retired history ({n} of {total}).\n"
    "Do not push or merge it. Create a fresh branch from origin/release/v0.2 and cherry-pick\n"
    "only your own commits (git cherry-pick), or apply your changes as a patch."
)


def load_hashes(path: Path) -> set[str]:
    lines = (ln.strip() for ln in path.read_text(encoding="utf-8").splitlines())
    return {ln for ln in lines if ln and not ln.startswith("#")}


def commits(repo: Path) -> list[str]:
    out = subprocess.run(
        ["git", "-C", str(repo), "rev-list", "HEAD"], capture_output=True, text=True, check=True, timeout=60
    )
    return out.stdout.split()


def retired_count(shas: list[str], hashes: set[str]) -> int:
    return sum(hashlib.sha256(s.encode()).hexdigest() in hashes for s in shas)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--repo", type=Path, default=Path.cwd())
    parser.add_argument("--hashes", type=Path, default=DEFAULT_HASHES)
    args = parser.parse_args(argv)
    shas = commits(args.repo)
    found = retired_count(shas, load_hashes(args.hashes))
    if found:
        print(MESSAGE.format(n=found, total=len(shas)), file=sys.stderr)
        return 1
    print(f"ok: {len(shas)} commits checked, none retired")
    return 0


if __name__ == "__main__":
    sys.exit(main())
