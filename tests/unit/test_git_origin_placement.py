"""GitOrigin — git-coherent share placement (value object + bundle pack/unpack).

Covers, with REAL git repos + the REAL packer/restore (only the entity lookup is
stubbed, since pytest never runs ``register_all`` that wires entity classes):

  * GitOrigin value object: deterministic branch-independent key, rel_path
    sanitization (path-traversal guard), and ``for_asset_path`` against a real repo.
  * Pack: a file-backed asset that lives inside a git repo records a GitOrigin and
    stores its subtree keyed by the repo-relative ``rel_path`` (mirrors sender
    layout); an asset NOT in a repo records no origin and keeps canonical layout.
  * Unpack: ``_restore_file_backed_entry`` mirrors an origin-keyed subtree to
    ``project_root/rel_path`` and REFUSES members that escape the project root.
"""
import subprocess
from pathlib import Path

import pytest

from flow_sdk.builtin.git_origin import GitOrigin, is_safe_rel_path
from flow_sdk.builtin.flow_message_bundle import (
    _pack_file_backed_attachment,
    _restore_file_backed_entry,
)
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ENTITY_ID = "7ce48c47-abab-4c9c-9780-a7198d12a260"


# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #

def _init_repo(root: Path, remote: str = "https://github.com/Acme/Widgets.git", branch: str = "feature/x") -> None:
    def g(*args):
        subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)
    root.mkdir(parents=True, exist_ok=True)
    g("init", "-q")
    g("remote", "add", "origin", remote)
    g("checkout", "-q", "-b", branch)
    g("config", "user.email", "t@t.co")
    g("config", "user.name", "t")


