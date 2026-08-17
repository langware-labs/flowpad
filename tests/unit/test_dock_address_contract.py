"""Python half of the dock-address cross-language contract.

Asserts ``flow_sdk/core/dock_address.py`` against
``tests/fixtures/dock_address_contract.json``. The TypeScript half is
``ui/tests/unit/dock-address-contract.test.ts``; neither generates the fixture
(see its ``comment`` key and the module docstring in ``dock_address.py``).

Tests below the shared block are Python-EXCLUSIVE: checks this language can
make and TypeScript cannot, mirroring how ``test_asset_editor_contract.py``
additionally cross-checks the real ``EntityType`` registry.
"""

import json
from pathlib import Path

import pytest

from flow_sdk.core.dock_address import (
    RETIRED_DOCK_VIEWS,
    VIEW_META,
    AIConfigSubview,
    CredentialsSubview,
    Layout,
    MachineSubview,
    PageId,
    PointerRequirement,
    ViewType,
    WebappSubview,
    can_be_tab,
    dock_url,
    normalize_retired,
    parse_dock_url,
    parse_view_type,
)

CONTRACT = json.loads((Path(__file__).parent.parent / "fixtures" / "dock_address_contract.json").read_text())


def _case_id(case: dict) -> str:
    return case["name"]


def _build(case: dict) -> str:
    """Build the URL a ``url_cases`` row describes, applying fixture defaults."""
    return dock_url(
        ViewType(case["view_type"]),
        case.get("pointer"),
        case.get("options"),
        layout=Layout(case.get("layout", "dock")),
        page=PageId(case.get("page", "desk")),
        base=case.get("base", ""),
    )


# ── shared assertions — the TypeScript suite makes each of these too ───────


def test_layouts_match_the_contract():
    assert [layout.value for layout in Layout] == CONTRACT["layouts"]


def test_pages_match_the_contract():
    assert [page.value for page in PageId] == CONTRACT["pages"]
    assert PageId.DESK.value == CONTRACT["default_page"]


def test_view_type_vocabulary_matches_the_contract():
    """Order-sensitive: a member inserted mid-list is a deliberate fixture edit."""
    assert [view.value for view in ViewType] == CONTRACT["view_types"]


@pytest.mark.parametrize(
    "enum_cls, key",
    [
        (CredentialsSubview, "credentials"),
        (WebappSubview, "web-app"),
        (MachineSubview, "machine"),
        (AIConfigSubview, "ai-config"),
    ],
    ids=["credentials", "web-app", "machine", "ai-config"],
)
def test_subview_vocabularies_match_the_contract(enum_cls, key):
    assert [member.value for member in enum_cls] == CONTRACT["subview_vocabularies"][key]


def test_retirement_map_matches_the_contract():
    actual = {
        view.value: {"view_type": target.view_type.value, "pointer": target.pointer}
        for view, target in RETIRED_DOCK_VIEWS.items()
    }
    assert actual == CONTRACT["retired_views"]


@pytest.mark.parametrize("retired", sorted(CONTRACT["retired_views"]), ids=lambda name: name)
def test_normalize_retired_resolves_forward(retired):
    expected = CONTRACT["retired_views"][retired]
    view, pointer = normalize_retired(ViewType(retired), "ignored-by-the-replacement")
    assert view.value == expected["view_type"]
    assert pointer == expected["pointer"]


def test_normalize_retired_passes_live_views_through():
    assert normalize_retired(ViewType.EVENTS, "x") == (ViewType.EVENTS, "x")


def test_view_meta_covers_every_view_type():
    """A view added in TypeScript cannot land here unclassified."""
    assert set(VIEW_META) == set(ViewType)
    assert {view.value for view in VIEW_META} == set(CONTRACT["view_meta"])


@pytest.mark.parametrize("view", list(ViewType), ids=lambda v: v.value)
def test_view_meta_matches_the_contract(view):
    meta = VIEW_META[view]
    expected = CONTRACT["view_meta"][view.value]
    assert meta.addressable is expected["addressable"]
    assert meta.pointer.value == expected["pointer"]
    assert meta.folds_pointer is expected["folds_pointer"]
    assert meta.scope_keyed is expected["scope_keyed"]
    assert meta.chrome == expected["chrome"]


@pytest.mark.parametrize("case", CONTRACT["url_cases"], ids=_case_id)
def test_dock_url_builds_the_contract_url(case):
    assert _build(case) == case["url"]


