"""The cloud arm of ``OriginField``: ``CloudOrigin`` names where a record's TRUTH lives.

The sibling of ``FSOrigin`` (``fs_origin.py``), which answers "here is where this asset's
BYTES live". The value itself is the source contract's ``CloudOrigin``
(``flow_sdk/sources/values/origin.py``): identity is the ``(kind, namespace, key)`` triple,
``url`` is browser metadata, and a pre-triple dict (``external_id``, ``provider``) lifts on
read. This module registers it as the open arm — any origin ``kind`` that is not a filesystem
kind is a cloud origin — and keeps the local half beside it.
"""

from __future__ import annotations

from pydantic import BaseModel

from flow_sdk.fs_store.origin.fs_origin import CLOUD_ORIGIN_KIND, ORIGIN_MODELS
from flow_sdk.sources.values.origin import CloudOrigin


class CloudOriginLocal(BaseModel):
    """The local row pointers behind a cached cloud record. NEVER leaves the machine.

    Split out of :class:`CloudOrigin` because these two ids are row ids in THIS
    instance's database and mean nothing anywhere else. Shared wholesale they
    were worse than useless: a receiver dereferencing them misses, and
    ``inbox/outbound`` then reports the record as *deleted* when the truth is
    that it is *foreign*.
    """

    # The configured DataDriver this arrived through — the way back to
    # credentials, account identity and the send verb.
    data_source_id: str = ""
    # The local cache row, 1:1. `source_item-<id>`'s bare uuid.
    source_item_id: str = ""


ORIGIN_MODELS.register(CloudOrigin, CLOUD_ORIGIN_KIND)

__all__ = ["CloudOrigin", "CloudOriginLocal"]
