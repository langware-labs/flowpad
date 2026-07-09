"""Unit tests for GitRepo per-file revision history — real git, real parsing.

Drives the Stage-3 ``GitRepo`` methods (``get_file_revisions`` / ``restore_file`` /
``compare_file_revision``) against a real temp git repo. The compute-node seam is
a thin adapter that runs the assembled git command locally — the git output and the
log/version parsing under test are entirely real.
"""

import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.faas.git_repo import GitRepo
from flow_sdk.schema.type_info import register_all


class _LocalNode:
    """Runs ``GitRepo``'s assembled shell command locally (real git)."""

    async def run_command(self, command: str, background: bool = False):
        r = subprocess.run(command, shell=True, capture_output=True, text=True)
        return SimpleNamespace(all_stdout=r.stdout, all_stderr=r.stderr, exit_code=r.returncode)


def _git(args, cwd):
    subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)


def _write_commit(repo: Path, body: str, version: int):
    (repo / "SKILL.md").write_text(
        f"---\nname: slick\nversion: {version}\n---\n\n# slick\n\n{body}\n", encoding="utf-8"
    )
    _git(["add", "-A"], repo)
    _git(["commit", "-m", f"Flowpad: slick v{version}"], repo)


def _init_repo(repo: Path):
    _git(["init"], repo)
    _git(["config", "user.email", "t@t.test"], repo)
    _git(["config", "user.name", "t"], repo)


@pytest.fixture
def repo(tmp_path) -> Path:
    _init_repo(tmp_path)
    _write_commit(tmp_path, "Body one.", 1)
    _write_commit(tmp_path, "Body two.", 2)
    _write_commit(tmp_path, "Body three.", 3)
    return tmp_path


async def test_file_revisions_parsed_newest_first_with_version(repo: Path):
    gr = GitRepo(str(repo), _LocalNode())
    result = await gr.get_file_revisions("SKILL.md")

    assert len(result.revisions) == 3
    versions = [r.version for r in result.revisions]
    assert versions == [3, 2, 1]  # newest first
    assert result.version == 3  # current HEAD version
    newest = result.revisions[0]
    assert newest.hash and len(newest.hash) >= 7
    assert "v3" in newest.message
    assert newest.author == "t"
    assert newest.date  # ISO timestamp present


async def test_restore_file_checks_out_past_revision(repo: Path):
    gr = GitRepo(str(repo), _LocalNode())
    revs = await gr.get_file_revisions("SKILL.md")
    v1_hash = next(r.hash for r in revs.revisions if r.version == 1)

    res = await gr.restore_file("SKILL.md", v1_hash)
    assert res.ok is True

    # Working tree now holds the v1 content.
    content = (repo / "SKILL.md").read_text()
    assert "Body one." in content
    assert "version: 1" in content


async def test_compare_file_revision_returns_diff(repo: Path):
    gr = GitRepo(str(repo), _LocalNode())
    revs = await gr.get_file_revisions("SKILL.md")
    v1_hash = next(r.hash for r in revs.revisions if r.version == 1)

    diff = await gr.compare_file_revision("SKILL.md", v1_hash)
    assert "Body one." in diff.diff  # removed line from v1
    assert "Body three." in diff.diff  # current line
    assert "SKILL.md" in diff.diff


async def test_asset_diff_folder_backed_scopes_to_asset_folder(tmp_path: Path):
    register_all()
    _init_repo(tmp_path)
    skill = tmp_path / ".claude" / "skills" / "slick"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text("# slick\n\nBody one.\n", encoding="utf-8")
    _git(["add", "-A"], tmp_path)
    _git(["commit", "-m", "Flowpad: slick v1"], tmp_path)

    (skill / "SKILL.md").write_text("# slick\n\nBody two.\n", encoding="utf-8")
    (skill / "helper.txt").write_text("new helper\n", encoding="utf-8")
    (tmp_path / "outside.txt").write_text("outside\n", encoding="utf-8")

    result = await GitRepo(str(skill), _LocalNode()).get_asset_diff("SKILL.md")

    assert {f.path for f in result.files} == {"SKILL.md", "helper.txt"}
    assert "SKILL.md" in result.diff
    assert "helper.txt" in result.diff
    assert "outside.txt" not in result.diff


async def test_working_file_stays_inside_workdir(repo: Path):
    secret = repo.parent / f"{repo.name}-secret.txt"
    secret.write_text("do not leak\n", encoding="utf-8")
    gr = GitRepo(str(repo), _LocalNode())

    assert "Body three." in (await gr.get_working_file("SKILL.md")).content
    assert (await gr.get_working_file("../secret.txt")).content == ""
    assert (await gr.get_working_file(str(secret))).content == ""
