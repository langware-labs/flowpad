"""Git-sharing preflight + fail-closed git packing (REAL git repos).

Covers the backend eligibility gate (``git_share_preflight``) across every state
the Share dialog's Git toggle branches on, and the pack-time backstop that fails
CLOSED — an explicitly Git-shared asset with no valid origin raises rather than
silently shipping copied bytes.

Only the entity lookup is stubbed (pytest never runs ``register_all``); the git
reads, ``GitOrigin.for_asset_path``, and the packer are all real.
"""
import subprocess
from pathlib import Path

import pytest

from flow_sdk.app.actions.git_share_preflight_action import git_share_preflight
from flow_sdk.builtin.flow_message_bundle import (
    GitShareOriginError,
    _pack_file_backed_attachment,
    _pack_git_reference_attachment,
)
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ENTITY_ID = "7ce48c47-abab-4c9c-9780-a7198d12a260"
KEY = f"{EntityType.SKILL.value}-@{ENTITY_ID}"

FOLDER_ID = "1f0a2b3c-4d5e-4f60-8712-9a0b1c2d3e4f"
FOLDER_KEY = f"{EntityType.FOLDER.value}-@{FOLDER_ID}"


# --------------------------------------------------------------------------- #
# Fixtures / helpers
# --------------------------------------------------------------------------- #

def _g(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True, text=True)


def _skill(repo: Path, rel: str = ".claude/skills/foo") -> Path:
    asset = repo / rel
    asset.mkdir(parents=True, exist_ok=True)
    (asset / "SKILL.md").write_text("---\nname: foo\n---\n\n# foo\n", encoding="utf-8")
    return asset


def _init(root: Path, *, remote: str | None = "https://github.com/Acme/Widgets.git",
          branch: str = "main") -> None:
    root.mkdir(parents=True, exist_ok=True)
    _g(root, "init", "-q")
    _g(root, "checkout", "-q", "-b", branch)
    _g(root, "config", "user.email", "t@t.co")
    _g(root, "config", "user.name", "t")
    if remote:
        _g(root, "remote", "add", "origin", remote)


def _commit(root: Path, msg: str = "init") -> None:
    _g(root, "add", "-A")
    _g(root, "commit", "-qm", msg)


def _init_pushed(root: Path) -> None:
    """A clean, committed repo whose branch tracks a real (file://) origin with
    nothing ahead — the only fully eligible state."""
    bare = root.parent / "origin.git"
    subprocess.run(["git", "init", "--bare", "-q", str(bare)], check=True, capture_output=True)
    _init(root, remote=bare.resolve().as_uri(), branch="main")
    _skill(root)
    _commit(root)
    _g(root, "push", "-q", "-u", "origin", "main")


def _stub_lookup(monkeypatch, asset_ref: str) -> None:
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    class _FakeEntity:
        asset_ref = None
        name = "foo"

    ent = _FakeEntity()
    ent.asset_ref = asset_ref

    class _StubCls:
        @classmethod
        async def get_one(cls, query):  # noqa: ARG003
            return ent

    monkeypatch.setattr(SchemaRegistry, "get_entity_cls", classmethod(lambda c, t: _StubCls))


async def _preflight(monkeypatch, asset_ref: str) -> dict:
    _stub_lookup(monkeypatch, asset_ref)
    return await git_share_preflight(EntityType.SKILL.value, ENTITY_ID)


def _stub_folder(monkeypatch, path: str | None, *, name: str = "widgets"):
    """A real Folder entity (never saved) returned by the id lookup. Constructed
    from ``path`` only, so it carries the LocalOrigin the ctor synthesizes —
    exactly the stale-origin shape a directory git-init'd later would have."""
    from flow_sdk.builtin.folder import Folder  # noqa: PLC0415

    ent = Folder(id=FOLDER_ID, name=name, **({"path": path} if path else {}))

    async def _get_one(query):  # noqa: ARG001
        return ent

    monkeypatch.setattr(Folder, "get_one", staticmethod(_get_one))
    return ent


async def _folder_preflight(monkeypatch, path: str | None) -> dict:
    _stub_folder(monkeypatch, path)
    return await git_share_preflight(EntityType.FOLDER.value, FOLDER_ID)


