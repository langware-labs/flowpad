"""What the inbox announces, and the grammar it announces it in.

Follows the ``<family>_on_tag.py`` convention (see ``flow_sdk/ingest/ingest_on_tag.py``
and ``flow_sdk/db/entity_on_tag.py``): the family's tag strings are declared in
one file rather than invented at whichever call site needed one first.

One tag lives here today::

    inbox.<provider>.message.projected
      target: source_item:<id>
      scope:  data_source:<id>
      data:   {entity_id, source_id}

It says a message is now PLACED IN A CONVERSATION — which is a different fact
from ``ingest.*.item.created``, and the one a consumer needs, because a thread's
``conversation_id`` does not exist until the projection has committed. A
consumer keyed on the ingest tag is racing that write: Law 3 detaches every
handler, so it reads no thread and drops the message with a warning nobody sees.
"""
from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


def emit_projected_tag(item) -> None:
    """Announce one message's placement in a conversation.

    Carries identity and a pointer, never the body — same contract as the ingest
    lane, so a subscriber recovers the row itself and survives a restart.

    The ``scope`` matters as much as the tag: scoped subscriptions and the Events
    screen both filter on it, so an announcement without one is invisible to
    anything narrowing by data source.
    """
    from flow_sdk.tags import emit_tag, target_of  # noqa: PLC0415

    emit_tag(
        f"inbox.{item.provider or 'unknown'}.message.projected",
        target_of("source_item", item.id),
        {"entity_id": item.id, "source_id": item.data_source_id},
        ctx={"scope": [target_of("data_source", item.data_source_id)]},
    )
