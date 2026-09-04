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
    TokenPlanKind,
    ViewType,
    WebappSubview,
    can_be_tab,
    dock_url,
    normalize_retired,
    parse_dock_url,
    parse_view_type,
    suggest_views,
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
        (TokenPlanKind, "token-plan"),
    ],
    ids=["credentials", "web-app", "machine", "ai-config", "token-plan"],
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
        "agent",
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
    """The forward pointer must be a live subview, not a free string: a
    credentials target names a ``CredentialsSubview``; the assets target
    (``skills``) names an asset-list pointer."""
    target = CONTRACT["retired_views"][retired]
    if target["view_type"] == ViewType.CREDENTIALS.value:
        CredentialsSubview(target["pointer"])
    else:
        assert target["view_type"] == ViewType.ASSETS.value
        assert target["pointer"].startswith("list/")


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
    assert unaddressable == {
        # retired aliases, forwarded by RETIRED_DOCK_VIEWS
        "environment",
        "connections",
        "api-keys",
        # folded away
        "skills",
        "session",
        "atlas",
        # never built: no content-panel case and no VIEWER_REGISTRY row, so a dock
        # URL naming one renders the Home landing. They were advertised as
        # destinations for years and answered every request with the wrong screen.
        "analysis",
        "chat",
        "reasoning",
        "unsupported",
    }


def test_required_pointer_views_reject_an_empty_pointer():
    """The validation Phase 2's CLI leans on: `flow show view helpdesk` is an error."""
    required = [view for view, meta in VIEW_META.items() if meta.pointer is PointerRequirement.REQUIRED]
    assert ViewType.HELPDESK in required
    assert ViewType.CONVERSATION in required
    assert ViewType.EVENTS not in required
    # Verified rendering bare before the flip (see their VIEW_META rows); `helpdesk`
    # was checked the same way, did NOT render, and stays required.
    assert ViewType.ASSETS not in required
    assert ViewType.PROJECT not in required


# ── the agent-facing vocabulary (label / aliases) ──────────────────────────
#
# These exist because the vocabulary rotted once already, silently: nothing
# checked that every destination is findable by the name a person uses for it.
# See `docs/display-capabilities.md`.


def test_every_addressable_view_has_a_label():
    """A destination with no name is a slug an agent has to guess from."""
    unlabelled = sorted(
        view.value for view, meta in VIEW_META.items() if meta.addressable and not meta.label
    )
    assert unlabelled == []


def test_unaddressable_views_carry_no_vocabulary():
    """A view that is not a destination must not advertise itself as one."""
    for view, meta in VIEW_META.items():
        if not meta.addressable:
            assert meta.label == "", view
            assert meta.aliases == (), view


def test_aliases_are_a_tuple_of_strings():
    """A one-element tuple missing its trailing comma is a STRING, and iterating a
    string yields single characters — which then substring-match half the table.
    It is invisible at a glance and silently poisons every lookup, so it is
    asserted rather than trusted."""
    for view, meta in VIEW_META.items():
        assert isinstance(meta.aliases, tuple), f"{view.value}: aliases is not a tuple"
        for alias in meta.aliases:
            assert isinstance(alias, str) and len(alias) > 1, f"{view.value}: {alias!r}"


def test_an_alias_never_merely_restates_the_label():
    """The label is already matched, so a duplicate adds noise and no reach."""
    for view, meta in VIEW_META.items():
        assert meta.label.lower() not in meta.aliases, view.value


def test_aliases_are_normalized_and_unique():
    """One word, one destination — otherwise the vocabulary has two answers."""
    seen: dict[str, str] = {}
    for view, meta in VIEW_META.items():
        for alias in meta.aliases:
            assert alias == alias.lower().strip(), f"{view.value}: {alias!r} is not normalized"
            assert alias not in seen, f"{alias!r} claimed by both {seen[alias]} and {view.value}"
            seen[alias] = view.value


def test_an_alias_never_shadows_an_addressable_view():
    """One word, one screen. A retired slug as an alias is fine and deliberate —
    see the `ViewMeta` docstring; a LIVE view's slug never is."""
    addressable = {view.value for view, meta in VIEW_META.items() if meta.addressable}
    for view, meta in VIEW_META.items():
        for alias in meta.aliases:
            assert alias not in addressable, f"{view.value}: {alias!r} shadows a live view"


def test_retired_slugs_used_as_aliases_forward_to_the_aliasing_view():
    """The agreement above is asserted, not assumed."""
    slugs = {view.value: view for view in ViewType}
    for view, meta in VIEW_META.items():
        for alias in meta.aliases:
            retired = slugs.get(alias)
            if retired is None or VIEW_META[retired].addressable:
                continue
            forwarded, _ = normalize_retired(retired)
            assert forwarded is view, (
                f"{view.value} claims alias {alias!r}, but that slug forwards to {forwarded.value}"
            )


def test_pages_name_real_page_ids():
    pages = {page.value for page in PageId}
    for view, meta in VIEW_META.items():
        assert isinstance(meta.pages, tuple), f"{view.value}: pages is not a tuple"
        assert meta.pages, view
        assert set(meta.pages) <= pages, view


def test_suggest_views_finds_a_screen_by_the_word_a_person_uses():
    """The regression that started this: "connections" is the Credentials screen."""
    assert suggest_views("connections") == [ViewType.CREDENTIALS]
    assert suggest_views("secrets") == [ViewType.CREDENTIALS]
    assert suggest_views("files") == [ViewType.EXPLORER]
    assert suggest_views("runs") == [ViewType.PROCESS_RUNS]
    assert suggest_views("help desk") == [ViewType.HELPDESK]
    # Hyphen/underscore spelling of a label must not defeat the match.
    assert suggest_views("search-indexes")[0] is ViewType.RAG


def test_suggest_views_survives_a_misspelling():
    """A near-miss must not be a dead end — see `suggest_views`."""
    assert ViewType.CREDENTIALS in suggest_views("conections")
    assert suggest_views("credentails") == [ViewType.CREDENTIALS]
    assert suggest_views("serch indexes") == [ViewType.RAG]


def test_suggest_views_never_invents_a_match():
    assert suggest_views("nonsense") == []
    assert suggest_views("") == []
    assert suggest_views(None) == []


def test_suggest_views_only_offers_real_destinations():
    for token in ("connections", "environment", "api keys", "skills", "session"):
        for view in suggest_views(token):
            assert VIEW_META[view].addressable, f"{token!r} suggested a dead view"
