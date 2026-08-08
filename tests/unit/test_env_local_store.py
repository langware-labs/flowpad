"""Read-only primitives over a project's ``.env.local``.

Two contracts are pinned here, both load-bearing for the secrets UI:

* ``list_env_local`` reports **key names and line numbers only**. A value must
  never appear in what it returns — the detected-keys table renders straight
  from this, so a leak here is a leak to the browser.
* ``gitignore_status`` **asks git** instead of line-matching ``.gitignore``, and
  never mutates anything. The negation case below is precisely what a
  line-match gets backwards.
"""

import subprocess

import pytest

from flow_sdk.builtin.env_local_store import (
    GITIGNORE_GIT_FAILURE,
    GITIGNORE_IGNORED,
    GITIGNORE_NO_DIR,
    GITIGNORE_NOT_A_REPO,
    GITIGNORE_NOT_IGNORED,
    GITIGNORE_TRACKED,
    EnvLocalNotWritable,
    ensure_gitignored,
    env_local_block,
    env_local_path,
    gitignore_status,
    list_env_local,
    write_env_local,
)
from flow_sdk.builtin.project import Project


def _project(tmp_path):
    """A Project pointed at ``tmp_path``. Never saved — these are pure reads."""
    project = Project(name=str(tmp_path / "env-local-proj"))
    project.fs_storage_mount_path = str(tmp_path)
    return project


def _git(tmp_path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=str(tmp_path), capture_output=True, text=True, timeout=10)


def _init_repo(tmp_path) -> None:
    _git(tmp_path, "init", "-q")


# ── list_env_local ────────────────────────────────────────────────────────────


def test_list_env_local_parses_keys_with_line_numbers(tmp_path):
    (tmp_path / ".env.local").write_text(
        "\n".join(
            [
                "# a comment",
                "",
                "OPENAI_API_KEY=sk-plain-value",
                "  ",
                "export STRIPE_KEY=sk_live_abc",
                "# STRIPE_KEY=commented-out-should-not-count",
                "DATABASE_URL='postgres://u:p@h/db?a=1&b=2'",
                "not an assignment line",
            ]
        ),
        encoding="utf-8",
    )

    rows = list_env_local(_project(tmp_path))

    assert [r["key"] for r in rows] == ["OPENAI_API_KEY", "STRIPE_KEY", "DATABASE_URL"]
    assert [r["line"] for r in rows] == [3, 5, 7]


def test_list_env_local_never_returns_a_value(tmp_path):
    (tmp_path / ".env.local").write_text("OPENAI_API_KEY=sk-super-secret\n", encoding="utf-8")

    blob = repr(list_env_local(_project(tmp_path)))

    assert "OPENAI_API_KEY" in blob
    assert "sk-super-secret" not in blob


def test_list_env_local_duplicate_key_reports_the_effective_line(tmp_path):
    """dotenv resolves last-wins, so the reported line must be the last one."""
    (tmp_path / ".env.local").write_text(
        "TOKEN=first\nOTHER=x\nTOKEN=second\n",
        encoding="utf-8",
    )

    rows = list_env_local(_project(tmp_path))

    assert [(r["key"], r["line"]) for r in rows] == [("OTHER", 2), ("TOKEN", 3)]


def test_list_env_local_empty_when_no_file_or_no_mount(tmp_path):
    assert list_env_local(_project(tmp_path)) == []

    unmounted = Project(name="no-mount")
    unmounted.fs_storage_mount_path = ""
    assert list_env_local(unmounted) == []
    assert env_local_path(unmounted) is None


def test_env_local_path_points_at_the_file_even_when_absent(tmp_path):
    path = env_local_path(_project(tmp_path))

    assert path == tmp_path / ".env.local"
    assert not path.exists()


# ── gitignore_status ──────────────────────────────────────────────────────────


def test_gitignore_status_outside_a_repo_is_not_blocked(tmp_path):
    """No git history means there is nothing for a value to leak into."""
    status = gitignore_status(_project(tmp_path))

    assert status["in_repo"] is False
    assert status["ignored"] is True
    assert status["code"] == GITIGNORE_NOT_A_REPO


def test_gitignore_status_no_project_dir(tmp_path):
    project = Project(name="no-mount")
    project.fs_storage_mount_path = str(tmp_path / "does-not-exist")

    status = gitignore_status(project)

    assert status["code"] == GITIGNORE_NO_DIR
    assert status["ignored"] is True


def test_gitignore_status_repo_without_gitignore_is_not_ignored(tmp_path):
    _init_repo(tmp_path)

    status = gitignore_status(_project(tmp_path))

    assert status["in_repo"] is True
    assert status["ignored"] is False
    assert status["code"] == GITIGNORE_NOT_IGNORED


