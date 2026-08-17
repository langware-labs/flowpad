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
from flow_sdk.core.display_target import DisplayTargetKind, dock_url, hub_asset_url
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
    assert dock_url(target, port=4098) == f"http://localhost:4098{case['path']}"


def test_every_mapped_type_is_a_registered_entity_type():
    """The one assertion only this side can make. The TS map is plain strings;
    here a row that names a type the backend does not know is a real bug —
    `flow record url` would happily build a link to nothing."""
    known = {e.value for e in EntityType}
    unknown = sorted(set(TYPE_TO_EDITOR) - known)
    assert not unknown, f"not registered in EntityType: {unknown}"


@pytest.mark.parametrize("case", CONTRACT["hub_url_cases"], ids=lambda c: c["type"])
def test_hub_asset_url_builds_the_contract_pointer(case):
    """The HUB grammar, crossing the language boundary.

    The TS suite asserts `hubProjectAssetDock` produces the same `path` from the
    same fixture row. The project rebase is the load-bearing part: a bare
    `/dock/assets/editor/...` on a hub-only server redirects to hub home, so an
    un-rebased link silently lands a reviewer on a home screen.
    """
    target = {"kind": DisplayTargetKind.ENTITY, "type": case["type"], "typeid": case["typeid"]}
    url = hub_asset_url(target, hub_origin="https://hub.example", project_id=case["project_id"])
    assert url == "https://hub.example" + case["path"]


def test_hub_asset_url_refuses_rather_than_guessing():
    entity = {"kind": DisplayTargetKind.ENTITY, "type": "markdown", "typeid": "markdown-x"}
    assert hub_asset_url(entity, hub_origin="", project_id="p") is None
    assert hub_asset_url(entity, hub_origin="https://h", project_id="") is None
    assert hub_asset_url({"kind": DisplayTargetKind.VFS}, hub_origin="https://h", project_id="p") is None
    shell = {"kind": DisplayTargetKind.ENTITY, "type": "shell", "typeid": "shell-x"}
    assert hub_asset_url(shell, hub_origin="https://h", project_id="p") is None


def test_hub_origin_trailing_slash_does_not_double_up():
    target = {"kind": DisplayTargetKind.ENTITY, "type": "markdown", "typeid": "markdown-1"}
    assert hub_asset_url(target, hub_origin="https://h/", project_id="p").startswith("https://h/dock/")