@pytest.mark.parametrize("case", CONTRACT["url_cases"], ids=_case_id)
def test_parse_dock_url_round_trips_the_contract_url(case):
    parsed = parse_dock_url(case["url"])
    assert parsed is not None, f"failed to parse {case['url']}"
    assert parsed.view_type.value == case["view_type"]
    assert parsed.pointer == case.get("pointer")
    assert dict(parsed.options) == {k: v for k, v in (case.get("options") or {}).items()}
    assert parsed.layout.value == case.get("layout", "dock")
    assert parsed.page.value == case.get("page", "desk")
    assert parsed.base == case.get("base", "")


@pytest.mark.parametrize("case", CONTRACT["tab_identity_cases"], ids=_case_id)
def test_can_be_tab_matches_the_contract_null_ness(case):
    """Python pins only WHETHER there is a chip; the string is TypeScript's."""
    assert can_be_tab(ViewType(case["view_type"]), case.get("pointer")) is (case["tab_hash"] is not None)


# ── Python-exclusive: checks TypeScript cannot make ───────────────────────


def test_page_ids_never_collide_with_view_types():
    """The INVARIANT stated in view-types.ts but enforced nowhere.

    Parsing detects the page positionally, so a `ViewType` whose value equalled
    a `PageId` would make `/dock/<that view>` silently parse as a page segment.
    """
    assert {page.value for page in PageId} & {view.value for view in ViewType} == set()


def test_view_types_shadowing_a_real_entity_type_are_pinned():
    """`DockPointer.targetTypeId` falls back to `TypeId(viewType, pointer)`.

    Any ViewType whose STRING is also an EntityType therefore mints entity
    targets from a bare-id pointer. That is intended for the entity-backed
    views below and a bug for anything else, so the set is pinned. Only Python
    can check this — TypeScript has no EntityType registry.
    """
    from flow_sdk.schema.types import EntityType

    shadowing = {view.value for view in ViewType} & {entity.value for entity in EntityType}
    assert shadowing == {
        # Entity-backed views: the fallback is exactly what they want.
        "agentic_process",
        "conversation",
        "graph_context",
        "markdown",
        # People & teams. Its pointer IS an organization id, so minting
        # TypeId("organization", <id>) from a bare pointer is precisely the
        # intent — a deep link to one organization's roster.
        "organization",
        "plan",
        "project",
        "shell",
        "spec",
        # Coincidental collisions. `tag` and `helpdesk` take a NON-entity
        # pointer (`graph/<dot.name>` / `<projectId>/article/<path>`), and
        # `environment` is a retired alias, so none of them ever presents a
        # bare id for the fallback to mint from. Listed here so that stops
        # being true loudly rather than silently.
        "environment",
        "helpdesk",
        "tag",
    }


@pytest.mark.parametrize("retired", sorted(CONTRACT["retired_views"]), ids=lambda name: name)
def test_retirement_targets_name_a_real_subview(retired):
    """The forward pointer must be a live CredentialsSubview, not a free string."""
    CredentialsSubview(CONTRACT["retired_views"][retired]["pointer"])


def test_flow_data_view_type_is_the_dock_address_enum():
    """The test that stops the second Python echo from growing back.

    ``flow_data`` used to carry its own 15-member ViewType that had drifted
    (it held `trace`, which TypeScript never had). It is now a re-export.
    """
    from flow_sdk.core.flow.models.flow_data import ViewType as FlowDataViewType

    assert FlowDataViewType is ViewType


@pytest.mark.parametrize(
    "case",
    [c for c in CONTRACT["tab_identity_cases"] if c["tab_hash"] is not None],
    ids=_case_id,
)
def test_tab_pointer_view_type_round_trips(case):
    """`tab.py`'s stored-pointer decoder agrees with the contract vocabulary.

    This pins the backend's tab-pointer READER against the same fixture the
    TypeScript canonicalizer is pinned against — without duplicating the
    canonicalizer itself.
    """
    from flow_sdk.builtin.tab import _pointer_view_type

    assert _pointer_view_type(case["tab_hash"]) == ViewType(case["view_type"])


def test_parse_view_type_is_non_throwing():
    assert parse_view_type("events") is ViewType.EVENTS
    assert parse_view_type("no-such-view") is None
    assert parse_view_type("") is None
    assert parse_view_type(None) is None


def test_unaddressable_views_are_exactly_the_retired_and_folded_ones():
    """Decodable forever, but never offered as a destination."""
    unaddressable = {view.value for view, meta in VIEW_META.items() if not meta.addressable}
    assert unaddressable == {"environment", "connections", "api-keys", "skills", "session", "atlas"}


def test_required_pointer_views_reject_an_empty_pointer():
    """The validation Phase 2's CLI leans on: `flow show view helpdesk` is an error."""
    required = [view for view, meta in VIEW_META.items() if meta.pointer is PointerRequirement.REQUIRED]
    assert ViewType.HELPDESK in required
    assert ViewType.CONVERSATION in required
    assert ViewType.EVENTS not in required