def _stub_file_backed_lookup(monkeypatch, asset_ref: str, name: str = "asset"):
    """Point ``_resolve_file_backed_source`` at our on-disk fixture via a fake
    entity. Real ``SchemaRegistry.get`` (TypeInfo) is untouched — only the
    ``entity_cls`` resolution is replaced (pytest never runs ``register_all``)."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    class _FakeEntity:
        def __init__(self, ar, nm):
            self.asset_ref = ar
            self.name = nm

    ent = _FakeEntity(asset_ref, name)

    class _StubCls:
        @classmethod
        async def get_one(cls, query):  # noqa: ARG003
            return ent

    monkeypatch.setattr(SchemaRegistry, "get_entity_cls", classmethod(lambda c, t: _StubCls))
    return ent


# --------------------------------------------------------------------------- #
# Value object
# --------------------------------------------------------------------------- #

def test_key_is_deterministic_case_folded_and_branch_independent():
    a = GitOrigin(provider="github", owner="Acme", name="Widgets", branch="main",
                  rel_path="packages/x/.claude/skills/foo")
    b = GitOrigin(provider="github", owner="acme", name="widgets", branch="dev",
                  rel_path="packages/x/.claude/skills/foo")
    # Same repo + same position → same key, regardless of owner/name case or branch.
    assert a.key() == b.key()
    # Different position → different key.
    c = GitOrigin(provider="github", owner="acme", name="widgets", rel_path="docs/other.md")
    assert a.key() != c.key()


@pytest.mark.parametrize("bad", ["", "   ", "/abs/path", "C:/win", "../escape", "a/../../b", "a/../b"])
def test_rel_path_sanitizer_rejects_traversal_and_absolute(bad):
    assert not is_safe_rel_path(bad)


@pytest.mark.parametrize("ok", ["docs/foo.md", "packages/x/.claude/skills/foo", ".claude/skills/foo"])
def test_rel_path_sanitizer_accepts_relative(ok):
    assert is_safe_rel_path(ok)


def test_for_asset_path_reads_repo_coords_branch_head_and_relpath(tmp_path):
    repo = tmp_path / "repo"
    _init_repo(repo)
    asset = repo / "packages" / "x" / ".claude" / "skills" / "foo"
    asset.mkdir(parents=True)
    (asset / "SKILL.md").write_text("# s\n", encoding="utf-8")
    subprocess.run(["git", "add", "-A"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "commit", "-qm", "init"], cwd=repo, check=True, capture_output=True)

    o = GitOrigin.for_asset_path(str(asset))
    assert o is not None
    assert (o.provider, o.owner, o.name) == ("github", "Acme", "Widgets")
    assert o.branch == "feature/x"
    assert o.head_commit and len(o.head_commit) == 40
    assert o.rel_path == "packages/x/.claude/skills/foo"


def test_for_asset_path_returns_none_outside_a_repo(tmp_path):
    loose = tmp_path / "no_repo" / "skills" / "foo"
    loose.mkdir(parents=True)
    assert GitOrigin.for_asset_path(str(loose)) is None


# --------------------------------------------------------------------------- #
# Pack
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_pack_in_repo_records_origin_and_keys_subtree_by_rel_path(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init_repo(repo)
    # A skill nested inside the repo (NOT directly at the repo root's .claude).
    asset = repo / "packages" / "x" / ".claude" / "skills" / "foo"
    asset.mkdir(parents=True)
    (asset / "SKILL.md").write_text("---\nname: foo\n---\n\n# foo\n", encoding="utf-8")
    _stub_file_backed_lookup(monkeypatch, str(asset), name="foo")

    attachment_dir = tmp_path / "bundle"
    attachment_dir.mkdir()
    origins: dict = {}
    await _pack_file_backed_attachment(EntityType.SKILL.value, ENTITY_ID, attachment_dir, origins)

    key = f"{EntityType.SKILL.value}-@{ENTITY_ID}"
    assert key in origins, "an in-repo asset must record a GitOrigin"
    assert origins[key]["rel_path"] == "packages/x/.claude/skills/foo"
    assert origins[key]["owner"] == "Acme"
    # Subtree stored keyed by rel_path (mirrors sender layout), not just main_subdir/leaf.
    entry_root = attachment_dir / key
    assert (entry_root / "packages" / "x" / ".claude" / "skills" / "foo" / "SKILL.md").exists()


@pytest.mark.asyncio
async def test_pack_outside_repo_records_no_origin_and_keeps_canonical_layout(tmp_path, monkeypatch):
    asset = tmp_path / "loose" / "foo"
    asset.mkdir(parents=True)
    (asset / "SKILL.md").write_text("---\nname: foo\n---\n\n# foo\n", encoding="utf-8")
    _stub_file_backed_lookup(monkeypatch, str(asset), name="foo")

    attachment_dir = tmp_path / "bundle"
    attachment_dir.mkdir()
    origins: dict = {}
    await _pack_file_backed_attachment(EntityType.SKILL.value, ENTITY_ID, attachment_dir, origins)

    assert origins == {}, "a non-repo asset must NOT record a GitOrigin"
    # Canonical <main_subdir>/<leaf> layout preserved (today's behavior).
    entry_root = attachment_dir / f"{EntityType.SKILL.value}-@{ENTITY_ID}"
    assert (entry_root / ".claude" / "skills" / "foo" / "SKILL.md").exists()


# --------------------------------------------------------------------------- #
# Unpack
# --------------------------------------------------------------------------- #

def test_restore_mirrors_origin_keyed_subtree_under_project_root(tmp_path):
    # Bundle entry already keyed by rel_path (what the in-repo packer produces).
    entry = tmp_path / "entry"
    leaf = entry / "packages" / "x" / ".claude" / "skills" / "foo"
    leaf.mkdir(parents=True)
    (leaf / "SKILL.md").write_text("# foo\n", encoding="utf-8")

    project_root = tmp_path / "proj"
    project_root.mkdir()
    assert _restore_file_backed_entry(entry, project_root, overwrite=False) is True
    assert (project_root / "packages" / "x" / ".claude" / "skills" / "foo" / "SKILL.md").exists()


def test_restore_writes_only_under_project_root_via_symlink_escape(tmp_path):
    # The unpack ``dest.resolve()`` guard is defense-in-depth: a symlinked dir
    # inside project_root that points outside must not let a restored member
    # escape the root. (The primary traversal guard is pack-side
    # ``is_safe_rel_path`` + zip-extract sanitization, tested above.)
    external = tmp_path / "external"
    external.mkdir()
    project_root = tmp_path / "proj"
    project_root.mkdir()
    # A pre-existing symlink under the project root pointing outside it.
    (project_root / "escape").symlink_to(external, target_is_directory=True)

    entry = tmp_path / "entry"
    leaf = entry / "escape"  # member would resolve to external/ via the symlink
    leaf.mkdir(parents=True)
    (leaf / "pwned.txt").write_text("x", encoding="utf-8")
    good = entry / "docs"
    good.mkdir(parents=True)
    (good / "ok.md").write_text("ok\n", encoding="utf-8")

    _restore_file_backed_entry(entry, project_root, overwrite=False)
    # Legit member landed; the symlink-escaping member did NOT write outside.
    assert (project_root / "docs" / "ok.md").exists()
    assert not (external / "pwned.txt").exists()


# --------------------------------------------------------------------------- #
# pack_bundle integration: the top-level git_origins.json + rel_path subtree
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_pack_bundle_writes_git_origins_json_and_rel_path_subtree(tmp_path, monkeypatch):
    """The REAL ``pack_bundle`` for a FlowMessage carrying an in-repo skill must
    (a) write a top-level ``git_origins.json`` mapping the asset typeid → origin
    and (b) store the asset subtree keyed by its repo-relative ``rel_path`` so the
    receiver reconstructs the SAME path. Only the entity lookup is stubbed."""
    import json
    import zipfile
    from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage
    from flow_sdk.builtin.flow_message_bundle import pack_bundle

    repo = tmp_path / "repo"
    _init_repo(repo)
    asset = repo / "packages" / "x" / ".claude" / "skills" / "foo"
    asset.mkdir(parents=True)
    (asset / "SKILL.md").write_text("---\nname: foo\n---\n\n# foo\n", encoding="utf-8")
    _stub_file_backed_lookup(monkeypatch, str(asset), name="foo")

    fm = FlowMessage(
        text="here is a skill",
        sender_name="Alice",
        attachment=[Attachment(attachment_type=AttachmentType.TYPE_ID,
                               data=f"{EntityType.SKILL.value}-{ENTITY_ID}")],
    )
    fm.id = "f5f5f5f5-0000-4000-8000-000000000abc"

    zip_path = await pack_bundle(fm, dest_dir=tmp_path)
    with zipfile.ZipFile(zip_path) as zf:
        names = zf.namelist()
        assert "git_origins.json" in names, "in-repo asset must produce git_origins.json"
        origins = json.loads(zf.read("git_origins.json"))
        key = f"{EntityType.SKILL.value}-@{ENTITY_ID}"
        assert origins[key]["rel_path"] == "packages/x/.claude/skills/foo"
        assert origins[key]["owner"] == "Acme"
        # Subtree stored keyed by rel_path (the receiver mirrors it verbatim).
        assert f"attachment/{key}/packages/x/.claude/skills/foo/SKILL.md" in names


# --------------------------------------------------------------------------- #
# Stamping: received entity gets git_origin (validated, best-effort)
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_stamp_git_origins_sets_validated_origin_on_entity(monkeypatch):
    from flow_sdk.builtin.flow_message_bundle import _stamp_git_origins
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    saved = {}

    class _Ent:
        def __init__(self):
            self.git_origin = None
        async def save(self, owner=None):
            saved["git_origin"] = self.git_origin

    ent = _Ent()

    class _Cls:
        @classmethod
        async def get_one(cls, q):  # noqa: ARG003
            return ent

    monkeypatch.setattr(SchemaRegistry, "get_entity_cls", classmethod(lambda c, t: _Cls))

    origin = {"provider": "github", "owner": "Acme", "name": "Widgets",
              "branch": "main", "head_commit": "x" * 40, "rel_path": "docs/foo.md"}
    received = {("markdown", ENTITY_ID)}
    await _stamp_git_origins(received, {f"markdown-@{ENTITY_ID}": origin}, owner_typeid=None)

    assert saved["git_origin"]["rel_path"] == "docs/foo.md"
    assert saved["git_origin"]["owner"] == "Acme"

    # A malformed origin is dropped (validated through GitOrigin), not persisted.
    ent2 = _Ent()

    class _Cls2:
        @classmethod
        async def get_one(cls, q):  # noqa: ARG003
            return ent2

    monkeypatch.setattr(SchemaRegistry, "get_entity_cls", classmethod(lambda c, t: _Cls2))
    saved.clear()
    await _stamp_git_origins({("markdown", ENTITY_ID)},
                             {f"markdown-@{ENTITY_ID}": {"rel_path": ["not", "a", "string"]}},
                             owner_typeid=None)
    assert ent2.git_origin is None and "git_origin" not in saved
