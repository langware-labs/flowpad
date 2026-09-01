"""The origin map as a BUNDLE WIRE FORMAT — write, dual-write, and read-back.

Why this file exists: before it, ``fs_origins.json`` appeared **nowhere** in
``tests/``. Every existing assertion checked only the legacy
``git_origins.json``, so the canonical write could be deleted, or the
prefer-canonical/fall-back read broken, with the suite staying green.

Contracts under test:
  * both files are written — canonical ``fs_origins.json`` ALWAYS, legacy
    ``git_origins.json`` as a strict subset of the kinds an old receiver can
    actually materialize;
  * the legacy file is the only thing keeping git shares readable by an
    already-released receiver, so it is written whenever such an origin exists;
  * values pass through UNCHANGED — a legacy kind-less dict must reach the file
    byte-identical, because normalizing it would rewrite bytes a released
    receiver is already reading;
  * the reader prefers the canonical file, falls back to the legacy one (old
    sender), and treats an unreadable file as absent rather than fatal.

Directory-level, no zip and no git subprocess — these run in milliseconds.
"""
import json

import pytest

from flow_sdk.builtin.flow_message_bundle import (
    _FS_ORIGINS_FILE,
    _read_origin_map,
    _write_origin_files,
)
from flow_sdk.fs_store.origin.git_origin import GitOrigin
from flow_sdk.fs_store.origin.local_origin import LocalOrigin

# Dumped from the real models, exactly as the packer emits them — a literal
# would silently drift the day a field is added, leaving these tests passing
# against a shape nothing produces any more.
_GIT = GitOrigin(provider="github", owner="Acme", name="Repo", branch="main",
                 rel_path="pkg/x").model_dump(mode="python")
_LOCAL = LocalOrigin(base="/mnt/share", rel_path="docs").model_dump(mode="python")
# Deliberately a literal: this is a PRE-``kind`` payload, so by definition no
# current model produces it.
_LEGACY_GIT = {"provider": "github", "owner": "a", "name": "b",
               "branch": "m", "rel_path": "x"}


def _read(root, name):
    return json.loads((root / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize(
    "origins,expected",
    [({"folder-@1": _GIT}, {"folder-@1"}), ({"a": _GIT, "b": _LOCAL, "c": _LEGACY_GIT}, {"a", "b", "c"}), ({}, None)],
    ids=["git", "mixed", "empty"],
)
def test_write_carries_every_kind(tmp_path, origins, expected):
    """One file, every kind. ``None`` means the file must not exist at all — an
    empty map must not leave a stray ``{}`` behind."""
    _write_origin_files(tmp_path, origins)
    if expected is None:
        assert not (tmp_path / _FS_ORIGINS_FILE).exists()
    else:
        assert set(_read(tmp_path, _FS_ORIGINS_FILE)) == expected


def test_values_pass_through_unchanged(tmp_path):
    """The writer must NOT normalize. A kind-less dict reaching the file with
    ``kind``/``project_id``/``head_commit`` added is a silent wire change."""
    _write_origin_files(tmp_path, {"c": _LEGACY_GIT})

    on_disk = _read(tmp_path, _FS_ORIGINS_FILE)["c"]
    assert on_disk == _LEGACY_GIT
    assert "kind" not in on_disk


@pytest.mark.parametrize(
    "text,expected",
    [(json.dumps({"a": _GIT}), {"a": _GIT}), ("{not json", {}), ("null", {}), (None, {})],
    ids=["present", "corrupt", "null", "absent"],
)
def test_read_is_tolerant(tmp_path, text, expected):
    """A corrupt or absent map is ``{}`` — never a failed unpack."""
    if text is not None:
        (tmp_path / _FS_ORIGINS_FILE).write_text(text, encoding="utf-8")
    assert _read_origin_map(tmp_path) == expected


def test_write_read_round_trip_is_stable(tmp_path):
    """Mixed kinds survive a full round trip through the canonical file."""
    origins = {"a": _GIT, "b": _LOCAL, "c": _LEGACY_GIT}
    _write_origin_files(tmp_path, origins)

    assert _read_origin_map(tmp_path) == origins
