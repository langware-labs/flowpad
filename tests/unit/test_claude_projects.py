"""Unit tests for flow_sdk.fs_store.indexer.functions._claude_projects.

Tests cover:
- _real_path_from_jsonl: reads 'cwd' from a session JSONL file
- iter_claude_project_paths: yields real paths, deduplicates, handles hyphens
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.fs_store.indexer.functions._claude_projects import (
    _real_path_from_jsonl,
    iter_claude_project_paths,
)
from flow_sdk.fs_store.path_utils import is_protected_path, is_valid_project_cwd

# ---------------------------------------------------------------------------
# is_valid_project_cwd — FLOWPAD-1879: empty projects list on Windows
#
# Pre-fix, the gate was `if not cwd or not cwd.startswith("/")`. Windows
# absolute paths are drive-rooted ("C:/..." / "C:\\...") and never start with
# "/", so every Windows project cwd was rejected and the project picker came
# back empty. These lock the drive-rooted paths in as valid while still
# rejecting bare roots and relative garbage.
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "cwd",
    [
        "C:/Users/foo/proj",  # canonical_posix_path() forward-slash form
        "C:\\Users\\foo\\proj",  # decode_claude_project_dir backslash form
        "D:/work/repo",  # any drive letter
        "/Users/foo/proj",  # POSIX path still valid
    ],
)
def test_accepts_drive_rooted_and_posix_cwd(cwd: str) -> None:
    """A Windows drive-rooted or POSIX absolute project cwd is valid."""
    assert is_valid_project_cwd(cwd) is True


@pytest.mark.parametrize(
    "cwd",
    [
        "",  # empty
        "/",  # bare POSIX root
        "C:/",  # bare Windows drive root
        "C:\\",  # bare Windows drive root, backslash
        "foo/bar",  # relative
        "../escape",  # relative
    ],
)
def test_rejects_bare_roots_and_relative_cwd(cwd: str) -> None:
    """Empty, bare filesystem roots, and relative paths are rejected."""
    assert is_valid_project_cwd(cwd) is False


def test_canonical_project_cwd_policy_preserves_safe_descendants(
    tmp_path,
    monkeypatch,
) -> None:
    import dataclasses

    import flow_sdk.config as config
    import flow_sdk.instance_settings as instance_settings

    home = tmp_path / "home"
    records = home / ".flow" / "records"
    records_data = home / ".flow" / "records_data"
    workspace = home / "Flowpad workspace"
    patched = dataclasses.replace(
        instance_settings.get_instance_settings(),
        user_home=home,
        records_root=records,
        records_data_dir=records_data,
    )
    monkeypatch.setattr(instance_settings, "get_instance_settings", lambda: patched)
    monkeypatch.setattr(config, "AGENT_MOUNT_FOLDER", str(workspace))
    monkeypatch.setattr(config, "agent_workspace_root", lambda: workspace)

    assert not is_valid_project_cwd(home, include_temp=True)
    assert not is_valid_project_cwd(home.parent, include_temp=True)
    assert is_valid_project_cwd(home / "dev" / "repo", include_temp=True)
    assert not is_valid_project_cwd(workspace, include_temp=True)
    assert is_valid_project_cwd(workspace / "repo", include_temp=True)
    assert not is_valid_project_cwd(records / "project", include_temp=True)
    assert not is_valid_project_cwd(records_data / "project", include_temp=True)
    assert is_protected_path(home)
    assert is_protected_path(home.parent)
    assert not is_protected_path(home / "dev" / "repo")
    assert is_protected_path(workspace)
    assert not is_protected_path(workspace / "repo")
    assert is_protected_path(records / "project")
    assert is_protected_path(records_data / "project")
    assert is_valid_project_cwd(r"C:\Users\alice\repo")
    assert is_valid_project_cwd(r"\\server\share\repo")
    assert not is_protected_path(r"C:\Users\alice\repo")
    assert not is_protected_path(r"\\server\share\repo")
    assert is_protected_path("C:\\")
    assert is_protected_path(r"\\server\share")
    assert is_protected_path("C:relative")
    assert is_protected_path(r"\drive-less-root")
    assert not is_valid_project_cwd("C:\\")
    assert not is_valid_project_cwd(r"\\server\share")
    assert not is_valid_project_cwd("C:relative")
    assert not is_valid_project_cwd(r"\drive-less-root")


def test_protected_path_policy_keeps_windows_semantics_on_posix(
    monkeypatch,
) -> None:
    from types import SimpleNamespace

    import flow_sdk.config as config
    import flow_sdk.instance_settings as instance_settings

    settings = SimpleNamespace(
        user_home=r"C:\Users\Alice",
        records_root=r"C:\Users\Alice\.flow\records",
        records_data_dir=r"C:\Users\Alice\.flow\records_data",
    )
    monkeypatch.setattr(instance_settings, "get_instance_settings", lambda: settings)
    monkeypatch.setattr(config, "AGENT_MOUNT_FOLDER", r"C:\Users\Alice\Flowpad workspace")
    monkeypatch.setattr(
        config,
        "agent_workspace_root",
        lambda: r"C:\Users\Alice\Flowpad workspace",
    )
    monkeypatch.setenv("TEMP", r"C:\Temp")

    assert is_protected_path(r"C:\Users")
    assert is_protected_path(r"c:\users\alice")
    assert not is_protected_path(r"C:\Users\Alice\dev\repo")
    assert is_protected_path(r"C:\Users\Alice\Flowpad workspace")
    assert not is_protected_path(r"C:\Users\Alice\Flowpad workspace\repo")
    assert is_protected_path(r"C:\Users\Alice\.flow\records\project")
    assert is_protected_path(r"C:\Temp")
    assert not is_protected_path(r"C:\Temp\flowpad-test-project")


# ---------------------------------------------------------------------------
# _real_path_from_jsonl
# ---------------------------------------------------------------------------


def test_reads_cwd_from_jsonl(tmp_path: Path) -> None:
    """Returns the Path from the first 'cwd' field found in a JSONL file."""
    jsonl = tmp_path / "session.jsonl"
    jsonl.write_text(json.dumps({"type": "user", "cwd": "/Users/foo/my-project"}) + "\n")
    result = _real_path_from_jsonl(tmp_path)
    assert result == Path("/Users/foo/my-project")


def test_skips_lines_without_cwd(tmp_path: Path) -> None:
    """Returns the first line that has 'cwd', skipping earlier lines without it."""
    jsonl = tmp_path / "session.jsonl"
    jsonl.write_text(
        json.dumps({"type": "assistant", "text": "hello"})
        + "\n"
        + json.dumps({"type": "user", "cwd": "/Users/foo/real-path"})
        + "\n"
    )
    result = _real_path_from_jsonl(tmp_path)
    assert result == Path("/Users/foo/real-path")


def test_returns_none_when_no_jsonl(tmp_path: Path) -> None:
    """Returns None when there are no JSONL files."""
    result = _real_path_from_jsonl(tmp_path)
    assert result is None


def test_returns_none_when_no_cwd_field(tmp_path: Path) -> None:
    """Returns None when JSONL files exist but none contain 'cwd'."""
    jsonl = tmp_path / "session.jsonl"
    jsonl.write_text(json.dumps({"type": "assistant", "text": "hi"}) + "\n")
    result = _real_path_from_jsonl(tmp_path)
    assert result is None


def test_handles_malformed_lines(tmp_path: Path) -> None:
    """Skips malformed JSON lines and continues to valid ones."""
    jsonl = tmp_path / "session.jsonl"
    jsonl.write_text("not json at all\n" + json.dumps({"cwd": "/Users/foo/ok"}) + "\n")
    result = _real_path_from_jsonl(tmp_path)
    assert result == Path("/Users/foo/ok")


# ---------------------------------------------------------------------------
# iter_claude_project_paths
# ---------------------------------------------------------------------------


def _make_project_dir(
    base: Path,
    encoded_name: str,
    real_cwd: str | None = None,
) -> Path:
    """Create a fake ~/.claude/projects/<encoded> directory."""
    project_dir = base / encoded_name
    project_dir.mkdir(parents=True)
    if real_cwd is not None:
        jsonl = project_dir / "session.jsonl"
        jsonl.write_text(json.dumps({"type": "user", "cwd": real_cwd}) + "\n")
    return project_dir


def test_yields_real_path_from_jsonl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Yields the path decoded from JSONL cwd, not from the encoded name."""
    projects_root = tmp_path / ".claude" / "projects"
    real_dir = tmp_path / "my-project"
    real_dir.mkdir()
    _make_project_dir(projects_root, "-Users-foo-my-project", real_cwd=str(real_dir))

    monkeypatch.setattr(
        "flow_sdk.fs_store.indexer.functions._claude_projects._claude_projects_dir",
        lambda: projects_root,
    )
    result = list(iter_claude_project_paths(include_temp=True))
    assert result == [real_dir]


