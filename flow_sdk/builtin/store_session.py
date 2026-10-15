"""Session entities of workers that keep sessions in a store (OpenCode, DeepAgents): the
transcript FlowPad wrote for a run, snapshotted when the session is shared."""

from __future__ import annotations

from typing import ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.fs_store.record_types import RecordType


class _StoreSession(Entity):
    # The snapshot JSONL — see ``ClaudeSession.asset_ref`` for why this is declared.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)
    received: bool = APIField(default=False, sharing=Sharing.HUB_WRITE)

    _api_visible: ClassVar[bool] = False


class OpencodeSession(_StoreSession):
    type: str = APIField(default=RecordType.OPENCODE_SESSION)


class DeepagentsSession(_StoreSession):
    type: str = APIField(default=RecordType.DEEPAGENTS_SESSION)
