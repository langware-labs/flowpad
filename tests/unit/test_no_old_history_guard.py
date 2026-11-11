"""The retired-history guard: the list is well-formed, fails on a match, and never prints the id."""
from __future__ import annotations

import hashlib
import re
import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(30)  # do not increase without approval

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "check_no_old_history.py"
HASHES = REPO / ".github" / "old-history.sha256"


def _git(cwd: Path, *args: str) -> str:
    return subprocess.run(
        ["git", *args], cwd=cwd, capture_output=True, text=True, check=True, timeout=20
    ).stdout.strip()


def _run(repo: Path, hashes: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(SCRIPT), "--repo", str(repo), "--hashes", str(hashes)],
        capture_output=True, text=True, timeout=20,
    )


@pytest.fixture()
def tiny_repo(tmp_path: Path) -> Path:
    _git(tmp_path, "init", "-q")
    _git(tmp_path, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "x")
    return tmp_path


def test_the_list_is_only_sha256_fingerprints() -> None:
    lines = [ln.strip() for ln in HASHES.read_text(encoding="utf-8").splitlines() if ln.strip()]
    assert lines, "the list is empty"
    assert all(re.fullmatch(r"[0-9a-f]{64}", ln) for ln in lines), "only 64-hex fingerprints belong in this file"


def test_a_retired_commit_fails_and_its_id_is_never_printed(tiny_repo: Path, tmp_path: Path) -> None:
    sha = _git(tiny_repo, "rev-parse", "HEAD")
    listed = tmp_path / "list.txt"
    listed.write_text(hashlib.sha256(sha.encode()).hexdigest() + "\n", encoding="utf-8")
    done = _run(tiny_repo, listed)
    assert done.returncode == 1
    assert sha not in done.stdout + done.stderr


def test_a_clean_history_passes(tiny_repo: Path, tmp_path: Path) -> None:
    listed = tmp_path / "list.txt"
    listed.write_text(hashlib.sha256(b"not-a-commit").hexdigest() + "\n", encoding="utf-8")
    assert _run(tiny_repo, listed).returncode == 0


def test_this_checkout_passes_the_real_list() -> None:
    if not (REPO / ".git").exists():
        pytest.skip("not a git checkout")
    done = _run(REPO, HASHES)
    assert done.returncode == 0, done.stderr