def test_claude_walker_rejects_home_but_keeps_home_subproject(
    tmp_path,
    monkeypatch,
) -> None:
    import dataclasses

    import flow_sdk.instance_settings as instance_settings
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.claude_projects import claude_projects_fn
    from flow_sdk.fs_store.indexer.index_function import IndexerOptions

    home = tmp_path / "home"
    project = home / "dev" / "repo"
    project.mkdir(parents=True)
    projects_root = home / ".claude" / "projects"
    _make_project_dir(projects_root, "-home", real_cwd=str(home))
    kept = _make_project_dir(projects_root, "-repo", real_cwd=str(project))
    patched = dataclasses.replace(
        instance_settings.get_instance_settings(),
        user_home=home,
        claude_projects_dir=projects_root,
    )
    monkeypatch.setattr(instance_settings, "get_instance_settings", lambda: patched)

    refs = claude_projects_fn(
        [FSRef(home)],
        IndexerOptions(include_temp=True),
    )

    assert [ref._path for ref in refs] == [kept]


@pytest.mark.asyncio
async def test_temp_cleanup_preserves_home_source_and_removes_only_temp(
    tmp_path,
    monkeypatch,
) -> None:
    import flow_sdk.fs_store.operations.claude_project as operations
    import flow_sdk.fs_store.record_paths as record_paths

    projects_root = tmp_path / ".claude" / "projects"
    home_source = _make_project_dir(
        projects_root,
        "-Users-cleanup-home",
        real_cwd="/Users/cleanup-home",
    )
    sentinel = home_source / "sentinel.jsonl"
    sentinel.write_text("{}\n")
    temp_source = _make_project_dir(
        projects_root,
        "-tmp-cleanup-project",
        real_cwd=str(tmp_path / "temp-project"),
    )
    records_root = tmp_path / "records"
    monkeypatch.setattr(operations, "_claude_projects_dir", lambda: projects_root)
    monkeypatch.setattr(record_paths, "get_default_records_root", lambda: records_root)

    removed = await operations.clean_temp_projects()

    assert removed == 1
    assert home_source.is_dir()
    assert sentinel.read_text() == "{}\n"
    assert not temp_source.exists()