def test_gitignore_status_exact_line(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text(".env.local\n", encoding="utf-8")

    status = gitignore_status(_project(tmp_path))

    assert status["ignored"] is True
    assert status["code"] == GITIGNORE_IGNORED


def test_gitignore_status_wildcard_pattern_counts(tmp_path):
    """``*.local`` already covers the file — a line-match would miss this."""
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text("*.local\n", encoding="utf-8")

    assert gitignore_status(_project(tmp_path))["ignored"] is True


def test_gitignore_status_negation_re_includes_the_file(tmp_path):
    """The case an exact-line match gets BACKWARDS: the line is present, but a
    later ``!`` rule re-includes the file, so it is committable."""
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text(".env.local\n!.env.local\n", encoding="utf-8")

    status = gitignore_status(_project(tmp_path))

    assert status["ignored"] is False
    assert status["code"] == GITIGNORE_NOT_IGNORED


def test_gitignore_status_mutates_nothing(tmp_path):
    _init_repo(tmp_path)
    gitignore = tmp_path / ".gitignore"
    gitignore.write_text("node_modules\n", encoding="utf-8")
    before = gitignore.read_bytes()

    status = gitignore_status(_project(tmp_path))

    assert status["ignored"] is False
    assert gitignore.read_bytes() == before, "gitignore_status must never write"
    assert not (tmp_path / ".env.local").exists()


def test_gitignore_status_reports_git_failure_without_raising(tmp_path, monkeypatch):
    """A broken git must surface as a code, not an exception — the caller uses
    this to decide whether to hard-block, and a crash there is worse than a
    conservative 'not ignored'."""
    _init_repo(tmp_path)

    from flow_sdk.utils.git_folder import GitFolder

    original = GitFolder.git_sync

    def _boom(self, *args, **kwargs):
        if "check-ignore" in args:
            raise OSError("git exploded")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(GitFolder, "git_sync", _boom)

    status = gitignore_status(_project(tmp_path))

    assert status["code"] == GITIGNORE_GIT_FAILURE
    assert status["ignored"] is False


def test_delete_helper_does_not_exist():
    """Flowpad never removes a key from a user's .env.local. Structural, not a
    convention — there is no function to call."""
    import flow_sdk.builtin.env_local_store as store

    assert not hasattr(store, "delete_env_local")


@pytest.mark.parametrize("marker", [".env.local"])
def test_env_local_filename_is_the_only_file_we_look_at(tmp_path, marker):
    """Scope guard: `.env` and friends are deliberately out of scope for now."""
    (tmp_path / ".env").write_text("SHOULD_NOT_APPEAR=1\n", encoding="utf-8")
    (tmp_path / marker).write_text("REAL_KEY=2\n", encoding="utf-8")

    assert [r["key"] for r in list_env_local(_project(tmp_path))] == ["REAL_KEY"]


# ── the hard block ────────────────────────────────────────────────────────────


def test_ensure_gitignored_appends_and_verifies(tmp_path):
    _init_repo(tmp_path)

    # Returns the VERIFIED status, not a bool — callers need the code to explain
    # a refusal without re-probing.
    assert ensure_gitignored(_project(tmp_path))["ignored"] is True
    assert ".env.local" in (tmp_path / ".gitignore").read_text()


def test_ensure_gitignored_overrides_an_earlier_negation(tmp_path):
    """A `!` rule re-includes the file, but our appended line comes after it and
    git's last matching rule wins — so this IS fixable. The verify step is what
    tells us so, rather than us assuming either way."""
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text("*.local\n!.env.local\n", encoding="utf-8")

    assert ensure_gitignored(_project(tmp_path))["ignored"] is True


def test_a_tracked_env_local_is_blocked_however_gitignore_reads(tmp_path):
    """The case a gitignore-only check calls safe when it is not: git ignore
    rules do not apply to files it already tracks, so a tracked .env.local keeps
    being committed no matter what the ignore file says."""
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text(".env.local\n", encoding="utf-8")
    (tmp_path / ".env.local").write_text("TOKEN=already-committed\n", encoding="utf-8")
    _git(tmp_path, "add", "-f", ".env.local")

    status = gitignore_status(_project(tmp_path))
    assert status["tracked"] is True
    assert status["ignored"] is False
    assert status["code"] == GITIGNORE_TRACKED

    with pytest.raises(EnvLocalNotWritable) as excinfo:
        write_env_local(_project(tmp_path), "NEW_TOKEN", "sk-must-not-land")
    assert excinfo.value.code == GITIGNORE_TRACKED
    assert "sk-must-not-land" not in (tmp_path / ".env.local").read_text()


def test_write_env_local_refuses_when_not_excluded(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text(".env.local\n!.env.local\n", encoding="utf-8")

    with pytest.raises(EnvLocalNotWritable) as excinfo:
        write_env_local(_project(tmp_path), "TOKEN", "sk-should-never-land")

    assert excinfo.value.code == GITIGNORE_NOT_IGNORED
    assert not (tmp_path / ".env.local").exists(), "the file must not even be created"


def test_write_env_local_succeeds_once_excluded(tmp_path):
    _init_repo(tmp_path)
    project = _project(tmp_path)

    write_env_local(project, "TOKEN", "sk-fine")

    assert "TOKEN" in (tmp_path / ".env.local").read_text()
    assert ".env.local" in (tmp_path / ".gitignore").read_text()


def test_write_env_local_outside_a_repo_is_allowed(tmp_path):
    """No git history means no way to leak — same call ensure_gitignored made
    before this change."""
    write_env_local(_project(tmp_path), "TOKEN", "sk-fine")

    assert "TOKEN" in (tmp_path / ".env.local").read_text()


def test_env_local_block_is_none_when_writable(tmp_path):
    _init_repo(tmp_path)
    (tmp_path / ".gitignore").write_text(".env.local\n", encoding="utf-8")

    assert env_local_block(gitignore_status(_project(tmp_path))) is None


def test_env_local_block_reports_a_code(tmp_path):
    _init_repo(tmp_path)

    block = env_local_block(gitignore_status(_project(tmp_path)))

    assert block is not None
    assert block["code"] == GITIGNORE_NOT_IGNORED
    assert "NOT excluded" in block["reason"]
