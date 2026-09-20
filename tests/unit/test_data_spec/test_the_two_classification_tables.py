"""``FieldKind`` and ``Placement`` — what the two tables actually say.

Two enums classify a field: ``fs_store/serializer/fields.py``'s ``FieldKind``
(what the ENTITY serializer must do with it) and ``data_spec/io``'s
``Placement`` (where the io walker puts it on disk). The cleanup list carried
them as "one table pretending to be two", and ``placement.py`` said ``FieldKind``
"answers the same question".

**It does not, and this file is the measurement.** Over every registered asset
spec, every entity, and every nested ``DataSpec`` reachable from them, neither
enum determines the other: ``SCALAR`` maps to three placements and ``DIR_LIST``
to two kinds. They ask different questions —

* ``FieldKind`` — *can a serializer hold this as JSON?* A list of nested value
  shapes still can, so it is ``SCALAR``.
* ``Placement`` — *where does it land?* A list of shapes is a DIRECTORY.

So they cannot be derived from one another, and the fields where they differ
are not drift — they are the reason ``io/`` is not the asset writer: it would
explode an inline list or dict into a directory tree.

What CAN be pinned is the relationship itself. These tests fail when a new
(kind, placement) pair appears, which is the moment someone has to decide
whether the two walkers still agree about a field.
"""
from __future__ import annotations

import collections
import importlib
import pkgutil

import pytest

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.fs_store.serializer.fields import field_persistence, unwrap_annotation
from flow_sdk.schema.data_spec import DataSpec
from flow_sdk.schema.data_spec.io.placement import is_document, placement_of

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

#: Kept honest by `test_no_package_outside_this_list_declares_a_shape`.
SHAPE_PACKAGES = (
    "flow_sdk.assets",
    "flow_sdk.blocks",
    "flow_sdk.builtin",
    "flow_sdk.core",
    "flow_sdk.db",
    "flow_sdk.schema",
    "flow_sdk.secrets",
    "flow_sdk.sources",
)


def _every_shape() -> list[type]:
    """Every registered spec and entity, plus every ``DataSpec`` under them.

    A partial import gives a partial registry, and a partial registry gives a
    table that looks cleaner than it is.
    """
    # Every package that DECLARES a `DataSpec`/`FrontMatter` subclass, so the
    # answer does not depend on which other test happened to import one first
    # (`flow_sdk.blocks.RunOutput.files` was reached only that way, and it
    # contributes a pair of its own). Not all of `flow_sdk`: importing it
    # wholesale starts an MCP server.
    for package in SHAPE_PACKAGES:
        module = importlib.import_module(package)
        for found in pkgutil.walk_packages(module.__path__, package + "."):
            try:
                importlib.import_module(found.name)
            except Exception:  # noqa: BLE001 — a module that cannot import declares nothing
                pass

    seen: list[type] = []
    done: set[type] = set()

    def walk(cls: type | None) -> None:
        if cls is None or cls in done:
            return
        if cls.__module__.startswith("tests."):
            return      # a fixture shape another test declared, not a shipped one
        done.add(cls)
        seen.append(cls)
        for field in getattr(cls, "model_fields", {}).values():
            core = unwrap_annotation(field.annotation)
            for candidate in [core, *(getattr(core, "__args__", ()) or ())]:
                if isinstance(candidate, type) and issubclass(candidate, DataSpec):
                    walk(candidate)

    for name in sorted(SchemaRegistry.get_all_types()):
        info = SchemaRegistry.get(name)
        if getattr(info, "asset_spec", None) is None:
            continue
        walk(info.asset_spec)
        walk(info.entity_cls)
    for subclass in DataSpec.__subclasses__():
        walk(subclass)
    return seen


#: Which fields produced each pair — so a new pair names itself.
_WHERE: dict = collections.defaultdict(list)


def _cross_tab() -> collections.Counter:
    pairs: collections.Counter = collections.Counter()
    _WHERE.clear()
    for cls in _every_shape():
        for name, field in getattr(cls, "model_fields", {}).items():
            annotation = field.rebuild_annotation()
            pair = (field_persistence(annotation).name, placement_of(annotation).name)
            pairs[pair] += 1
            _WHERE[pair].append(f"{cls.__module__}.{cls.__name__}.{name}")
    return pairs