def test_falls_back_to_decode_when_no_jsonl(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Falls back to hyphen-decode when _real_path_from_jsonl returns None.

    Materializes a hyphen-free real path on disk so the naive decode
    round-trips. Avoids ``Path.home()`` because conftest's sandbox HOME may
    sit under ``/private/tmp/claude-501/...`` whose embedded ``-501`` would
    decode wrong (Claude's encoder collapses ``-`` and ``/`` together).

    """
    projects_root = tmp_path / ".claude" / "projects"
    # Hyphen-free real path so encode→decode round-trips. The sandbox tmp_path
    # sits under ``/tmp/claude-501/...`` whose embedded ``-501`` breaks the
    # decode, so we materialize outside ``tempfile.gettempdir()`` under
    # ``/var/tmp`` (resolves to a hyphen-free ``/private/var/tmp/...``).
    import tempfile

    with tempfile.TemporaryDirectory(
        prefix="decoderoundtrip",
        dir="/var/tmp",
    ) as real_dir_raw:
        real_dir = Path(real_dir_raw).resolve()
        encoded = "-" + str(real_dir).lstrip("/").replace("/", "-")
        _make_project_dir(projects_root, encoded, real_cwd=None)  # no JSONL

        monkeypatch.setattr(
            "flow_sdk.fs_store.indexer.functions._claude_projects._claude_projects_dir",
            lambda: projects_root,
        )
        # Force the decode fallback explicitly so discovery changes cannot make
        # this test exercise the JSONL path by accident.
        monkeypatch.setattr(
            "flow_sdk.fs_store.indexer.functions._claude_projects._real_path_from_jsonl",
            lambda _: None,
        )
        result = list(iter_claude_project_paths(include_temp=True))
        assert result == [real_dir]


def test_deduplicates_same_real_path(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Does not yield the same real path twice even if two encoded dirs point to it."""
    projects_root = tmp_path / ".claude" / "projects"
    real_dir = tmp_path / "project"
    real_dir.mkdir()
    _make_project_dir(projects_root, "-a", real_cwd=str(real_dir))
    _make_project_dir(projects_root, "-b", real_cwd=str(real_dir))

    monkeypatch.setattr(
        "flow_sdk.fs_store.indexer.functions._claude_projects._claude_projects_dir",
        lambda: projects_root,
    )
    result = list(iter_claude_project_paths(include_temp=True))
    assert len(result) == 1
    assert result[0] == real_dir


def test_skips_nonexistent_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Does not yield paths that don't exist on disk."""
    projects_root = tmp_path / ".claude" / "projects"
    _make_project_dir(projects_root, "-Users-ghost-nowhere", real_cwd="/Users/ghost/nowhere")  # path does not exist

    monkeypatch.setattr(
        "flow_sdk.fs_store.indexer.functions._claude_projects._claude_projects_dir",
        lambda: projects_root,
    )
    result = list(iter_claude_project_paths())
    assert result == []


def test_hyphenated_project_name_resolved_correctly(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A project path with hyphens (e.g. flow-cli) is resolved via JSONL, not decode."""
    projects_root = tmp_path / ".claude" / "projects"
    # Real path has a hyphen — naive decode would give wrong result
    real_dir = tmp_path / "flow-cli"
    real_dir.mkdir()
    _make_project_dir(projects_root, "-Users-foo-flow-cli", real_cwd=str(real_dir))

    monkeypatch.setattr(
        "flow_sdk.fs_store.indexer.functions._claude_projects._claude_projects_dir",
        lambda: projects_root,
    )
    result = list(iter_claude_project_paths(include_temp=True))
    assert result == [real_dir]


def test_empty_projects_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Returns empty list when projects dir exists but is empty."""
    projects_root = tmp_path / ".claude" / "projects"
    projects_root.mkdir(parents=True)

    monkeypatch.setattr(
        "flow_sdk.fs_store.indexer.functions._claude_projects._claude_projects_dir",
        lambda: projects_root,
    )
    assert list(iter_claude_project_paths()) == []


def test_missing_projects_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Returns empty list when ~/.claude/projects doesn't exist."""
    monkeypatch.setattr(
        "flow_sdk.fs_store.indexer.functions._claude_projects._claude_projects_dir",
        lambda: tmp_path / "nonexistent",
    )
    assert list(iter_claude_project_paths()) == []
