"""``attach_child`` announces a genuinely-new edge as ``child_created``.

Adding a child changes what the PARENT contains, but until now the only event was
the child's own CREATE — addressed to the child, so anything watching the parent
learned nothing. That is the shape behind the reported bug: a message row landed
in SQLite and the open conversation was never told.

The capability is generic, so these tests use ``Comment`` children — nothing here
is message- or conversation-specific, and a regression that only fixed messages
would still fail this file.

Idempotency is the load-bearing half: ``Entity.upsert_from_hub_child`` re-converges
the same (parent, child) pair on every live op AND every catch-up pass, so a
re-attach must be silent. An event per convergence would turn one arrival into a
frame storm on every sync.

Observed through ``on_tag`` — the product's own bus subscription, fed from
``DBEntity.add_entity_op_notification``, the single funnel every entity
notification flows through. Nothing is mocked.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.comment import Comment
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.fs_store.record_paths import get_default_records_root, set_default_records_root
from flow_sdk.tags import on_tag


@pytest.fixture()
def records_root(tmp_path):
    original = get_default_records_root()
    set_default_records_root(tmp_path / "records")
    yield
    set_default_records_root(original)


@pytest.fixture()
def blob_storage(tmp_path):
    """Blob-storage fallback so Comment (blob field) saves outside a service context."""
    from flow_sdk.config import default_service_config
    from flow_sdk.request_context import methods as _ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    prev_dev = default_service_config.development
    default_service_config.development = True
    _ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    try:
        yield
    finally:
        _ctx.set_default_test_storage_fallback(None)
        default_service_config.development = prev_dev


class _ChildOps:
    """Collects ``entity.*`` bus events for one parent id."""

    def __init__(self, parent_id: str):
        self.parent_id = parent_id
        self.events: list[tuple[str, str]] = []
        self._unsub = on_tag("entity.*", self._record)

    def _record(self, event) -> None:
        data = event.data or {}
        if data.get("id") == self.parent_id or self.parent_id in str(event.target):
            self.events.append((event.tag, str(event.target)))

    def stop(self) -> list[tuple[str, str]]:
        self._unsub()
        return self.events


async def _parent_and_child() -> tuple[Conversation, Comment]:
    conv = Conversation(id=str(uuid.uuid4()), title="child-op")
    await conv.save()
    child = Comment(id=str(uuid.uuid4()), raw_content="hello", data={"line": 1})
    await child.save()
    return conv, child


@pytest.mark.asyncio
async def test_new_edge_announces_child_created(records_root, blob_storage):
    conv, child = await _parent_and_child()

    watcher = _ChildOps(conv.id)
    try:
        await conv.attach_child(child)
    finally:
        events = watcher.stop()

    assert events, "attaching a child must announce the change on the parent"


@pytest.mark.asyncio
async def test_reattaching_the_same_child_is_silent(records_root, blob_storage):
    """The kernel re-converges constantly; only the first attach is an arrival."""
    conv, child = await _parent_and_child()
    await conv.attach_child(child)

    watcher = _ChildOps(conv.id)
    try:
        await conv.attach_child(child)  # re-convergence
    finally:
        events = watcher.stop()

    assert events == [], f"re-attach must emit nothing, got {events}"


@pytest.mark.asyncio
async def test_notify_false_suppresses_the_announcement(records_root, blob_storage):
    """Bulk paths (catch-up, backfill) announce once at the end, not per child."""
    conv, child = await _parent_and_child()

    watcher = _ChildOps(conv.id)
    try:
        await conv.attach_child(child, notify=False)
    finally:
        events = watcher.stop()

    assert events == [], f"notify=False must emit nothing, got {events}"
    # ...and the edge is still really there — suppression is about the event only.
    assert await conv._has_child_edge(child) is True


@pytest.mark.asyncio
async def test_child_op_vocabulary_matches_the_hub(records_root, blob_storage):
    """One OperationType, carrying the hub's exact child values.

    ``api.messages`` used to DECLARE its own copy of this enum (and of
    ``DataOpMessage``) alongside ``api_types.messages``, kept in lockstep by
    hand. Same name, different class — so pydantic rejected the "wrong" one and
    a frame built with it was dropped with only a swallowed validation warning.
    Asserting identity, not just equal values, is the point: two enums with
    matching values would satisfy a value-only check and still fail at runtime.
    """
    from flow_sdk.api.api_types.messages import DataOpMessage as CanonicalMsg
    from flow_sdk.api.api_types.messages import OperationType as CanonicalOps
    from flow_sdk.api.messages import DataOpMessage as WireMsg
    from flow_sdk.api.messages import OperationType as WireOps

    assert CanonicalOps is WireOps, "OperationType is declared twice again — the re-export was replaced by a copy"
    assert CanonicalMsg is WireMsg, "DataOpMessage is declared twice again — the re-export was replaced by a copy"

    assert CanonicalOps.CHILD_CREATED.value == "child_created"
    assert CanonicalOps.CHILD_UPDATED.value == "child_updated"
    assert CanonicalOps.CHILD_DELETED.value == "child_deleted"

    # The failure that hid behind the duplication: a frame built with the other
    # class validated as an enum mismatch and never reached the wire.
    import uuid as _uuid

    msg = WireMsg(
        data=None,
        op=WireOps.CHILD_CREATED,
        to_entity=f"conversation-{_uuid.uuid4()}",
        from_entity=f"flow_message-{_uuid.uuid4()}",
    )
    assert msg.op == "child_created"


@pytest.mark.asyncio
async def test_child_ops_are_deliverable_not_dropped(records_root, blob_storage):
    """``_resolve_recipients`` must not resolve a child op to nobody.

    child_* is neither 'create' (broadcast-to-all) nor 'update'/'delete' (the
    watcher path with a fallback), so before this it fell through every branch
    and returned an empty recipient set — the frame was built and then silently
    discarded.
    """
    from flow_sdk.core.network import resource_tracker as rt

    conns = {"conn-1": object()}
    for op in ("child_created", "child_updated", "child_deleted"):
        recipients = rt._resolve_recipients(op, "conversation", str(uuid.uuid4()), conns)
        assert recipients == {"conn-1"}, f"{op} resolved to {recipients}, would be dropped"
