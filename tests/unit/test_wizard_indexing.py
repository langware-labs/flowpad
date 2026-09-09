"""WIZARD indexer extract + id policy.

The id assertions matter more here than for most types. A wizard ships INSIDE
the wheel, so every install has byte-identical files; if the id were derived
from the document, every machine on earth would share one wizard id. The
Sidecar carrier keeps the id out of ``wizard.json`` and mints a v4 per install
instead.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

# Populate the SchemaRegistry so WIZARD type metadata resolves.
import flow_sdk.fs_store.indexer.registrations  # noqa: F401
from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.wizard import (
    extract_wizard,
    read_wizard,
    wizard_asset_hash,
)
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from tests.fixtures.identity import resolve_id

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

DOC = {
    "name": "Developer toolchain",
    "description": "python3 and git",
    "triggers": [{"on": "app.ready", "fire_once": True}],
    "steps": [
        {"id": "python3", "label": "Python 3",
         "precondition": {"commands": {"linux": "command -v python3"}},
         "process": {"prompt": "install python"}},
        {"id": "git", "label": "Git",
         "precondition": {"commands": {"linux": "command -v git"}},
         "process": {"prompt": "install git"}},
    ],
}


def _folder(tmp_path: Path, doc=None, *, name: str = "dev-toolchain") -> Path:
    root = tmp_path / "agentic-assets" / "wizard" / name
    root.mkdir(parents=True)
    (root / "wizard.json").write_text(json.dumps(doc if doc is not None else DOC), encoding="utf-8")
    return root


def _extract(root: Path):
    ref = FSRef(root)
    return extract_wizard(ref, resolve_id(SchemaRegistry.get("wizard"), ref))


def test_a_wizard_folder_becomes_one_record(tmp_path):
    records = _extract(_folder(tmp_path))
    assert len(records) == 1
    record = records[0]
    assert record.type == "wizard"
    assert record.name == "Developer toolchain"
    assert record.description == "python3 and git"
    assert record.metadata["step_count"] == 2
    assert record.metadata["trigger_tags"] == ["app.ready"]


def test_step_labels_reach_the_search_content(tmp_path):
    record = _extract(_folder(tmp_path))[0]
    assert "Python 3" in record.content and "Git" in record.content


def test_the_id_is_a_v4_minted_per_install_not_derived_from_the_document(tmp_path):
    """Two installs of the same shipped bytes must not share one id."""
    a = _extract(_folder(tmp_path / "install-a"))[0]
    b = _extract(_folder(tmp_path / "install-b"))[0]
    assert is_valid_entity_id(a.id) and is_valid_entity_id(b.id)
    assert a.id != b.id, "a shipped wizard's id must be per-install, not per-document"


def test_re_indexing_the_same_folder_keeps_its_id(tmp_path):
    root = _folder(tmp_path)
    assert _extract(root)[0].id == _extract(root)[0].id


def test_the_id_is_not_written_into_the_shipped_document(tmp_path):
    """Sidecar identity — ``wizard.json`` stays exactly what the author wrote,
    which is also what keeps a read-only install from being dirtied."""
    root = _folder(tmp_path)
    _extract(root)
    assert "id" not in json.loads((root / "wizard.json").read_text())


def test_a_malformed_document_yields_no_wizard_and_no_exception(tmp_path):
    root = tmp_path / "agentic-assets" / "wizard" / "broken"
    root.mkdir(parents=True)
    (root / "wizard.json").write_text("{ not json", encoding="utf-8")
    assert read_wizard(root) is None
    record = _extract(root)[0]
    assert record.name == "broken", "falls back to the folder name rather than raising"


def test_a_document_that_violates_the_shape_is_refused_not_half_read(tmp_path):
    bad = {"name": "w", "steps": [{"id": "s", "command": {"commands": {"linux": "a"}},
                                   "process": {"prompt": "p"}}]}
    assert read_wizard(_folder(tmp_path, bad, name="two-actions")) is None


def test_freshness_tracks_the_document_only(tmp_path):
    root = _folder(tmp_path)
    before = wizard_asset_hash(FSRef(root))
    # Run scratch beside the document must not make the asset look stale.
    (root / "run.log").write_text("noise", encoding="utf-8")
    assert wizard_asset_hash(FSRef(root)) == before


def test_a_missing_document_hashes_to_zero_rather_than_raising(tmp_path):
    empty = tmp_path / "agentic-assets" / "wizard" / "empty"
    empty.mkdir(parents=True)
    assert wizard_asset_hash(FSRef(empty)) == 0.0
