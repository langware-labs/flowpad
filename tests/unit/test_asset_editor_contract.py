"""Asset-editor vocabulary — Python side of the cross-language contract.

tests/fixtures/asset_editor_contract.json is ALSO parsed by
ui/tests/unit/asset-editor-contract.test.ts. The two suites pin one editor
vocabulary, one type → editor mapping and one extension routing, so a backend
deep link (`flow record url`) and a frontend dock pointer cannot drift apart.
Change the fixture only with both suites in hand.
"""

import json
from pathlib import Path

import pytest

from flow_sdk.core.asset_editor import EDITOR_TYPES, TYPE_TO_EDITOR, AssetEditor, editor_for_type
from flow_sdk.core.display_target import DisplayTargetKind, dock_url
from flow_sdk.schema.types import EntityType

CONTRACT = json.loads((Path(__file__).parent.parent / "fixtures" / "asset_editor_contract.json").read_text())


def test_editor_names_match_the_contract():
    """The `<editor>` URL segment vocabulary, in order."""
    assert [e.value for e in AssetEditor] == CONTRACT["editors"]


def test_editor_types_match_the_contract():
    actual = {e.value: [str(t) for t in types] for e, types in EDITOR_TYPES.items()}
    assert actual == CONTRACT["editor_types"]


def test_derived_inverse_matches_the_contract():
    """The inversion is behaviour each language implements on its own, so the
    derived map is pinned as well as the forward one — that is what catches a
    type accidentally claimed by two editors."""
    assert {t: e.value for t, e in TYPE_TO_EDITOR.items()} == CONTRACT["type_to_editor"]


@pytest.mark.parametrize("type_name", CONTRACT["no_editor_types"])
def test_types_without_an_asset_editor(type_name):
    """None is a real answer. A shell or a project is not a document, and the
    caller must say so rather than invent a URL segment."""
    assert editor_for_type(type_name) is None


@pytest.mark.parametrize("case", CONTRACT["url_cases"], ids=lambda c: c["type"])
def test_dock_url_builds_the_contract_pointer(case):
    """The URL grammar itself, crossing the language boundary.

    The TS suite asserts `assetEditorPointer` produces the same `pointer` from
    the same fixture row, so this is what stops a backend-printed link and a
    clicked entity from landing in different places.
    """
    target = {"kind": DisplayTargetKind.ENTITY, "type": case["type"], "typeid": case["typeid"]}
    assert dock_url(target, port=4098) == f"http://localhost:4098/dock/{case['pointer']}"


def test_every_mapped_type_is_a_registered_entity_type():
    """The one assertion only this side can make. The TS map is plain strings;
    here a row that names a type the backend does not know is a real bug —
    `flow record url` would happily build a link to nothing."""
    known = {e.value for e in EntityType}
    unknown = sorted(set(TYPE_TO_EDITOR) - known)
    assert not unknown, f"not registered in EntityType: {unknown}"
