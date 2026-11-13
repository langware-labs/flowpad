"""Release-notes planner — no LLM. Says whether a version's notes need (re)writing.

    python3 plan.py <version> [--from <tag>] [--to <rev>] [--repo <path>]

Prints JSON: {status: fresh|stale|missing, version, from, to, path, source_hash, commits: [...]}.
``source_hash`` hashes only the commits that change what a user sees, so a rerun after
trivial commits (merges, bumps, test-only, catalogs) is ``fresh`` and nothing is rewritten.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
from pathlib import Path

RELEASES = Path("flow_sdk/system_projects/flowpad_assistant/releases")
TRIVIAL_SUBJECT = re.compile(r"^(Merge |Bump version|PR green|Simplify|Catalogs?:|Migrations: the .* moves to)", re.I)
TRIVIAL_PATH = re.compile(r"^(tests/|flow_sdk/system_projects/flowpad_assistant/releases/|ui/tests/|.*\.po$|.*/locales/|docs/)")
HASH_LINE = re.compile(r"^source_hash:\s*(\S+)", re.M)


def _git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout


def previous_tag(repo: Path, version: str, to: str) -> str:
    """The newest v* tag reachable from ``to`` that is not this version's own tag."""
    for tag in _git(repo, "tag", "--merged", to, "--sort=-v:refname", "-l", "v*").split():
        if tag != f"v{version}":
            return tag
    raise SystemExit("no previous v* tag")


def user_commits(repo: Path, frm: str, to: str) -> list[str]:
    out = _git(repo, "log", "--no-merges", "--format=%x00%s", "--name-only", f"{frm}..{to}")
    commits = []
    for block in out.split("\0")[1:]:
        head, *files = [line for line in block.splitlines() if line]
        subject = head
        if TRIVIAL_SUBJECT.match(subject) or (files and all(TRIVIAL_PATH.match(f) for f in files)):
            continue
        commits.append(subject)
    return commits


def plan(repo: Path, version: str, frm: str | None, to: str) -> dict:
    frm = frm or previous_tag(repo, version, to)
    commits = user_commits(repo, frm, to)
    source_hash = hashlib.sha256("\n".join(sorted(commits)).encode()).hexdigest()[:16]
    path = repo / RELEASES / version / "RELEASE_NOTES.md"
    status = "missing"
    if path.is_file():
        found = HASH_LINE.search(path.read_text(encoding="utf-8"))
        status = "fresh" if found and found.group(1) == source_hash else "stale"
    return {"status": status, "version": version, "from": frm, "to": to, "path": str(path),
            "source_hash": source_hash, "commits": commits}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("version")
    ap.add_argument("--from", dest="frm")
    ap.add_argument("--to", default="HEAD")
    ap.add_argument("--repo", default=".")
    ap.add_argument("--status", action="store_true", help="print only the status word")
    a = ap.parse_args()
    result = plan(Path(a.repo).resolve(), a.version, a.frm, a.to)
    print(result["status"] if a.status else json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