#: Every (FieldKind, Placement) pair that occurs. A new pair means a field was
#: declared in a shape the two walkers classify differently than any before it.
EXPECTED_PAIRS = {
    ("SCALAR", "INLINE"),            # the overwhelming majority: a plain value
    ("BODY", "BODY"),                # a `Text` field — the one true bijection
    ("FREE_SECTION", "FREE_SECTION"),  # the other one
    ("SCALAR", "DIR_LIST"),          # a list of shapes: JSON-able, but io explodes it
    ("SCALAR", "DIR_DICT"),          # a dict of shapes: same
    ("ROWS", "DIR_LIST"),            # `Dataset.examples` — the single ROWS field
    ("FILE_REF", "DIR_LIST"),        # a `list[FileRef]`: one path to the entity
                                     # serializer, a directory to the io walker
}


def test_the_two_tables_produce_only_the_pairs_we_have_accounted_for():
    pairs = _cross_tab()
    extra = {p: _WHERE[p][:4] for p in set(pairs) - EXPECTED_PAIRS}
    assert not extra, f"new (FieldKind, Placement) pair(s): {extra}"
    assert set(pairs) == EXPECTED_PAIRS


def test_neither_table_determines_the_other():
    """The claim this file exists to pin: they are not one table.

    If this ever starts failing, one enum HAS become derivable from the other
    and the duplication is real — which is the day to collapse them.
    """
    pairs = _cross_tab()
    by_kind: dict[str, set[str]] = collections.defaultdict(set)
    by_placement: dict[str, set[str]] = collections.defaultdict(set)
    for kind, placement in pairs:
        by_kind[kind].add(placement)
        by_placement[placement].add(kind)

    assert by_kind["SCALAR"] == {"INLINE", "DIR_LIST", "DIR_DICT"}
    assert by_placement["DIR_LIST"] == {"SCALAR", "ROWS", "FILE_REF"}


def test_a_list_or_dict_of_shapes_is_where_the_two_walkers_part():
    """Name the divergence rather than leave it as a count.

    These are the fields ``io.write`` would write as a directory tree and the
    asset writer keeps inline — plan divergence #10, measured.
    """
    pairs = _cross_tab()
    divergent = pairs[("SCALAR", "DIR_LIST")] + pairs[("SCALAR", "DIR_DICT")]
    agreeing = pairs[("SCALAR", "INLINE")] + pairs[("BODY", "BODY")] + pairs[("FREE_SECTION", "FREE_SECTION")]
    assert divergent > 0 and agreeing > divergent * 10, (
        f"{divergent} fields placed differently by the two walkers, {agreeing} the same"
    )


def test_an_entity_document_is_always_a_document_but_not_the_reverse():
    """The other pair of predicates the comments conflated.

    ``TypeInfo.is_entity_document`` is a DECLARED format choice (this type keeps
    its fields in ``<type>.json`` with the body beside it). ``is_document`` is a
    STRUCTURAL fact about a shape (it has content, so it is a file). Every
    entity document is a document; most documents are not entity documents —
    measured at 3 of 11 — so they are not interchangeable.
    """
    entity_documents, documents = set(), set()
    for name in sorted(SchemaRegistry.get_all_types()):
        info = SchemaRegistry.get(name)
        if getattr(info, "asset_spec", None) is None:
            continue
        if info.is_entity_document:
            entity_documents.add(name)
        if is_document(info.asset_spec):
            documents.add(name)

    assert entity_documents <= documents, sorted(entity_documents - documents)
    assert len(documents) > len(entity_documents), "the two predicates have collapsed into one"


def test_no_package_outside_this_list_declares_a_shape():
    """``SHAPE_PACKAGES`` is hand-written, so it needs a way to go wrong loudly.

    A shape declared in a package nobody imports here is invisible to the
    cross-tab, and the table above would then be a statement about whichever
    tests ran first rather than about the codebase.
    """
    import re
    from pathlib import Path

    root = Path(__file__).resolve().parents[3] / "flow_sdk"
    declares = re.compile(r"^class \w+\((?:DataSpec|FrontMatter)\b", re.M)
    found = {
        f"flow_sdk.{path.relative_to(root).parts[0]}"
        for path in root.rglob("*.py")
        if len(path.relative_to(root).parts) > 1 and declares.search(path.read_text(encoding="utf-8", errors="ignore"))
    }
    assert found <= set(SHAPE_PACKAGES), sorted(found - set(SHAPE_PACKAGES))
