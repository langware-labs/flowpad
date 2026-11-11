"""Release notes: the deploy rewrites a version's notes only when a user-visible commit changed."""

import importlib.util
import subprocess
from pathlib import Path

from flow_sdk.server.routes import version as version_route

_spec = importlib.util.spec_from_file_location(
    "release_notes_plan", Path(__file__).parents[2] / ".claude/skills/release-notes/scripts/plan.py"
)
plan_mod = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(plan_mod)


def _commit(repo: Path, rel: str, subject: str) -> None:
    (repo / rel).parent.mkdir(parents=True, exist_ok=True)
    (repo / rel).write_text(subject)
    subprocess.run(["git", "-C", str(repo), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", subject], check=True)


def _repo(tmp_path: Path) -> Path:
    subprocess.run(["git", "init", "-q", str(tmp_path)], check=True)
    for k, v in (("user.email", "t@t"), ("user.name", "t")):
        subprocess.run(["git", "-C", str(tmp_path), "config", k, v], check=True)
    _commit(tmp_path, "a.py", "start")
    subprocess.run(["git", "-C", str(tmp_path), "tag", "v1.0.0"], check=True)
    _commit(tmp_path, "a.py", "StreamInbox: channels move to the top row")
    return tmp_path


def _write_notes(repo: Path, result: dict) -> None:
    path = Path(result["path"])
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\nsource_hash: {result['source_hash']}\n---\n# notes\n")


def test_missing_then_fresh_then_stale_only_on_a_user_visible_commit(tmp_path):
    repo = _repo(tmp_path)
    first = plan_mod.plan(repo, "1.0.1", None, "HEAD")
    assert (first["status"], first["from"], first["commits"]) == ("missing", "v1.0.0", ["StreamInbox: channels move to the top row"])
    _write_notes(repo, first)

    _commit(repo, "tests/unit/test_a.py", "a test")
    _commit(repo, "b.py", "Bump version to 1.0.1")
    _commit(repo, "c.py", "PR green: lint")
    assert plan_mod.plan(repo, "1.0.1", None, "HEAD")["status"] == "fresh"

    _commit(repo, "d.py", "Toasts: Clear all")
    assert plan_mod.plan(repo, "1.0.1", None, "HEAD")["status"] == "stale"


def test_version_route_lists_shipped_notes_newest_first(tmp_path, monkeypatch):
    for v in ("0.2.9", "0.2.263", "0.2.26", "not-a-version"):
        (tmp_path / "releases" / v).mkdir(parents=True)
        (tmp_path / "releases" / v / "RELEASE_NOTES.md").write_text("# n")
    (tmp_path / "releases" / "0.2.100").mkdir()  # no notes file: not listed
    monkeypatch.setattr("flow_sdk.config.flowpad_assistant_project_root", lambda: tmp_path)
    assert [n.version for n in version_route._release_notes()] == ["0.2.263", "0.2.26", "0.2.9"]
