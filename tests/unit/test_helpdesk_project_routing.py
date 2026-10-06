"""Project-scoped helpdesk routing shared by portal and ticket actions."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.app.actions import helpdesk_action as hda
from flow_sdk.app.actions.flow_message_action import HelpdeskTarget
from flow_sdk.app.helpdesk_resolver import resolve_adopted_helpdesk
from flow_sdk.builtin.helpdesk import Helpdesk
from flow_sdk.builtin.project import Project
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.responses.response import ApiResponseStatus
from tests.unit._project_deps import link_context_dirs
from tests.unit._project_names import unique_project_name

ROOT_QUEUE = "00000000-0000-4000-8000-000000000001"
FIRST_CONTEXT_QUEUE = "00000000-0000-4000-8000-000000000002"
SECOND_CONTEXT_QUEUE = "00000000-0000-4000-8000-000000000003"
DEFAULT_QUEUE = "00000000-0000-4000-8000-000000000004"


def _request_info(body: dict) -> SimpleNamespace:
    return SimpleNamespace(
        someone_typeid="user-aaaaaaaa-0000-4000-8000-000000000001",
        get_post_data=AsyncMock(return_value=body),
    )


async def _project(root: Path, *, contexts: list[Path] | None = None) -> Project:
    root.mkdir(parents=True, exist_ok=True)
    project = Project(name=unique_project_name(root.name), fs_storage_mount_path=str(root))
    await project.save()
    # Context roots are flow.json dependencies, in declaration order.
    await link_context_dirs(project, contexts or [])
    return project


async def _routed_to(project_id: str, text: str) -> Optional[str]:
    """The desk queue a ticket filed from ``project_id`` is captured for (``ask-for-help``)."""
    from flow_sdk.app.actions import ask_for_help_action as afh
    from flow_sdk.builtin.conversation import Conversation

    request = _request_info({"recipient": {"kind": "desk"}, "text": text, "project_id": project_id})
    with (
        patch.object(afh, "get_current_request_info", return_value=request),
        patch.object(Conversation, "deliver", AsyncMock()),
        patch.object(Conversation, "kick_delivery", lambda *_a, **_k: None),
    ):
        response = await afh.ask_for_help()
    conv = await Conversation.get_one({"id": response.data["conversation_id"]})
    return conv.remote_project_id


async def _desk(root: Path, name: str, queue_id: str) -> Helpdesk:
    desk_dir = root / "agentic-assets" / "helpdesk" / name
    desk_dir.mkdir(parents=True, exist_ok=True)
    (desk_dir / "helpdesk.json").write_text(
        json.dumps({"display_name": name, "desk_project_id": queue_id}),
        encoding="utf-8",
    )
    desk = Helpdesk(name=name, asset_ref=str(desk_dir))
    await desk.save()
    return desk


@pytest.mark.asyncio
async def test_start_ticket_posts_to_target_projects_adopted_queue(tmp_path: Path) -> None:
    target = await _project(tmp_path / "customer")
    await _desk(tmp_path / "customer", "cloudnsite", ROOT_QUEUE)
    with patch.object(fma, "_hub_default_helpdesk", AsyncMock()) as fallback:
        assert await _routed_to(target.id, "Need help") == ROOT_QUEUE
    fallback.assert_not_awaited()


@pytest.mark.asyncio
async def test_desk_attached_by_path_still_routes_without_a_project_of_its_own(
    tmp_path: Path,
) -> None:
    """A desk adopted by PATH — no Project projection of its own — must route.

    Every other case here makes the context root a Project, because the git
    attach flow happens to mint one. Attaching the same folder by path does
    not, and resolution used to require it: it returned None, the ticket fell
    through to the hub's DEFAULT desk, and nothing said so. A customer who
    adopted a vendor's desk had their support request delivered to a different
    company, silently. That is the failure this pins.
    """
    context_root = tmp_path / "vendor-desk"
    context_root.mkdir(parents=True, exist_ok=True)
    await _desk(context_root, "cloudnsite", FIRST_CONTEXT_QUEUE)
    # Deliberately NO `_project(context_root)` — that is the whole point.
    target = await _project(tmp_path / "customer", contexts=[context_root])

    adopted = await resolve_adopted_helpdesk(target.id)
    assert adopted is not None, "a desk attached by path must still be adopted"
    assert adopted.queue_project_id == FIRST_CONTEXT_QUEUE
    # The portal has no Project to open, and that is allowed to be absent —
    # it must not take the queue down with it.
    assert adopted.portal_project_id is None

    with patch.object(fma, "_hub_default_helpdesk", AsyncMock()) as fallback:
        assert await _routed_to(target.id, "Need help") == FIRST_CONTEXT_QUEUE
    fallback.assert_not_awaited(), "must not fall through to somebody else's desk"


@pytest.mark.asyncio
async def test_a_desk_naming_no_usable_queue_says_so_before_falling_through(
    tmp_path: Path, caplog
) -> None:
    """The other half of the silent misroute: an adopted desk with a broken
    manifest. Falling back to the default desk is correct, but it must be
    diagnosable — otherwise it is indistinguishable from "no desk adopted"."""
    context_root = tmp_path / "vendor-desk"
    await _project(context_root)
    await _desk(context_root, "cloudnsite", "not-a-uuid")
    target = await _project(tmp_path / "customer", contexts=[context_root])

    with caplog.at_level("WARNING"):
        adopted = await resolve_adopted_helpdesk(target.id)

    assert adopted is None
    assert any("no valid desk_project_id" in r.getMessage() for r in caplog.records), (
        "an unusable adopted desk must be logged, not silently skipped"
    )


@pytest.mark.asyncio
async def test_ticket_list_uses_direct_context_order_not_desk_row_order(tmp_path: Path) -> None:
    first_root = tmp_path / "first-context"
    second_root = tmp_path / "second-context"
    await _project(first_root)
    await _project(second_root)
    # Save in the opposite order to prove DB row order cannot choose the desk.
    await _desk(second_root, "a-second-row", SECOND_CONTEXT_QUEUE)
    await _desk(first_root, "z-first-context", FIRST_CONTEXT_QUEUE)
    target = await _project(tmp_path / "customer", contexts=[first_root, second_root])
    hub = AsyncMock(return_value=[])

    with (
        patch.object(
            fma,
            "get_current_request_info",
            return_value=_request_info({"project_id": target.id}),
        ),
        patch.object(fma, "_hub_default_helpdesk", AsyncMock()) as fallback,
        patch.object(fma, "hub_request", hub),
    ):
        response = await fma.helpdesk_tickets_list()

    assert response.status == ApiResponseStatus.SUCCESS.value
    assert response.data["project_id"] == FIRST_CONTEXT_QUEUE
    hub.assert_awaited_once_with("GET", BuiltinEntityType.PROJECT, FIRST_CONTEXT_QUEUE, "helpdesk_conversations")
    fallback.assert_not_awaited()


@pytest.mark.asyncio
async def test_target_root_precedes_direct_context_roots_for_portal_ensure(tmp_path: Path) -> None:
    context_root = tmp_path / "context"
    await _project(context_root)
    await _desk(context_root, "context-desk", FIRST_CONTEXT_QUEUE)
    target_root = tmp_path / "customer"
    target = await _project(target_root, contexts=[context_root])
    await _desk(target_root, "target-desk", ROOT_QUEUE)

    with (
        patch.object(hda, "get_current_request_info", return_value=_request_info({})),
        patch.object(hda, "_require_target", AsyncMock()) as fallback,
    ):
        response = await hda.helpdesk_ensure(target.id)

    assert response.status == ApiResponseStatus.SUCCESS.value
    assert response.data["helpdesk_project_id"] == ROOT_QUEUE
    assert response.data["project_id"] == target.id
    assert response.data["mount_path"] == str(target_root)
    assert response.data["adopted"] is True
    fallback.assert_not_awaited()


@pytest.mark.asyncio
async def test_same_root_uses_canonical_path_then_id_as_stable_tiebreaker(tmp_path: Path) -> None:
    root = tmp_path / "customer"
    target = await _project(root)
    await _desk(root, "z-desk", SECOND_CONTEXT_QUEUE)
    await _desk(root, "a-desk", ROOT_QUEUE)

    adopted = await resolve_adopted_helpdesk(target.id)

    assert adopted is not None
    assert adopted.queue_project_id == ROOT_QUEUE


@pytest.mark.asyncio
async def test_valid_project_without_desk_goes_to_the_hubs_default_queue(tmp_path: Path) -> None:
    """No desk of its own: the hub's default one — the last one it advertised, so even a ticket
    typed offline is addressed; with none known yet it is resolved when delivered."""
    target = await _project(tmp_path / "customer")
    default = HelpdeskTarget(DEFAULT_QUEUE, None)

    with patch.object(fma, "_last_known_desk", return_value=default):
        assert await _routed_to(target.id, "Fallback request") == DEFAULT_QUEUE
    with patch.object(fma, "_last_known_desk", return_value=None):
        assert await _routed_to(target.id, "Fallback request") is None  # resolved at delivery
    with patch.object(fma, "_hub_default_helpdesk", AsyncMock(return_value=default)):
        assert (await fma.resolve_helpdesk(target.id)) == default
