"""The entity-id policy, enforced rather than reviewed.

UUID v4 is the entity id; v5 exists only for read-only assets whose file IS the record, and
every id is minted through ``mint_uuid``. "Never invent a new deterministic id" is the rule
that review alone kept — until now. Two halves:

* a static half — ``uuid5(`` call sites are frozen and may only shrink (AST walk, so a
  docstring never counts);
* a live half — the minter and the adoption gate behave as the policy says.
"""

from __future__ import annotations

import ast
import uuid
from collections import Counter
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import adopt_entity_id, is_valid_entity_id, mint_uuid

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ROOT = Path(__file__).resolve().parents[2] / "flow_sdk"
SKIP = ("server/static/", "rust/tests/")

#: file → number of ``uuid5(`` calls it may carry. ``identifier.py`` is the minter itself;
#: ``machine_id.py`` derives the two machine-scoped singleton ids; ``fs_record.py`` is the
#: record-side fallback the minter documents; the invitation preview in
#: ``flow_message_action.py`` is a synthetic row id and is flagged for removal.
ALLOWLIST: dict[str, int] = {
    "api/api_types/identifier.py": 1,
    "app/actions/flow_message_action.py": 1,
    "fs_store/fs_record.py": 1,
    "utils/machine_id.py": 2,
}


def _is_uuid5(call: ast.Call) -> bool:
    func = call.func
    return (isinstance(func, ast.Attribute) and func.attr == "uuid5") or (
        isinstance(func, ast.Name) and func.id == "uuid5"
    )


def uuid5_call_sites() -> Counter:
    found: Counter = Counter()
    for path in sorted(ROOT.rglob("*.py")):
        rel = path.relative_to(ROOT).as_posix()
        if rel.startswith(SKIP):
            continue
        text = path.read_text(encoding="utf-8")
        if "uuid5(" not in text:
            continue
        tree = ast.parse(text, filename=rel)
        found[rel] += sum(isinstance(n, ast.Call) and _is_uuid5(n) for n in ast.walk(tree))
    return +found


def test_uuid5_call_sites_only_shrink():
    actual = uuid5_call_sites()
    grown = {f: (n, ALLOWLIST.get(f, 0)) for f, n in actual.items() if n > ALLOWLIST.get(f, 0)}
    assert not grown, f"new uuid5() sites (file: found, allowed): {grown} — look the row up by its natural key instead"
    stale = {f for f in ALLOWLIST if f not in actual}
    assert not stale, f"sites gone; delete them from ALLOWLIST: {sorted(stale)}"


def test_the_minter_is_v4_without_a_key_and_v5_with_one():
    assert uuid.UUID(mint_uuid()).version == 4
    assert uuid.UUID(mint_uuid("stable/key")).version == 5
    assert mint_uuid("stable/key") == mint_uuid("stable/key")


@pytest.mark.parametrize("version", [1, 3, 7, 8])
def test_only_v4_and_v5_are_entity_ids(version):
    h = uuid.uuid4().hex
    foreign = str(uuid.UUID(hex=h[:12] + str(version) + h[13:]))  # the version nibble is hex digit 13
    assert not is_valid_entity_id(foreign)
    assert adopt_entity_id(foreign) is None
    assert adopt_entity_id(f"  {mint_uuid()}  ") is not None
