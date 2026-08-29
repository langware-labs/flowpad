"""Unit tests for the FSOrigin value object + kind-keyed driver registry.

Contracts under test:
  * GitOrigin.key() is BYTE-STABLE across the FSOrigin refactor — a fixed origin
    yields a hardcoded uuid5 literal (regression here = silent cross-machine
    dedup break for every already-shared asset).
  * the driver registry dispatches by kind, folds git-hosting-provider aliases
    onto git, and raises on an unknown kind;
  * the OriginField discriminated union is tolerant: a legacy dict with no
    `kind` deserializes to GitOrigin (kind=git); a `{kind:"local"}` dict to
    LocalOrigin;
  * the LocalOriginDriver materializes with NO fetch and guards rel_path;
  * the serialized dict is a WIRE FORMAT — exact key set and key ORDER are
    pinned per kind, and all three dump paths (model_dump python/json,
    ORIGIN_ADAPTER.dump_python) agree byte-for-byte;
  * validate->dump is NOT identity for a legacy kind-less dict, so raw
    pass-through paths must stay raw.
"""
import pytest
from pydantic import TypeAdapter

from flow_sdk.fs_store.origin.fs_origin import FSOrigin, is_safe_rel_path
from flow_sdk.builtin.fs_origin_driver import ORIGIN_DRIVERS, get_origin_driver
from flow_sdk.fs_store.origin.field import OriginField
from flow_sdk.fs_store.origin.git_origin import GitOrigin
from flow_sdk.fs_store.origin.local_origin import LocalOrigin

_ORIGIN_ADAPTER = TypeAdapter(OriginField)


def test_git_key_is_byte_stable():
    """A fixed GitOrigin must produce this EXACT uuid — the dedup handle that
    already-shared assets reconcile by. If this literal changes, dedup breaks."""
    origin = GitOrigin(
        provider="github", owner="Acme", name="Repo", branch="main",
        rel_path="pkg/.claude/skills/foo",
    )
    assert origin.key() == "2e2983fa-8092-53a5-b6dd-f0148d22063f"
    # Branch-independent + case-folded repo key: a different branch / owner case
    # yields the SAME key (the whole point).
    assert GitOrigin(provider="github", owner="acme", name="repo", branch="dev",
                     rel_path="pkg/.claude/skills/foo").key() == origin.key()


def test_registry_dispatch_and_aliases():
    reg = ORIGIN_DRIVERS
    assert set(reg.kinds()) == {"git", "local"}
    assert get_origin_driver("git").kind == "git"
    assert get_origin_driver("local").kind == "local"
    # git-hosting providers fold onto the git backend.
    for hosting in ("github", "gitlab", "bitbucket", "GitHub"):
        assert get_origin_driver(hosting).kind == "git"


def test_unknown_kind_raises():
    with pytest.raises(KeyError, match="Unknown FSOrigin kind"):
        get_origin_driver("s3")


def test_union_is_tolerant_of_legacy_dict():
    # Legacy git-shaped dict with NO kind → GitOrigin(kind="git").
    legacy = _ORIGIN_ADAPTER.validate_python(
        {"provider": "github", "owner": "a", "name": "b", "rel_path": "x"}
    )
    assert isinstance(legacy, GitOrigin) and legacy.kind == "git" and legacy.owner == "a"

    # Explicit kind routes to the right subclass with its locator intact.
    local = _ORIGIN_ADAPTER.validate_python(
        {"kind": "local", "base": "/mnt/share", "rel_path": "docs"}
    )
    assert isinstance(local, LocalOrigin) and local.base == "/mnt/share"

    gitd = _ORIGIN_ADAPTER.validate_python(
        {"kind": "git", "provider": "gitlab", "owner": "o", "name": "n", "rel_path": "r"}
    )
    assert isinstance(gitd, GitOrigin) and gitd.provider == "gitlab"


def test_direct_model_validate_defaults_kind():
    # Direct (non-union) validation also tolerates a missing kind.
    assert FSOrigin.model_validate({"rel_path": "x"}).kind == "git"
    assert GitOrigin.model_validate({"owner": "a", "name": "b"}).kind == "git"


def test_local_origin_key_stable():
    a = LocalOrigin(base="/mnt/share/", rel_path="docs/")
    b = LocalOrigin(base="/mnt/share", rel_path="docs")
    assert a.key() == b.key()  # base/rel canonicalized
    assert a.key() != LocalOrigin(base="/mnt/other", rel_path="docs").key()


@pytest.mark.asyncio
async def test_local_driver_materialize_no_fetch(tmp_path):
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "readme.md").write_text("hi")
    driver = get_origin_driver("local")

    origin = LocalOrigin(base=str(tmp_path), rel_path="docs")
    # materialize returns the ROOT (base); the caller joins rel_path as placement.
    local_root, project_id = await driver.materialize(origin)
    assert local_root == tmp_path
    assert (local_root / origin.rel_path) == tmp_path / "docs"
    assert project_id is None
    assert driver.matches(origin, tmp_path / "docs")

    # Missing path → FileNotFoundError (no fetch to fall back on).
    with pytest.raises(FileNotFoundError):
        await driver.materialize(LocalOrigin(base=str(tmp_path), rel_path="nope"))

    # Unsafe rel_path is rejected before any filesystem touch.
    with pytest.raises(ValueError):
        await driver.materialize(LocalOrigin(base=str(tmp_path), rel_path="../escape"))


