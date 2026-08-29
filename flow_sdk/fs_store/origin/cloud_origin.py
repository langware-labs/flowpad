"""CloudOrigin — a pointer to the cloud record a local row is a cache of.

The sibling of ``FSOrigin`` (``fs_origin.py``), which answers "here is where
this asset's BYTES live". This one answers "here is where this record's TRUTH
lives" — a secret-free, serializable value object naming a mutable object in
someone else's system: a Gmail message, a Slack post, a Jira comment.

Same shape as its sibling on purpose: a ``kind`` discriminant plus locator
fields, no behaviour and no credentials. Fetching, sending and refreshing live
in the ingest driver registry (``flow_sdk/ingest/driver.py``), keyed by
``provider`` — never on this object.

**``kind`` and ``provider`` are different axes and both are load-bearing.**

* ``kind`` is the CHANNEL — what a human calls it, and what the badge shows.
  ``gmail``, ``slack``, ``jira``.
* ``provider`` is the TRANSPORT — the ingest driver that carried it.

They are not redundant. The shipped Gmail source's driver key is literally
``"agent"`` (``ingest/drivers/agent.py``), so nothing on the record says
"gmail" today. And one channel can have several transports: a harness-backed
Gmail source and an API-backed one are two providers reaching the same mailbox.
Threading and the badge key on ``kind`` precisely so a thread ingested through
the harness today and the API tomorrow stays ONE thread.
"""
from __future__ import annotations

from pydantic import BaseModel


class CloudOrigin(BaseModel):
    @property
    def transportable(self) -> bool:
        return True   # a cloud pointer names a remote resource — it travels

    """Where the real record lives. ``None`` on a message means "ours".

    **Transportable half only.** Every member here means the same thing on any
    machine, which is what lets the carrying field stay ``Sharing.SHARED`` — a
    received message still renders its channel badge and its "Open in ..." link.
    The local row pointers live in :class:`CloudOriginLocal`, which is carried by
    a separate PRIVATE field; see that class for why they cannot ride along.
    """

    # The channel — the badge axis, and half of the thread key. See the module
    # docstring for why this is not `provider`.
    kind: str = ""
    # The ingest driver that carried it: `agent`, `gmail_api`, `slack_api`.
    provider: str = ""
    # The provider's own id for the record. Stable across re-polls; the third
    # component of the natural key `SourceItem.find_existing` resolves.
    external_id: str = ""
    # Permalink into the origin system — what "Open in Gmail" opens. Empty when
    # the provider gives no addressable URL.
    url: str = ""


class CloudOriginLocal(BaseModel):
    """The local row pointers behind a cached cloud record. NEVER leaves the machine.

    Split out of :class:`CloudOrigin` because these two ids are row ids in THIS
    instance's database and mean nothing anywhere else. Shared wholesale they
    were worse than useless: a receiver dereferencing them misses, and
    ``inbox/outbound`` then reports the record as *deleted* when the truth is
    that it is *foreign*.

    Same resolution the ``Sharing`` docstring already prescribes for
    ``shared_context_entities`` vs ``private_context_entities_`` — one
    conceptual thing whose halves have different answers becomes two fields,
    one policy each.
    """

    # The configured DataSource this arrived through — the way back to
    # credentials, account identity and the send verb.
    data_source_id: str = ""
    # The local cache row, 1:1. `source_item-<id>`'s bare uuid.
    source_item_id: str = ""
