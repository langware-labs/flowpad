"""Guards for the 0.2.112 migration that moves flowpad-native assets out of the
harness dot-dirs into ``agentic-assets/<type>/``.

Real filesystem, no mocks — the whole point of the script is what it does to
directories. Fast (<0.3s): every case is a handful of tiny files.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

_SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/migrations/0.2.112/scripts/migrate.py"
)


def _load_migration():
    """Load the script the way ``_drive_migration_script`` does.

    The sys.modules registration BEFORE exec_module is load-bearing, not
    ceremony: ``@dataclass`` resolves its annotations via
    ``sys.modules[cls.__module__]`` at decoration time, so a module that is not
    yet registered blows up with ``'NoneType' object has no attribute
    '__dict__'``. Mirroring the runner keeps this test honest about how the
    script is actually executed in production.
    """
    name = "_agentic_assets_migration"
    spec = importlib.util.spec_from_file_location(name, _SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[name] = mod
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.modules.pop(name, None)
    return mod


def _seed(root: Path, rel: str, name: str, body: str = "x") -> Path:
    """Seed one legacy asset. A name WITH a suffix is a file (a doc, a transcript,
    a blob); a bare name is a folder-backed asset carrying its marker file."""
    p = root / rel / name
    p.parent.mkdir(parents=True, exist_ok=True)
    if Path(name).suffix:
        p.write_text(body, encoding="utf-8")
    else:
        p.mkdir()
        (p / "WHITE_BOARD.md").write_text(body, encoding="utf-8")
    return p


def test_moves_folder_and_file_families(tmp_path: Path):
    m = _load_migration()
    _seed(tmp_path, ".claude/whiteboards", "My Board")
    _seed(tmp_path, ".claude/transcripts", "abc.jsonl", "{}")
    _seed(tmp_path, "prompts", "fix.md", "prompt")

    report = m._migrate_root(tmp_path, "project")

    assert (tmp_path / "agentic-assets/whiteboard/My Board/WHITE_BOARD.md").is_file()
    assert (tmp_path / "agentic-assets/claude_session/abc.jsonl").is_file()
    assert (tmp_path / "agentic-assets/prompt/fix.md").is_file()
    # Emptied legacy dirs are removed so the next run is a clean no-op.
    assert not (tmp_path / ".claude/whiteboards").exists()
    assert not (tmp_path / "prompts").exists()
    assert len(report.moved) == 3


def test_is_idempotent(tmp_path: Path):
    m = _load_migration()
    _seed(tmp_path, ".claude/journeys", "Tour")

    first = m._migrate_root(tmp_path, "project")
    second = m._migrate_root(tmp_path, "project")

    assert len(first.moved) == 1
    assert second.moved == [] and second.collisions == []
    assert (tmp_path / "agentic-assets/journey/Tour/WHITE_BOARD.md").is_file()


def test_collision_is_left_alone_never_overwritten(tmp_path: Path):
    m = _load_migration()
    _seed(tmp_path, ".claude/whiteboards", "Dup", "LEGACY")
    _seed(tmp_path, "agentic-assets/whiteboard", "Dup", "CURRENT")

    report = m._migrate_root(tmp_path, "project")

    # The destination content must survive untouched, and the legacy copy stays
    # on disk for the user rather than being silently dropped.
    assert (tmp_path / "agentic-assets/whiteboard/Dup/WHITE_BOARD.md").read_text() == "CURRENT"
    assert (tmp_path / ".claude/whiteboards/Dup/WHITE_BOARD.md").read_text() == "LEGACY"
    assert report.moved == []
    assert report.collisions == [".claude/whiteboards/Dup"]


def test_user_scope_claude_plans_is_never_touched(tmp_path: Path):
    """``~/.claude/plans`` belongs to Claude Code (plan-mode output) and is still
    read in place by ``claude_plan_fn`` — moving it would both lose the user's
    plans and break the harness."""
    m = _load_migration()
    _seed(tmp_path, ".claude/plans", "my-plan.md", "plan body")

    user_report = m._migrate_root(tmp_path, "user")

    assert (tmp_path / ".claude/plans/my-plan.md").read_text() == "plan body"
    assert user_report.moved == []

    # The same directory at PROJECT scope was flowpad's own, and does move.
    project_report = m._migrate_root(tmp_path, "project")
    assert (tmp_path / "agentic-assets/plan/my-plan.md").is_file()
    assert len(project_report.moved) == 1


def test_untyped_dirs_move_to_docs_and_the_project_root(tmp_path: Path):
    """``.claude/docs`` / ``.claude/files`` were flowpad inventions inside Claude
    Code's namespace. Markdown becomes DOCS (``docs/``), untyped bytes become
    PROJECT (the root itself) so the tree reflects git structure."""
    m = _load_migration()
    _seed(tmp_path, ".claude/docs", "notes.md", "note body")
    _seed(tmp_path, ".claude/files", "spec.pdf", "%PDF-1.4")

    report = m._migrate_root(tmp_path, "project")

    assert (tmp_path / "docs/notes.md").read_text() == "note body"
    assert (tmp_path / "spec.pdf").read_text() == "%PDF-1.4"
    assert not (tmp_path / ".claude/docs").exists()
    assert not (tmp_path / ".claude/files").exists()
    assert len(report.moved) == 2


def test_user_scope_moves_docs_but_not_loose_files(tmp_path: Path):
    """``~/.claude/docs`` MUST move — ``markdown_flat_fn`` now scans ``~/docs``, so
    leaving it silently de-indexes every user-scope document. ``~/.claude/files``
    is deliberately left alone: PROJECT is project-scope only, and strewing loose
    files across the user's home is never the right answer."""
    m = _load_migration()
    _seed(tmp_path, ".claude/docs", "kb.md", "knowledge")
    _seed(tmp_path, ".claude/files", "blob.bin", "bytes")

    m._migrate_root(tmp_path, "user")

    assert (tmp_path / "docs/kb.md").read_text() == "knowledge"
    assert (tmp_path / ".claude/files/blob.bin").read_text() == "bytes"
    assert not (tmp_path / "blob.bin").exists()


def test_every_legacy_family_targets_a_real_repo_type():
    """The destination of each row must be a registered REPO type — otherwise the
    migration would move assets into a folder no walker ever reads."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    m = _load_migration()
    repo_families = set(SchemaRegistry.repo_family_to_type())
    targets = {type_name for _, type_name, _ in m.LEGACY_FAMILIES}
    assert targets <= repo_families, f"not repo types: {targets - repo_families}"