def test_is_safe_rel_path():
    assert is_safe_rel_path("a/b/c")
    assert not is_safe_rel_path("")
    assert not is_safe_rel_path("/abs")
    assert not is_safe_rel_path("../up")
    assert not is_safe_rel_path("C:/win")


# ── wire-shape guardrails ────────────────────────────────────────────────────
#
# `Entity.origin` is Sharing.SHARED and reaches the HUB (as ``git_origin``), which pins a
# RELEASED flow_sdk. The serialized dict is therefore a wire format: its exact
# key set AND key order are load-bearing, and nothing in `tests/` asserted them
# before these. A stray `exclude_none=True`, a `by_alias`, or moving a field
# declaration would change the bytes silently.

#: The wire key order, per kind. Field order for the redeclared ``kind`` comes
#: from the BASE class, so moving ``kind`` inside a subclass is a byte change.
_GIT_WIRE_KEYS = ["kind", "rel_path", "provider", "owner", "name", "branch", "head_commit"]
_LOCAL_WIRE_KEYS = ["kind", "rel_path", "base"]


@pytest.mark.parametrize(
    "origin,expected_keys",
    [
        (GitOrigin(provider="github", owner="Acme", name="Repo", branch="main",
                   rel_path="pkg/x"), _GIT_WIRE_KEYS),
        (LocalOrigin(base="/mnt/share", rel_path="docs"), _LOCAL_WIRE_KEYS),
    ],
    ids=["git", "local"],
)
def test_origin_dump_is_wire_stable(origin, expected_keys):
    """All three dump paths agree, byte-for-byte, in the same key order.

    This is what lets the bundle keep ``model_dump(mode="python")`` at the
    producers while internal code carries typed objects: swapping one for the
    other cannot move the wire. Safe only because every field is
    ``str``/``Optional[str]``/``Literal`` — no Enum, datetime or Path.
    """
    as_python = origin.model_dump(mode="python")
    as_json = origin.model_dump(mode="json")
    via_adapter = _ORIGIN_ADAPTER.dump_python(origin)

    assert as_python == as_json == via_adapter
    # Order, not just membership — a reordered dict is a changed wire.
    assert list(as_python.keys()) == list(as_json.keys()) == expected_keys
    assert list(via_adapter.keys()) == expected_keys


def test_head_commit_null_is_emitted():
    """``head_commit: null`` rides the wire. Guards a stray ``exclude_none``."""
    dumped = GitOrigin(provider="github", owner="a", name="b").model_dump(mode="json")
    assert "head_commit" in dumped
    assert dumped["head_commit"] is None


def test_legacy_dict_roundtrip_is_not_identity():
    """validate → dump does NOT round-trip a legacy (kind-less) dict unchanged.

    It ADDS ``kind``/``head_commit`` and reorders. That is
    correct — but it means any path that passes a raw origin dict through to the
    wire must keep passing it through. Normalizing such a path "for consistency"
    silently rewrites bytes a released receiver is already reading.

    Pinned deliberately: this asymmetry is a constraint, not a bug to fix.
    """
    legacy = {"provider": "github", "owner": "a", "name": "b",
              "branch": "m", "rel_path": "x"}
    normalized = _ORIGIN_ADAPTER.validate_python(legacy).model_dump(mode="python")

    assert normalized != legacy
    assert set(normalized) - set(legacy) == {"kind", "head_commit"}
    assert normalized["kind"] == "git"
    # Re-dumping the NORMALIZED form is stable — only the first pass moves it.
    again = _ORIGIN_ADAPTER.validate_python(normalized).model_dump(mode="python")
    assert again == normalized


# ── Entity.origin: the ONE origin field, typed on adoption ────────────────────


def test_entity_origin_is_typed_on_adoption():
    """``Entity.origin`` adopts a dict (row, bundle map, hub ``git_origin``) as
    the typed FSOrigin; the hub serializer projects it back under ``git_origin``."""
    from flow_sdk.core.entity.entity_model import Entity

    assert Entity(type="task").origin is None, "absent origin reads as None, not an error"
    dumped = GitOrigin(provider="github", owner="a", name="b", rel_path="x").model_dump(mode="python")
    ent = Entity(type="task", origin=dumped)
    assert isinstance(ent.origin, GitOrigin) and ent.origin.clone_url() == "https://github.com/a/b.git"
    body = ent._hub_body()
    assert "origin" not in body and body["git_origin"]["owner"] == "a" and "project_id" not in body["git_origin"]


def test_entity_origin_tolerates_legacy_and_fails_soft():
    """A pre-``kind`` dict under the hub-wire name still resolves to git; a
    malformed one reads as absent rather than breaking the entity carrying it."""
    from flow_sdk.core.entity.entity_model import Entity

    ent = Entity(type="task", origin={"provider": "github", "owner": "a", "name": "b", "rel_path": "x"})
    assert isinstance(ent.origin, GitOrigin)
    assert Entity(type="task", origin={"kind": "git", "rel_path": ["not", "a", "path"]}).origin is None
    cloud = Entity(type="task", origin={"kind": "gmail", "provider": "agent", "url": "https://x"}).origin
    assert type(cloud).__name__ == "CloudOrigin" and cloud.kind == "gmail"
    # The hub's wire name comes back through the hub seam, not the model.
    from flow_sdk.fs_store.serializer.hub import HubSerializer

    lifted = HubSerializer.from_payload(Entity, {"type": "task", "git_origin": {"owner": "a", "name": "b", "rel_path": "x"}})
    assert isinstance(lifted.origin, GitOrigin)
