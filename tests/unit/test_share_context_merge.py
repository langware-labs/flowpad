"""Existing-conversation share: context merge onto the parent conversation.

When a message is sent into an EXISTING conversation carrying asset references /
shared context (the converged share path), ``handle_add_message`` merges those
items onto the conversation (``shared_context_entities``) and links them back
(``parent_type_id``) — WITHOUT minting a new invitation. These unit tests pin:

* ``_parse_context_typeids`` filters transport types + the conversation's own id,
  unions asset_references + shared_context_entities, and dedupes;
* ``_merge_shared_context_into_conversation`` (which now takes the already-parsed
  typeids — ``handle_add_message`` parses once and reuses the list for the
  message↔entity backlink) appends + saves + links exactly those items, and is
  a no-op (no save) when nothing is new.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from flow_sdk.app.actions.notification_action import (
    _merge_shared_context_into_conversation,
    _parse_context_typeids,
)
from flow_sdk.builtin.conversation import Conversation

_CONV_ID = "aaaa1111-2222-3333-4444-555555555551"
_TASK = "task-bbbb1111-2222-3333-4444-555555555552"
_DOC = "markdown-cccc1111-2222-3333-4444-555555555553"
_SPEC = "spec-dddd1111-2222-3333-4444-555555555554"
_OTHER_CONV = "conversation-eeee1111-2222-3333-4444-555555555555"
_FM = "flow_message-ffff1111-2222-3333-4444-555555555556"


def _conv() -> Conversation:
    return Conversation.model_validate({"id": _CONV_ID})


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_parse_filters_transport_and_self_and_dedupes():
    conv = _conv()
    asset_refs = [
        _TASK,
        f"conversation-{_CONV_ID}",  # the conversation's own id → dropped
        _OTHER_CONV,                 # transport type → dropped
        _FM,                         # transport type → dropped
        _DOC,
    ]
    shared_ctx = [
        _DOC,    # dup of asset_refs → deduped
        _SPEC,
        "",      # empty → skipped
        None,    # None → skipped
    ]
    out = [str(t) for t in _parse_context_typeids(conv, asset_refs, shared_ctx)]
    assert out == [_TASK, _DOC, _SPEC]


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_parse_empty_inputs():
    conv = _conv()
    assert _parse_context_typeids(conv, [], []) == []
    assert _parse_context_typeids(conv, None, None) == []


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_merge_appends_saves_and_links():
    conv = _conv()
    with (
        patch.object(Conversation, "save", new=AsyncMock()) as save_mock,
        patch.object(Conversation, "_link_context_to_conversation", new=AsyncMock()) as link_mock,
    ):
        typeids = _parse_context_typeids(conv, [_DOC], [_SPEC])
        await _merge_shared_context_into_conversation(conv, typeids, "user-1")

    ctx = {str(t) for t in (conv.shared_context_entities or [])}
    assert _DOC in ctx and _SPEC in ctx
    save_mock.assert_awaited_once()
    # Linked exactly the parsed items (targeted, not the whole set).
    link_mock.assert_awaited_once()
    linked = [str(t) for t in link_mock.await_args.args[0]]
    assert linked == [_DOC, _SPEC]


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_merge_noop_when_nothing_to_add():
    conv = _conv()
    with (
        patch.object(Conversation, "save", new=AsyncMock()) as save_mock,
        patch.object(Conversation, "_link_context_to_conversation", new=AsyncMock()) as link_mock,
    ):
        # Only transport/self typeids → parse yields nothing to merge.
        typeids = _parse_context_typeids(conv, [f"conversation-{_CONV_ID}", _FM], [])
        await _merge_shared_context_into_conversation(conv, typeids, "user-1")
    save_mock.assert_not_awaited()
    link_mock.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_merge_idempotent_second_call_skips_save():
    conv = _conv()
    with (
        patch.object(Conversation, "save", new=AsyncMock()) as save_mock,
        patch.object(Conversation, "_link_context_to_conversation", new=AsyncMock()),
    ):
        typeids = _parse_context_typeids(conv, [_DOC], [])
        await _merge_shared_context_into_conversation(conv, typeids, "user-1")
        await _merge_shared_context_into_conversation(conv, typeids, "user-1")
    # First call saved (changed); second adds nothing new → no second save.
    save_mock.assert_awaited_once()
