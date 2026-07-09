"""Unit tests for the Folder entity — a directory reference the entity never owns.

Contract under test:

  * ``Folder.mint_for_path`` is idempotent: same directory (any spelling) →
    same v5 entity; different directory → different entity.
  * Saving a Folder writes NOTHING into the referenced directory (no
    ``default_body_fn``, ``owns_main_ref=False``) and never sets ``asset_ref``
    (generic purge paths rmtree asset_ref targets — a Folder must never point
    one at a user's directory).
  * The FOLDER type registration doesn't disturb the capability registry's
    use of the "folder" value tag.
"""
import pytest

from flow_sdk.builtin.folder import Folder
from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.builtin.local_origin import LocalOrigin
from flow_sdk.fs_store.identifier import is_valid_entity_id
from flow_sdk.fs_store.path_utils import canonical_posix_path
from flow_sdk.schema.type_info import register_all
from flow_sdk.fs_store.schema_registry import SchemaRegistry

register_all()


@pytest.mark.asyncio
async def test_mint_for_path_idempotent(tmp_path):
    d1 = tmp_path / "notes"
    d1.mkdir()
    a = await Folder.mint_for_path(str(d1))
    # Different spelling (trailing slash) canonicalizes to the same entity.
    b = await Folder.mint_for_path(str(d1) + "/")
    assert a.id == b.id
    assert is_valid_entity_id(a.id)
    assert a.path == canonical_posix_path(str(d1))

    d2 = tmp_path / "other"
    d2.mkdir()
    c = await Folder.mint_for_path(str(d2))
    assert c.id != a.id


@pytest.mark.asyncio
async def test_non_repo_dir_is_local_origin_with_stable_id(tmp_path):
    d = tmp_path / "plain"
    d.mkdir()
    folder = await Folder.mint_for_path(str(d))
    canonical = canonical_posix_path(str(d))
    # A non-repo dir → LocalOrigin(base=canonical).
    assert folder.origin is not None
    assert folder.origin.kind == "local"
    assert folder.origin.base == canonical
    # ZERO-MIGRATION GUARD: a local folder's id is byte-identical to the legacy
    # path-derived id, so existing folders + links never re-key.
    assert Folder.id_for_origin(LocalOrigin(base=canonical)) == Folder.id_for_path(canonical)
    assert folder.id == Folder.id_for_path(canonical)


@pytest.mark.asyncio
async def test_git_backed_folder_id_is_origin_key(tmp_path, monkeypatch):
    """A dir inside a git repo → transportable GitOrigin; the Folder id is
    origin.key() (same on every machine → shared refs resolve), stable across mints."""
    git_origin = GitOrigin(provider="github", owner="Acme", name="Repo",
                           branch="main", rel_path="pkg/tools")

    async def _fake_detect(_asset_root):
        return git_origin

    # Stub the git driver's detect so no real repo is needed.
    from flow_sdk.builtin.drivers.git_driver import GitOriginDriver
    monkeypatch.setattr(GitOriginDriver, "detect", staticmethod(lambda _p: None))
    monkeypatch.setattr(Folder, "detect_origin", staticmethod(_fake_detect))

    d = tmp_path / "repo" / "pkg" / "tools"
    d.mkdir(parents=True)
    a = await Folder.mint_for_path(str(d))
    assert a.origin is not None and a.origin.kind == "git"
    assert a.id == git_origin.key()
    b = await Folder.mint_for_path(str(d))
    assert b.id == a.id  # stable across mints


@pytest.mark.asyncio
async def test_save_reload_roundtrip(tmp_path):
    d = tmp_path / "ctx"
    d.mkdir()
    folder = await Folder.mint_for_path(str(d))
    reloaded = await Folder.get_by_id(folder.id)
    assert reloaded is not None
    assert reloaded.path == canonical_posix_path(str(d))
    assert reloaded.name == "ctx"


@pytest.mark.asyncio
async def test_never_writes_into_referenced_directory(tmp_path):
    d = tmp_path / "user-data"
    d.mkdir()
    (d / "keep.txt").write_text("hello")
    before = sorted(p.name for p in d.iterdir())

    folder = await Folder.mint_for_path(str(d))
    folder.name = "renamed"
    await folder.save()

    after = sorted(p.name for p in d.iterdir())
    assert after == before, "Folder save must not write into the referenced directory"
    # asset_ref must never point at the referenced dir (purge paths rmtree it).
    assert getattr(folder, "asset_ref", None) in (None, "")


def test_type_registered_without_breaking_capability_tag():
    info = SchemaRegistry.get("folder")
    assert info is not None
    assert info.owns_main_ref is False
    assert info.default_body_fn is None
    assert info.icon == "Folder"