# --------------------------------------------------------------------------- #
# Preflight states
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_eligible_clean_pushed_repo(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init_pushed(repo)
    res = await _preflight(monkeypatch, str(repo / ".claude" / "skills" / "foo"))
    assert res["available"] is True
    assert res["code"] is None
    assert res["git_origin"] and res["git_origin"]["branch"] == "main"


@pytest.mark.asyncio
async def test_not_in_repo(tmp_path, monkeypatch):
    loose = tmp_path / "loose" / "foo"
    loose.mkdir(parents=True)
    (loose / "SKILL.md").write_text("# s\n", encoding="utf-8")
    res = await _preflight(monkeypatch, str(loose))
    assert res["available"] is False
    assert res["code"] == "not-in-repo"


@pytest.mark.asyncio
async def test_missing_remote(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init(repo, remote=None)
    asset = _skill(repo)
    _commit(repo)
    res = await _preflight(monkeypatch, str(asset))
    assert res["available"] is False
    assert res["code"] == "missing-remote"


@pytest.mark.asyncio
async def test_no_commit(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init(repo)
    asset = _skill(repo)  # exists on disk but never committed
    res = await _preflight(monkeypatch, str(asset))
    assert res["available"] is False
    assert res["code"] == "no-commit"


@pytest.mark.asyncio
async def test_detached_head(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init(repo)
    asset = _skill(repo)
    _commit(repo)
    head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo, capture_output=True, text=True).stdout.strip()
    _g(repo, "checkout", "-q", head)  # detach
    res = await _preflight(monkeypatch, str(asset))
    assert res["available"] is False
    assert res["code"] == "detached-head"


@pytest.mark.asyncio
async def test_dirty(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init(repo)
    asset = _skill(repo)
    _commit(repo)
    (asset / "SKILL.md").write_text("# changed\n", encoding="utf-8")  # uncommitted edit
    res = await _preflight(monkeypatch, str(asset))
    assert res["available"] is False
    assert res["code"] == "dirty"


@pytest.mark.asyncio
async def test_unpushed_no_upstream(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init(repo)  # has an origin URL but the branch has no upstream / nothing pushed
    asset = _skill(repo)
    _commit(repo)
    res = await _preflight(monkeypatch, str(asset))
    assert res["available"] is False
    assert res["code"] == "unpushed"


@pytest.mark.asyncio
async def test_not_file_backed(tmp_path, monkeypatch):
    # No asset_ref → not file-backed → no origin to share.
    res = await _preflight(monkeypatch, "")
    assert res["available"] is False
    assert res["code"] == "not-file-backed"


# --------------------------------------------------------------------------- #
# FOLDER preflight — a context folder has no asset_ref by design, so it resolves
# through its own local `path`. These are the states the share gate branches on.
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_folder_eligible_clean_pushed_repo(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init_pushed(repo)
    res = await _folder_preflight(monkeypatch, str(repo))
    assert res["available"] is True
    assert res["code"] is None
    assert res["git_origin"] and res["git_origin"]["branch"] == "main"


@pytest.mark.asyncio
async def test_folder_not_in_repo(tmp_path, monkeypatch):
    # The LocalOrigin case: a plain directory. No special-casing — find_project_root
    # simply finds no .git, and "isn't inside a Git repository" is already the
    # right words. This is state 1 of the share gate ("Setup git").
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "notes.md").write_text("# notes\n", encoding="utf-8")
    res = await _folder_preflight(monkeypatch, str(plain))
    assert res["available"] is False
    assert res["code"] == "not-in-repo"


@pytest.mark.asyncio
async def test_folder_missing_remote(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init(repo, remote=None)
    _skill(repo)
    _commit(repo)
    res = await _folder_preflight(monkeypatch, str(repo))
    assert res["available"] is False
    assert res["code"] == "missing-remote"


@pytest.mark.asyncio
async def test_folder_no_commit(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init(repo)
    _skill(repo)
    res = await _folder_preflight(monkeypatch, str(repo))
    assert res["available"] is False
    assert res["code"] == "no-commit"


@pytest.mark.asyncio
async def test_folder_dirty(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init_pushed(repo)
    (repo / "uncommitted.md").write_text("# new\n", encoding="utf-8")
    res = await _folder_preflight(monkeypatch, str(repo))
    assert res["available"] is False
    assert res["code"] == "dirty"


@pytest.mark.asyncio
async def test_folder_unpushed(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init_pushed(repo)
    (repo / "later.md").write_text("# later\n", encoding="utf-8")
    _commit(repo, "later")  # committed but never pushed
    res = await _folder_preflight(monkeypatch, str(repo))
    assert res["available"] is False
    assert res["code"] == "unpushed"


@pytest.mark.asyncio
async def test_folder_subdir_of_repo_resolves_repo_root(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init_pushed(repo)
    sub = repo / ".claude" / "skills" / "foo"
    res = await _folder_preflight(monkeypatch, str(sub))
    assert res["available"] is True
    assert res["git_origin"]["rel_path"] == ".claude/skills/foo"


@pytest.mark.asyncio
async def test_folder_without_local_path_is_unresolved_not_unbacked(monkeypatch):
    # A received folder that was never resolved on this machine. It IS
    # file-backed — saying otherwise would be a lie the user can't act on.
    res = await _folder_preflight(monkeypatch, None)
    assert res["available"] is False
    assert res["code"] == "unresolved-folder"


# --------------------------------------------------------------------------- #
# Fail-closed packing — never silently downgrade an explicit Git share to copy
# --------------------------------------------------------------------------- #

@pytest.mark.asyncio
async def test_git_pack_outside_repo_raises_not_copies(tmp_path, monkeypatch):
    asset = tmp_path / "loose" / "foo"
    asset.mkdir(parents=True)
    (asset / "SKILL.md").write_text("---\nname: foo\n---\n\n# foo\n", encoding="utf-8")
    _stub_lookup(monkeypatch, str(asset))

    attachment_dir = tmp_path / "bundle"
    attachment_dir.mkdir()
    (attachment_dir.parent / "meta").mkdir(exist_ok=True)
    with pytest.raises(GitShareOriginError):
        await _pack_file_backed_attachment(
            EntityType.SKILL.value, ENTITY_ID, attachment_dir, {},
            transfers={}, transfer_mode="git",
        )
    # And it did NOT ship bytes as a fallback.
    assert not (attachment_dir / KEY / ".claude" / "skills" / "foo" / "SKILL.md").exists()


@pytest.mark.asyncio
async def test_git_pack_in_repo_is_metadata_only_no_bytes(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    _init(repo)
    asset = _skill(repo)
    _commit(repo)
    _stub_lookup(monkeypatch, str(asset))

    attachment_dir = tmp_path / "bundle" / "attachment"
    attachment_dir.mkdir(parents=True)
    transfers: dict = {}
    await _pack_file_backed_attachment(
        EntityType.SKILL.value, ENTITY_ID, attachment_dir, {},
        transfers=transfers, transfer_mode="git",
    )
    # Recorded as a git transfer…
    assert transfers.get(KEY, {}).get("transfer_mode") == "git"
    # …and NO asset bytes rode in the bundle (only metadata travels).
    assert not (attachment_dir / KEY / ".claude" / "skills" / "foo" / "SKILL.md").exists()


@pytest.mark.asyncio
async def test_git_pack_folder_without_origin_raises_not_silently_nothing(tmp_path, monkeypatch):
    """A folder with no transportable origin must RAISE under git mode.

    Regression: this used to `return False`, and the caller packs nothing for a
    folder (FOLDER has no main_subdir) — so the share silently delivered a chip
    with no origin and no bytes. Failing closed is the whole contract.
    """
    plain = tmp_path / "plain"
    plain.mkdir()
    (plain / "notes.md").write_text("# notes\n", encoding="utf-8")
    _stub_folder(monkeypatch, str(plain))

    attachment_dir = tmp_path / "bundle" / "attachment"
    attachment_dir.mkdir(parents=True)
    transfers: dict = {}
    with pytest.raises(GitShareOriginError):
        await _pack_git_reference_attachment(
            EntityType.FOLDER.value, FOLDER_ID, attachment_dir, {}, None,
            transfers=transfers, transfer_mode="git",
        )
    assert transfers == {}


@pytest.mark.asyncio
async def test_git_pack_folder_probes_live_origin_when_stored_is_stale(tmp_path, monkeypatch):
    """A folder git-init'd AFTER it was minted still carries a LocalOrigin.

    Preflight probes live and says available, so packing must agree rather than
    reject the very share preflight just green-lit.
    """
    repo = tmp_path / "repo"
    _init_pushed(repo)
    ent = _stub_folder(monkeypatch, str(repo))
    assert ent.origin is not None and not ent.origin.transportable, "precondition: stale local origin"

    attachment_dir = tmp_path / "bundle" / "attachment"
    attachment_dir.mkdir(parents=True)
    origins: dict = {}
    transfers: dict = {}
    packed = await _pack_git_reference_attachment(
        EntityType.FOLDER.value, FOLDER_ID, attachment_dir, origins, None,
        transfers=transfers, transfer_mode="git",
    )
    assert packed is True
    assert transfers[FOLDER_KEY]["transfer_mode"] == "git"
    assert origins[FOLDER_KEY]["branch"] == "main"
    # Metadata only — no repository bytes travel.
    assert not (attachment_dir / FOLDER_KEY).exists()
