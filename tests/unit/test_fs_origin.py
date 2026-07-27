"""Unit tests for the FSOrigin value object + kind-keyed driver registry.

Contracts under test:
  * GitOrigin.key() is BYTE-STABLE across the FSOrigin refactor — a fixed origin
    yields a hardcoded uuid5 literal (regression here = silent cross-machine
    dedup break for every already-shared asset).
  * the driver registry dispatches by kind, folds git-hosting-provider aliases
    onto git, and raises on an unknown kind;
  * the FSOriginField discriminated union is tolerant: a legacy dict with no
    `kind` deserializes to GitOrigin (kind=git); a `{kind:"local"}` dict to
    LocalOrigin;
  * the LocalOriginDriver materializes with NO fetch and guards rel_path.
"""
import pytest
from pydantic import TypeAdapter

from flow_sdk.builtin.fs_origin import FSOrigin, is_safe_rel_path
from flow_sdk.builtin.fs_origin_driver import get_origin_driver, get_origin_registry
from flow_sdk.builtin.fs_origin_field import FSOriginField
from flow_sdk.builtin.git_origin import GitOrigin
from flow_sdk.builtin.local_origin import LocalOrigin

_ORIGIN_ADAPTER = TypeAdapter(FSOriginField)


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
    reg = get_origin_registry()
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


def test_bundle_git_origin_dict_predicate():
    """The dual-write filter: only git-kind (or legacy kind-less) origin dicts
    go into the transition legacy git_origins.json; non-git kinds don't."""
    from flow_sdk.builtin.flow_message_bundle import _is_git_origin_dict

    assert _is_git_origin_dict({"provider": "github", "owner": "a"})  # legacy, no kind
    assert _is_git_origin_dict({"kind": "git", "owner": "a"})
    assert not _is_git_origin_dict({"kind": "local", "base": "/mnt"})
    assert not _is_git_origin_dict(None)
    assert not _is_git_origin_dict("not-a-dict")
