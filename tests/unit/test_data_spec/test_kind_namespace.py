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
from pydantic import BaseModel

from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.spec import Tagged
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


# ── the ROUND TRIP: what is written is what is registered ────────────────────


class _Holder(BaseModel):
    """A row-shaped carrier: ``SourceItem.data`` is exactly this."""

    data: Tagged[DataSpec]


def test_an_externally_minted_value_reads_back_as_its_own_class() -> None:
    """The bug this file exists for, end to end.

    Registration qualified the kind and the dump did not, so an authored asset wrote
    values that nothing could restore — not even the class that minted them, in the
    same process. It cost 252 rows and a 500 on the list that held them.
    """
    with loading("acme"):

        class Quake(DataSpec):
            spec_kind: ClassVar[str] = "demo.quake"

            place: str = ""

    dumped = _Holder(data=Quake(place="Karluk")).model_dump()
    assert dumped["data"]["spec_kind"] == "--acme--.demo.quake", "the tag written is the key registered"
    assert isinstance(_Holder.model_validate(dumped).data, Quake)


def test_ours_still_writes_the_bare_kind() -> None:
    """The default is silent on the WIRE too — no shipped row gains a marker."""

    class Ours(DataSpec):
        spec_kind: ClassVar[str] = "demo.ours"

    assert _Holder(data=Ours()).model_dump()["data"]["spec_kind"] == "demo.ours"


def test_the_stamp_is_class_metadata_not_a_field() -> None:
    """Same rule as ``spec_kind``: a value's fields are the author's, not ours."""
    with loading("acme"):

        class Stamped(DataSpec):
            spec_kind: ClassVar[str] = "demo.stamped"

    assert "__spec_tag__" not in Stamped.model_fields
    assert Stamped.__spec_tag__ == "--acme--.demo.stamped"
    assert Stamped.spec_kind == "demo.stamped", "the author's declaration is never rewritten"


def test_a_subclass_naming_no_kind_keeps_its_parents_tag() -> None:
    """It inherits ``spec_kind``; it must inherit what that dumps as, or the pair
    disagrees and the narrower class writes a tag it is not registered under."""
    with loading("acme"):

        class Parent(DataSpec):
            spec_kind: ClassVar[str] = "demo.parent"

        class Child(Parent):
            extra: str = ""

    assert Child.__spec_tag__ == Parent.__spec_tag__ == "--acme--.demo.parent"
    assert _Holder(data=Child()).model_dump()["data"]["spec_kind"] == "--acme--.demo.parent"


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


# ── the invariant, frozen ────────────────────────────────────────────────────


def test_every_tag_writer_goes_through_spec_tag() -> None:
    """A tag put on the wire is the name the class is REGISTERED under.

    The bug was one writer spelling it `value.spec_kind`, which is the author's bare
    declaration. Three more writers spelled it the same way and kept the hole open in
    protocols, in the authoring form, and in the migration that rewrites legacy rows.
    Freeze it by grep: `spec_kind` may be READ off a dict, never written from a class.
    """
    import ast
    from pathlib import Path

    root = Path(__file__).resolve().parents[3] / "flow_sdk"
    offenders: list[str] = []
    for path in root.rglob("*.py"):
        if "system_projects" in path.parts or "server/static" in str(path):
            continue
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            # `{"spec_kind": <expr>.spec_kind, ...}` — a tag written from an attribute.
            if not isinstance(node, ast.Dict):
                continue
            for key, value in zip(node.keys, node.values):
                names_tag = isinstance(key, ast.Constant) and key.value == "spec_kind"
                from_attr = isinstance(value, ast.Attribute) and value.attr == "spec_kind"
                if names_tag and from_attr:
                    offenders.append(f"{path.relative_to(root)}:{node.lineno}")

    assert offenders == [], (
        "write the REGISTERED name — `spec_tag(value)` — not the bare declaration: " + ", ".join(offenders)
    )
