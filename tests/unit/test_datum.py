"""``Datum`` — the tree contract.

The model is deliberately tiny, so what needs pinning is not the fields but the
three rules that make it a tree rather than a bag: branch-XOR-leaf, kind adopted
through the one tag grammar, and position as the join key between a contract and
its datum.
"""
from __future__ import annotations

import pytest

from flow_sdk.schema.datum import Datum

pytestmark = pytest.mark.timeout(5)  # do not increase without approval


def test_branch_xor_leaf_is_enforced() -> None:
    """A node carrying both an expansion and a value has two readings, and every
    consumer would have to pick one. Raw-beside-parsed is the tempting case; it
    belongs in two sibling leaves."""
    Datum(fields={"a": Datum(value=1)})   # branch
    Datum(value=1)                        # leaf
    Datum()                               # neither — opaque, legal
    with pytest.raises(ValueError):
        Datum(fields={"a": Datum(value=1)}, value=2)


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
    assert [("/".join(p), n.value) for p, n in tree.leaves()] == [
        ("input", "input.pdf"),
        ("gt/grade.json", "gt/grade.json"),
    ]
    assert tree.is_leaf is False
    assert tree.fields["gt"].fields["grade.json"].is_leaf is True
