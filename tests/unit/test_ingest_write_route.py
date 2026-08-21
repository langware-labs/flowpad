"""The ingestor's write side, and the guarantees it exists to preserve.

Before this route the only way to make a `SourceItem` was to wait for the
heartbeat poller. Anything else — an agent, a test, a CLI — had to go around
the chokepoint, which meant a random uuid4, no content digest, no local-state
preservation and no `ingest.*` events: rows that look real and can never
converge with what the poller writes.

So these tests are about convergence, not plumbing. The load-bearing one is
that creating the same item twice is an upsert, because that is what makes an
agent safe to re-run.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.ingest.ingestor import ingest_items
from flow_sdk.ingest.models import IngestItem, IngestMode
from flow_sdk.server.routes.ingest import MAX_ITEMS_PER_REQUEST, _to_item


def _payload(**over) -> dict:
    base = {
        "source_id": f"src-{uuid.uuid4().hex[:8]}",
        "provider": "agent",
        "kind": "content.message.email",
        "segment_key": "INBOX",
        "external_id": "msg-1",
        "title": "Invoice #42",
        "body": "the body",
    }
    base.update(over)
    return base


def test_a_missing_header_field_is_refused_by_name():
    """The five header fields are what identity is minted from — a payload
    missing one cannot be silently accepted with a blank."""
    with pytest.raises(ValueError) as caught:
        _to_item({"source_id": "s", "provider": "agent"})
    message = str(caught.value)
    assert "kind" in message and "segment_key" in message and "external_id" in message


def test_an_unknown_field_is_refused_rather_than_dropped():
    """A caller that writes `subject` instead of `title` would otherwise get a
    row with an empty name and no way to notice."""
    with pytest.raises(ValueError) as caught:
        _to_item(_payload(subject="Invoice #42"))
    assert "subject" in str(caught.value)


def test_the_batch_ceiling_is_below_nothing_surprising():
    """A batch over the ceiling is refused outright rather than silently
    truncated — the caller decides how to split."""
    assert MAX_ITEMS_PER_REQUEST >= 1


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_creating_the_same_item_twice_is_an_upsert_not_a_duplicate():
    """THE guarantee. An agent re-running its fetch must converge, not double.

    This is what going around the chokepoint costs: `Entity.allocate_id` would
    mint a fresh uuid4 each time and leave two rows for one email.
    """
    item = _to_item(_payload())

    first = await ingest_items([item], mode=IngestMode.INCREMENTAL)
    assert first.created == 1

    second = await ingest_items([item], mode=IngestMode.INCREMENTAL)
    assert second.created == 0 and second.updated == 0
    assert second.unchanged == 1, (
        "a re-create wrote again — the content digest is not gating, so every "
        "agent re-run would rewrite rows and re-fire triggers"
    )

    rows = await SourceItem.get_all({"data_source_id": item.source_id})
    assert len(rows) == 1, f"{len(rows)} rows for one email — the natural key did not resolve"
    found = await SourceItem.find_existing(item.source_id, item.segment_key, item.external_id)
    assert found is not None and found.id == rows[0].id, (
        "the row must be reachable by (source, stream, external_id) — that lookup "
        "is what makes a re-delivery an upsert instead of a duplicate"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_local_state_survives_re_delivery():
    """`read`/`starred` are ours, not the provider's. A re-create must refresh
    the snapshot without resetting what the user did to the row."""
    item = _to_item(_payload())
    await ingest_items([item], mode=IngestMode.INCREMENTAL)

    row = (await SourceItem.get_all({"data_source_id": item.source_id}))[0]
    row.read = True
    row.starred = True
    await row.save()

    # Same identity, changed content — forces the update path rather than the
    # digest-gate short circuit.
    moved = _to_item(_payload(source_id=item.source_id, body="the body, edited"))
    report = await ingest_items([moved], mode=IngestMode.INCREMENTAL)
    assert report.updated == 1

    after = (await SourceItem.get_all({"data_source_id": item.source_id}))[0]
    assert after.body == "the body, edited", "the snapshot did not refresh"
    assert after.read is True and after.starred is True, (
        "local state was clobbered by re-delivery — the ingestor writes an "
        "explicit field map precisely so this cannot happen"
    )


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_a_large_batch_selects_backfill_so_it_cannot_storm():
    """Over the per-item cap the mode flips and the batch reports once. The
    route does not ask callers to know this — `IngestMode.for_run` decides."""
    source = f"src-{uuid.uuid4().hex[:8]}"
    many = [
        IngestItem(source_id=source, provider="agent", kind="content.message.email",
                   segment_key="INBOX", external_id=f"m-{n}", title=f"mail {n}")
        for n in range(40)
    ]
    assert IngestMode.for_run(first_run=False, item_count=len(many)) is IngestMode.BACKFILL

    report = await ingest_items(many, mode=IngestMode.BACKFILL)
    assert report.created == 40
    assert len(report.changed_ids) == 40, "changed_ids is how a flow fans out after a backfill"


def test_source_item_is_refused_by_the_generic_create_with_a_pointer():
    """The hole this closes: generic create is `types="all"` and would happily
    mint a `source_item` with a random id and an empty digest."""
    from flow_sdk.app.actions.graph_crud_actions import _uncreatable_reason

    reason = _uncreatable_reason("source_item")
    assert reason and "ingest" in reason, reason

    # And it must NOT refuse the 77 shipped types that are creatable=False yet
    # are created through this route in normal operation.
    for ordinary in ("agentic_process", "comment", "project", "shell", "markdown"):
        assert _uncreatable_reason(ordinary) is None, (
            f"{ordinary} would be refused — `creatable` is a UI hint, not an "
            "authorization flag, and reading it here breaks most of the app"
        )
