"""A kind carries whose ontology it belongs to — and ours carries nothing.

An externally authored asset used to mint straight into our namespace: a
user-written ``whatsapp`` driver declared ``ingest.message.whatsapp``, the same
string the shipped one declares, and the last import silently won. Nothing in a
kind said whose it was.

The marker is the grammar's own ``--ns--`` first segment. Ours is the DEFAULT and
it is SILENT: a shipped kind is written bare, and the literal ``--flow--`` never
appears anywhere.

The loader DECLARES the namespace for the duration of the import that mints the
kinds. It is not discovered from the class's file — see the module docstring of
``_namespace.py`` for what that cost.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import ClassVar

import pytest

from flow_sdk.assets.project_manifest import namespace_for
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec._namespace import FLOW_NS, current, loading, qualified
from flow_sdk.tags.grammar import normalize_tag

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval


def test_ours_is_written_bare_and_never_as_the_marker() -> None:
    """The whole point of the default being silent."""
    assert qualified("ingest.message.slack") == "ingest.message.slack"
    assert qualified("ingest.message.slack", "") == "ingest.message.slack"
    assert qualified("ingest.message.slack", FLOW_NS) == "ingest.message.slack"


def test_someone_else_s_kind_carries_their_marker() -> None:
    assert qualified("ingest.message.slack", "acme") == "--acme--.ingest.message.slack"


def test_a_namespaced_kind_is_a_legal_tag() -> None:
    """The marker is the grammar's own, so a prefixed kind stays a valid tag —
    prefix matching, glob subscriptions and `tag_is_within` keep working."""
    assert normalize_tag(qualified("ingest.message.slack", "acme")) == "--acme--.ingest.message.slack"


def test_nothing_is_being_imported_by_default() -> None:
    assert current() == ""


def test_a_kind_minted_while_a_loader_declares_carries_that_namespace() -> None:
    """The mechanism in one line: an asset's classes register inside `loading`."""
    with loading("acme"):
        assert current() == "acme"

        class AcmeShape(DataSpec):
            spec_kind: ClassVar[str] = "demo.acme_shape"

    assert current() == "", "the declaration must not outlive the import"
    assert DataSpec.parse("--acme--.demo.acme_shape") is AcmeShape
    assert DataSpec.parse("demo.acme_shape") is not AcmeShape


def test_the_declaration_is_restored_even_when_the_import_raises() -> None:
    """A broken asset must not leave every later kind stamped with its name."""
    with pytest.raises(RuntimeError):
        with loading("acme"):
            raise RuntimeError("author's module blew up")
    assert current() == ""


# ── the project's declaration, resolved by the layer that owns manifests ──────

def _project(root: Path, ns: str | None) -> Path:
    manifest = root / "agentic-assets" / "project_manifest"
    manifest.mkdir(parents=True)
    body: dict = {"schema": 1, "entries": []}
    if ns is not None:
        body["ns"] = ns
    (manifest / "project_manifest.json").write_text(json.dumps(body), encoding="utf-8")
    return root


def test_a_project_declares_once_and_its_assets_inherit(tmp_path) -> None:
    """The rule that keeps `ns` out of every asset."""
    _project(tmp_path, "acme")
    asset = tmp_path / "agentic-assets" / "data_driver" / "whatsapp"
    asset.mkdir(parents=True)
    assert namespace_for(asset) == "acme"


def test_a_project_that_declares_nothing_is_ours(tmp_path) -> None:
    _project(tmp_path, None)
    assert namespace_for(tmp_path / "agentic-assets" / "data_driver") == ""


def test_a_folder_in_no_project_is_ours(tmp_path) -> None:
    """And crucially, asking does not go rummaging up through the user's home:
    the lookup stops at the first project root and answers from its manifest."""
    loose = tmp_path / "nowhere"
    loose.mkdir()
    assert namespace_for(loose) == ""
