"""Project-scoped helpdesk routing shared by portal and ticket actions."""

from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions import flow_message_action as fma
from flow_sdk.app.actions import helpdesk_action as hda
from flow_sdk.app.actions.flow_message_action import HelpdeskTarget
from flow_sdk.app.helpdesk_resolver import resolve_adopted_helpdesk
from flow_sdk.builtin.helpdesk import Helpdesk
from flow_sdk.builtin.project import Project
from flow_sdk.responses.response import ApiResponseStatus

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
    project = Project(
        name=root.name,
        fs_storage_mount_path=str(root),
        legacy_include_dirs_=[str(path) for path in contexts or []],
    )
    await project.save()
    return project


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
    hub = AsyncMock(return_value={"status": "FAIL", "message": "stop after route assertion"})

    with (
        patch.object(
            fma,
            "get_current_request_info",
            return_value=_request_info(
                {
                    "text": "Need help",
                    "project_id": target.id,
                }
            ),
        ),
        patch.object(fma, "_hub_default_helpdesk", AsyncMock()) as fallback,
        patch.object(fma, "_hub_action", hub),
    ):
        response = await fma.helpdesk_start_ticket()

    assert response.status == ApiResponseStatus.FAIL.value
    # Route only. The body grows as tickets carry more context (project /
    # session ids, a transcript excerpt); pinning it whole here would make a
    # ROUTING test fail for a payload change it does not care about.
    method, path, body = hub.await_args.args
    assert (method, path) == ("POST", f"/graph/project/{ROOT_QUEUE}/start_guest_conversation")
    assert body["text"].startswith("Need help")
    fallback.assert_not_awaited()


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
    hub = AsyncMock(return_value={"status": "SUCCESS", "data": []})

    with (
        patch.object(
            fma,
            "get_current_request_info",
            return_value=_request_info({"project_id": target.id}),
        ),
        patch.object(fma, "_hub_default_helpdesk", AsyncMock()) as fallback,
        patch.object(fma, "_hub_action", hub),
    ):
        response = await fma.helpdesk_tickets_list()

    assert response.status == ApiResponseStatus.SUCCESS.value
    assert response.data["project_id"] == FIRST_CONTEXT_QUEUE
    hub.assert_awaited_once_with(
        "GET",
        f"/graph/project/{FIRST_CONTEXT_QUEUE}/helpdesk_conversations",
    )
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
async def test_valid_project_without_desk_posts_to_hub_default_queue(tmp_path: Path) -> None:
    target = await _project(tmp_path / "customer")
    default = HelpdeskTarget(DEFAULT_QUEUE, None)
    hub = AsyncMock(return_value={"status": "FAIL", "message": "stop after route assertion"})

    with (
        patch.object(
            fma,
            "get_current_request_info",
            return_value=_request_info(
                {
                    "text": "Fallback request",
                    "project_id": target.id,
                }
            ),
        ),
        patch.object(fma, "_hub_default_helpdesk", AsyncMock(return_value=default)) as fallback,
        patch.object(fma, "_hub_action", hub),
    ):
        await fma.helpdesk_start_ticket()

    fallback.assert_awaited_once_with()
    method, path, body = hub.await_args.args
    assert (method, path) == ("POST", f"/graph/project/{DEFAULT_QUEUE}/start_guest_conversation")
    assert body["text"].startswith("Fallback request")
