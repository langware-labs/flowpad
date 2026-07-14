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
)
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ENTITY_ID = "7ce48c47-abab-4c9c-9780-a7198d12a260"
KEY = f"{EntityType.SKILL.value}-@{ENTITY_ID}"


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
