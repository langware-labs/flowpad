"""Unit tests for the Tab placement entity (docs/tab-management.md).

A Tab is a DB-only row keyed by a hash of the canonical DockPointer string.
These cover the CRUD + query surface the frontend strip relies on:

- deterministic identity (same pointer → same id; different → different)
- get-or-create upsert (reopen reuses one row, re-shows it)
- soft-close (``visible=false`` — the row survives, never delete-to-close)
- the ``visible=true`` query that backs the strip, over a mixture of kinds
- teardown dispatch by target_type (duck-typed; absent method = no-op)

Real DB, no mocks (session SQLite fixture from tests/conftest.py).
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.builtin.tab import Tab, ensure_tab, tab_id_for

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


class _TabTargetProbe(Entity):
    """A target entity that subscribes to tab teardown + rename, to prove the
    Tab dispatch fires by target_type (no real Shell/PTY needed)."""

    type: str = APIField(default="tab_target_probe")
    torn_down: bool = APIField(default=False)
    reflected_name: str | None = APIField(default=None)

    async def teardown_for_tab(self) -> None:
        self.torn_down = True
        await self.save()

    async def _on_tab_renamed(self, payload: dict) -> dict:
        self.reflected_name = (payload or {}).get("name")
        await self.save()
        return {"name": self.reflected_name}


_TabTargetProbe.on_event("tab-renamed")(_TabTargetProbe._on_tab_renamed)


def test_visible_false_survives_exclude_none_wire_rule() -> None:
    """Membership removal must ride a NON-NULL signal: ``visible=false`` survives
    the ``exclude_none`` wire encoding (a nulled field would be stripped and a
    close could never propagate cross-client)."""
    from fastapi.encoders import jsonable_encoder

    tab = Tab(id=str(uuid.uuid4()), pointer="dock/x", visible=False)
    payload = jsonable_encoder(tab.model_dump(mode="json"), exclude_none=True)
    assert payload["visible"] is False  # non-null False survives the encoder


def test_tab_id_is_deterministic_uuid5() -> None:
    a = tab_id_for("dock/assets")
    b = tab_id_for("dock/assets")
    c = tab_id_for("dock/shell")
    assert a == b, "same pointer must mint the same id"
    assert a != c, "different pointers must mint different ids"
    assert uuid.UUID(a).version == 5, "Tab id must be a deterministic v5"


@pytest.mark.asyncio
async def test_ensure_tab_creates_then_reuses() -> None:
    p = f"dock/assets#{uuid.uuid4()}"  # unique per run — DB persists across tests
    first = await ensure_tab(p, target_type="markdown", target_id="markdown-x")
    assert first.id == tab_id_for(p)
    assert first.visible is True

    again = await ensure_tab(p)
    assert again.id == first.id, "reopen must reuse the same row, not duplicate"

    rows = await Tab.get_all({"pointer": p})
    assert len(rows) == 1, "no duplicate Tab for the same pointer"


@pytest.mark.asyncio
async def test_close_is_soft_and_reopen_reshows() -> None:
    p = f"dock/shell#{uuid.uuid4()}"
    tab = await ensure_tab(p, target_type="shell", target_id="shell-y")

    await tab.close()
    assert tab.visible is False

    reloaded = await Tab.get_one({"id": tab.id})
    assert reloaded is not None, "soft-close keeps the row (never delete-to-close)"
    assert reloaded.visible is False

    # Reopening the same pointer flips it back to visible — same row.
    reopened = await ensure_tab(p)
    assert reopened.id == tab.id
    assert reopened.visible is True


@pytest.mark.asyncio
async def test_visible_query_over_mixed_kinds() -> None:
    tag = uuid.uuid4()
    opened = [
        await ensure_tab(f"dock/shell#{tag}", target_type="shell", target_id=f"shell-{tag}"),
        await ensure_tab(f"editor/markdown#{tag}", target_type="markdown", target_id=f"md-{tag}"),
        await ensure_tab(f"editor/skill#{tag}", target_type="skill", target_id=f"sk-{tag}"),
        await ensure_tab(f"dock/settings#{tag}"),  # target-less transient surface
    ]
    closed = await ensure_tab(f"dock/search#{tag}")
    await closed.close()

    visible = {t.id for t in await Tab.get_all({"visible": True})}
    for t in opened:
        assert t.id in visible, "every open tab of any kind appears in one query"
    assert closed.id not in visible, "a closed tab is excluded from the visible query"


@pytest.mark.asyncio
async def test_teardown_dispatch_is_duck_typed_noop_when_absent() -> None:
    # A target_type with no live entity / no teardown_for_tab must not raise.
    p = f"dock/diff#{uuid.uuid4()}"
    tab = await ensure_tab(p, target_type="markdown", target_id="does-not-exist")
    await tab.close()  # resolves nothing → no-op, no exception
    assert tab.visible is False


@pytest.mark.asyncio
async def test_close_dispatches_teardown_to_target() -> None:
    probe = _TabTargetProbe(id=str(uuid.uuid4()))
    await probe.save()
    tab = await ensure_tab(
        f"dock/probe#{uuid.uuid4()}",
        target_type=_TabTargetProbe.get_type(),
        target_id=probe.id,
    )
    await tab.close()
    reloaded = await _TabTargetProbe.get_one({"id": probe.id})
    assert reloaded is not None and reloaded.torn_down is True


@pytest.mark.asyncio
async def test_deleting_target_soft_closes_its_tabs() -> None:
    # Orphan cleanup: deleting the target entity hides its Tab (no dangling chip).
    probe = _TabTargetProbe(id=str(uuid.uuid4()))
    await probe.save()
    tab = await ensure_tab(
        f"dock/probe-del#{uuid.uuid4()}",
        target_type=_TabTargetProbe.get_type(),
        target_id=probe.id,
    )
    assert tab.visible is True
    await probe.delete()
    reloaded = await Tab.get_one({"id": tab.id})
    assert reloaded is not None and reloaded.visible is False


@pytest.mark.asyncio
async def test_rename_reflects_onto_subscribed_target() -> None:
    probe = _TabTargetProbe(id=str(uuid.uuid4()))
    await probe.save()
    tab = await ensure_tab(
        f"dock/probe-rename#{uuid.uuid4()}",
        target_type=_TabTargetProbe.get_type(),
        target_id=probe.id,
    )
    await tab.rename("my pinned name")
    assert tab.name == "my pinned name"  # Tab.name is the source of truth
    reloaded = await _TabTargetProbe.get_one({"id": probe.id})
    assert reloaded is not None and reloaded.reflected_name == "my pinned name"
