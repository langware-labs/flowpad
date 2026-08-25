"""``Datum`` — the tree contract.

The model is deliberately tiny, so what needs pinning is not the fields but the
three rules that make it a tree rather than a bag: one arm per node, kind adopted
through the one tag grammar, and position as the join key between a contract and
its datum.
"""
from __future__ import annotations

import pytest

from flow_sdk.schema.datum import Datum

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


def test_one_arm_only_is_enforced() -> None:
    """A node carrying more than one expansion has competing readings, and every
    consumer would have to pick one. Raw-beside-parsed is the tempting case; it
    belongs in two sibling leaves."""
    Datum(fields={"a": Datum(value=1)})   # named children
    Datum(items=[Datum(value=1)])         # ordered elements
    Datum(value=1)                        # a value
    Datum()                               # none — opaque, legal
    for bad in (
        dict(fields={"a": Datum(value=1)}, value=2),
        dict(fields={"a": Datum(value=1)}, items=[Datum()]),
        dict(items=[Datum()], value=2),
    ):
        with pytest.raises(ValueError):
            Datum(**bad)


def test_kind_is_adopted_through_the_tag_grammar() -> None:
    """Reads (``kind_matches``) are strict, so a raw kind stored here would raise
    later at a point that cannot explain itself. Normalize at the write."""
    assert Datum(kind="  Content.File  ").kind == "content.file"
    assert Datum().kind is None
    for bad in ("Not A Kind!", "content..file", "content.--ns--.x"):
        with pytest.raises(ValueError):
            Datum(kind=bad)


def test_position_joins_a_contract_to_its_datum() -> None:
    """The same tree with empty leaves is a contract; with populated leaves it is
    the datum. They join by PATH, which is what makes comparing a produced value
    against an expected one a structural walk rather than a schema negotiation."""
    contract = Datum(fields={"category": Datum(kind="string"), "score": Datum(kind="float")})
    datum = Datum(fields={"category": Datum(value="invoice"), "score": Datum(value=0.9)})
    assert [p for p, _ in contract.leaves()] == [p for p, _ in datum.leaves()]
    assert dict(datum.leaves())[("category",)].value == "invoice"


def test_leaves_are_depth_first_paths() -> None:
    tree = Datum(fields={
        "input": Datum(value="input.pdf"),
        "gt": Datum(fields={"grade.json": Datum(value="gt/grade.json")}),
    })
    assert [("/".join(map(str, p)), n.value) for p, n in tree.leaves()] == [
        ("input", "input.pdf"),
        ("gt/grade.json", "gt/grade.json"),
    ]
    assert tree.is_leaf is False
    assert tree.fields["gt"].fields["grade.json"].is_leaf is True


def test_items_is_repetition_and_paths_carry_the_index() -> None:
    """Repetition is an ordered arm, not a list stuffed into `value`.

    A list inside `value` is opaque to `leaves()`, so a contract describing one
    could never join to an instance containing one. With `items` both sides
    expand and the path carries the position.
    """
    contract = Datum(kind="array", items=[Datum(kind="string")])
    datum = Datum(kind="array", items=[Datum(value="a@x"), Datum(value="b@y")])

    assert [p for p, _ in contract.leaves()] == [(0,)]
    assert [(p, n.value) for p, n in datum.leaves()] == [((0,), "a@x"), ((1,), "b@y")]
    assert contract.is_leaf is False        # is_leaf now considers `items`

    # Any length is legal on EITHER side: nothing here can tell a contract from
    # a datum, so a one-element validator would reject a single-element instance.
    Datum(kind="array", items=[Datum(value=c) for c in "abc"])


def test_items_nests_under_fields() -> None:
    """A path mixes string and integer segments: ("output", 0, "category")."""
    tree = Datum(fields={
        "output": Datum(items=[
            Datum(fields={"category": Datum(value="invoice")}),
            Datum(fields={"category": Datum(value="receipt")}),
        ]),
    })
    assert [p for p, _ in tree.leaves()] == [
        ("output", 0, "category"),
        ("output", 1, "category"),
    ]
