"""Phase-1 gate tests for the generic tabs API (docs/tab-management.md Part 3 §4).

Locks:
  1. `tabs/list` ≡ `terminals/list` membership parity (the legacy shim and the
     unified endpoint share one membership truth).
  2. `tabs/open` / `tabs/close` flip the non-null `tabbed` membership flag;
     close on a non-terminal entity is clear-membership (entity survives).
  3. The permanent wire rule: removal rides `tabbed=false`, which SURVIVES the
     exclude_none encoding; a nulled field is stripped and can never signal.
  4. `visible` ↔ `tabbed` alias (one-release window): writes to either keep
     both in step; legacy rows carrying only `visible=true` load as members.
  5. `last_active_at` is epoch-ms with ISO-string tolerance (legacy rows).
  6. AgenticProcess owns its `tab_order` (base Entity) — it survives a
     save/reload round-trip with no `_prev_tab_order` context carry.

Entity-level direct calls (no HTTP) — same convention as
tests/unit/test_terminal_list_membership.py.
"""
import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import BackgroundTasks
from fastapi.encoders import jsonable_encoder

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.faas.compute_node import ComputeNode
from flow_sdk.builtin.shell import Shell, ShellStatus


def _no_reap():
    return patch.object(AgenticProcess, "reap_if_orphaned", new=AsyncMock(return_value=False))


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_tabs_list_parity_with_terminals_list():
    plain = Shell(id=str(uuid.uuid4()), status="running", tab_order=1)
    closing = Shell(id=str(uuid.uuid4()), status=ShellStatus.CLOSING.value, tab_order=2)
    for s in (plain, closing):
        await s.save()
    member_ap = AgenticProcess(id=str(uuid.uuid4()), visible=True)
    hidden_ap = AgenticProcess(id=str(uuid.uuid4()), visible=False)
    for p in (member_ap, hidden_ap):
        await p.save()

    with _no_reap():
        legacy = (await ComputeNode()._terminal_list()).data
        unified = (await ComputeNode()._tabs_list()).data

    legacy_ids = {s["id"] for s in legacy["pure_shells"]} | {p["id"] for p in legacy["visible_processes"]}
    unified_ids = {t["entity"]["id"] for t in unified["tabs"]}
    assert unified_ids == legacy_ids
    assert plain.id in unified_ids and member_ap.id in unified_ids
    assert closing.id not in unified_ids and hidden_ap.id not in unified_ids
    kinds = {t["entity"]["id"]: t["kind"] for t in unified["tabs"]}
    assert kinds[plain.id] == "shell"
    assert kinds[member_ap.id] == "agentic_process"


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_tabs_open_and_close_flip_non_null_membership():
    # Generic (non-terminal) entity: clear-membership close — entity survives.
    ap = AgenticProcess(id=str(uuid.uuid4()), visible=False)
    await ap.save()

    node = ComputeNode()
    with _no_reap():
        res_open = await node._tabs_open({"targets": [f"agentic_process:{ap.id}"]})
    assert res_open.data["accepted"] == [f"agentic_process-{ap.id}"]

    reloaded = await AgenticProcess.get_by_id(ap.id)
    assert reloaded.tabbed is True
    assert reloaded.visible is True          # alias stays in step
    assert reloaded.tab_order >= 1           # got a strip slot (never 0)

    # Close through the terminal path (agentic_process targets delegate).
    with _no_reap():
        res_close = await node._tabs_close(
            {"targets": [f"agentic_process:{ap.id}"]}, BackgroundTasks()
        )
    assert f"agentic_process-{ap.id}" in res_close.data["accepted"]
    reloaded = await AgenticProcess.get_by_id(ap.id)
    assert reloaded.tabbed is False
    assert reloaded.visible is False


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_wire_rule_tabbed_false_survives_exclude_none():
    """Removal must ride a NON-NULL signal: `tabbed=false` survives the
    exclude_none wire encoding (resource_tracker.py); a nulled field is
    stripped and can never propagate a close cross-client."""
    ap = AgenticProcess(id=str(uuid.uuid4()), visible=False)
    payload = jsonable_encoder(ap.model_dump(mode="json"), exclude_none=True)
    assert payload["tabbed"] is False          # non-null False survives
    assert "last_active_at" not in payload     # null IS stripped — why null can't signal


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_visible_tabbed_alias_sync():
    # Legacy load: only `visible=true` provided → member (tabbed follows).
    legacy = AgenticProcess(id=str(uuid.uuid4()), visible=True)
    assert legacy.tabbed is True

    # Writes to either side keep both in step.
    legacy.visible = False
    assert legacy.tabbed is False
    legacy.tabbed = True
    assert legacy.visible is True


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_last_active_at_iso_tolerant_epoch_ms():
    from datetime import datetime

    iso = "2026-06-11T10:00:00+00:00"
    s = Shell(id=str(uuid.uuid4()), status="running", last_active_at=iso)
    assert isinstance(s.last_active_at, int)
    assert s.last_active_at == int(datetime.fromisoformat(iso).timestamp() * 1000)
    # Numbers pass through untouched.
    s2 = Shell(id=str(uuid.uuid4()), status="running", last_active_at=1781085600001)
    assert s2.last_active_at == 1781085600001


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_tabs_list_includes_onboarded_entity_kinds():
    """`tabs/list` fans out over ONBOARDED_TAB_TYPES: a `tabbed=True` entity
    of an onboarded type appears with its own kind; `tabbed=False` does not.

    pytest does not run the server's startup registrations, so trigger
    `register_all()` explicitly (same convention as
    tests/unit/test_git_branch_share_parent.py) — `flow_sdk.models.entities`
    binds the entity classes, `register_all()` merges them into the registry.
    """
    import flow_sdk.models.entities  # noqa: F401 — side-effect: bind entity classes
    from flow_sdk.builtin.claude_memory_entities import Docs
    from flow_sdk.builtin.faas.compute_node import ONBOARDED_TAB_TYPES
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    from flow_sdk.schema.type_info import register_all

    register_all()
    assert "markdown" in ONBOARDED_TAB_TYPES
    assert SchemaRegistry.get_entity_cls("markdown") is Docs

    member = Docs(id=str(uuid.uuid4()), name="member-doc", tabbed=True)
    non_member = Docs(id=str(uuid.uuid4()), name="closed-doc", tabbed=False)
    for d in (member, non_member):
        await d.save()

    with _no_reap():
        unified = (await ComputeNode()._tabs_list()).data

    by_id = {t["entity"]["id"]: t["kind"] for t in unified["tabs"]}
    assert by_id.get(member.id) == "markdown"
    assert non_member.id not in by_id


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_agentic_process_owns_tab_order_across_reload():
    ap = AgenticProcess(id=str(uuid.uuid4()), visible=True, tab_order=5)
    await ap.save()
    reloaded = await AgenticProcess.get_by_id(ap.id)
    assert reloaded.tab_order == 5
    assert "_prev_tab_order" not in (reloaded.context_data or {})
