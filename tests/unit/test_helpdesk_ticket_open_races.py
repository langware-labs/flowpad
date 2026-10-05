"""Two failures the support-ticket stress run found (2026-10-05), on their real seams.

1. A ticket opened here is materialized twice at once: the ticket action creates the
   titled row (``ensure_conversation_entity``) while the hub pushes the same new conversation
   back (``HubWsBridge._handle_conversation_op``). Both read "no row" and save a whole one; the
   hub's (untitled) landed last — 1 in 5 tickets lost their title.
2. A desk declared in the project is a row only after the project's first index, which runs
   detached on open. A ticket filed before it lands read no desk and went, silently, to the
   hub's default one.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.app.actions.flow_message_action import resolve_helpdesk
from flow_sdk.app.actions.materialize_flow_message import ensure_conversation_entity
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.helpdesk import Helpdesk
from flow_sdk.builtin.project import Project
from flow_sdk.cloud_client.hub_bridge import HubWsBridge
from tests.unit._project_names import unique_project_name

DESK = "00000000-0000-4000-8000-0000000000d1"


async def _hub_push_after(yields: int, conv_id: str, hub_row: dict) -> None:
    """The hub's push, arriving ``yields`` event-loop turns into the local open."""
    for _ in range(yields):
        await asyncio.sleep(0)
    await HubWsBridge()._handle_conversation_op("create", conv_id, hub_row)


@pytest.mark.asyncio
async def test_the_hubs_push_of_a_ticket_opened_here_keeps_its_title():
    # Where the push lands inside the open is the hub's timing, not ours: cover every turn.
    lost = []
    for yields in range(20):
        conv_id = mint_uuid()
        hub_row = {"id": conv_id, "kind": "helpdesk", "status": "open", "remote_project_id": DESK, "title": None}
        await asyncio.gather(
            ensure_conversation_entity(conv_id, None, remote_project_id=DESK, title="My build fails", remote=True),
            _hub_push_after(yields, conv_id, hub_row),
        )
        if (await Conversation.get_one({"id": conv_id})).title != "My build fails":
            lost.append(yields)

    assert lost == [], f"title lost when the hub's push landed {lost} turns into the open"


@pytest.mark.asyncio
async def test_a_ticket_filed_before_the_first_index_goes_to_the_declared_desk(tmp_path: Path):
    root = tmp_path / "customer"
    desk_dir = root / "agentic-assets" / "helpdesk" / "acme"
    desk_dir.mkdir(parents=True)
    (desk_dir / "helpdesk.json").write_text(json.dumps({"display_name": "Acme", "desk_project_id": DESK}))
    project = await Project(name=unique_project_name("customer"), fs_storage_mount_path=str(root)).save()
    assert not [d for d in await Helpdesk.get_all() if d.asset_ref.startswith(str(root))], "not indexed yet"

    target = await resolve_helpdesk(project.id)

    assert target is not None and target.project_id == DESK
