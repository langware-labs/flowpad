"""Every shape in the tree can say what it looks like — or is one of a named few.

``to_authoring_form`` is the inverse of ``DataSpec.parse``, and §4's "round trip
is identity" quietly assumes it is total. It was not: **13 of 116** subclasses
raised, because ``Optional[str]`` had no form at all. That is invisible until
someone declares an ``output`` on a spec with an optional field.

This pins the gap shut and keeps the remainder HONEST: the classes that still
have no form are listed here with the reason, so the list can only shrink by
someone deciding a grammar question — never by accident.
"""
from __future__ import annotations

import re
from typing import Literal, Optional
from pathlib import Path

import pytest

from flow_sdk.schema.data_spec import DataSpec, to_authoring_form
from flow_sdk.schema.data_spec.spec import NoAuthoringForm

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

#: The reasons a shape can have no authoring form. Each is a GRAMMAR decision:
#: the three forms (a kind, an object, a one-element list) carry no keywords,
#: so none of these can be written down. Keyed by CAUSE rather than by class
#: name, so a new spec with an old problem is classified, not silently added.
KNOWN_CAUSES = (
    ("a map field — the grammar has no `{key: value}` form", re.compile(r"\bdict\b")),
    ("an unparametrized generic — its slots are TypeVars", re.compile(r"^~")),
    ("a genuine either/or union — no single shape", re.compile(r"^typing\.Union\[")),
    ("a fixed-length tuple — not a list of one shape", re.compile(r"^tuple\[")),
    ("an `Any` field — deliberately opaque, and the grammar has no word for it",
     re.compile(r"^typing\.Any$")),
)


def _cause(exc: NoAuthoringForm) -> "str | None":
    text = str(getattr(exc, "inner", "")) or str(exc)
    for reason, pattern in KNOWN_CAUSES:
        if pattern.search(text):
            return reason
    return None


def _subclasses(cls: type):
    for sub in cls.__subclasses__():
        yield sub
        yield from _subclasses(sub)


def test_optional_renders_as_the_shape_it_wraps():
    """Whether a value may be ABSENT is behaviour, not shape — and there is
    nowhere in a keyword-free grammar to put it."""
    assert to_authoring_form(Optional[str]) == "string"
    assert to_authoring_form(Optional[int]) == "int"


def test_a_path_a_literal_and_an_enum_are_all_just_text():
    """Each is a string on disk; WHICH strings is a validation rule, and the
    grammar deliberately carries no rules."""
    assert to_authoring_form(Path) == "string"
    assert to_authoring_form(Literal["a", "b"]) == "string"


def test_a_genuine_either_or_has_no_single_shape():
    with pytest.raises(NoAuthoringForm):
        to_authoring_form(Optional[dict])


def test_the_error_names_the_owner_not_only_the_inner_type():
    """The walk recurses into fields; an error naming only the inner type left
    a reader hunting for which spec contained it."""

    class Holder(DataSpec):
        bad: dict

    with pytest.raises(NoAuthoringForm, match="Holder"):
        to_authoring_form(Holder)


def test_every_spec_in_the_tree_has_an_authoring_form():
    """The 13 → 0 pin, modulo the named few above."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry

    SchemaRegistry._ensure_loaded()
    unexplained = []
    for spec in set(_subclasses(DataSpec)):
        if spec.__module__.startswith("test") or "<locals>" in spec.__qualname__:
            continue   # a probe defined by another test, not a shape in the tree
        try:
            to_authoring_form(spec)
        except NoAuthoringForm as exc:
            if _cause(exc) is None:
                unexplained.append(f"{spec.__name__}: {exc}")
    assert not unexplained, (
        "these shapes cannot say what they look like, for no known reason:\n  "
        + "\n  ".join(sorted(unexplained))
    )
