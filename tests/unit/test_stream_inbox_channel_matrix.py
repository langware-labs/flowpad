"""The stream inbox channel matrix, pure pytest: owner (user | agent) × channel (gmail, slack, whatsapp,
telegram, agent email), each cell over the driver's own ``Double`` — see ``_stream_inbox_matrix``."""
from __future__ import annotations

import pytest

from tests.unit._stream_inbox_matrix import (
    CHANNELS,
    OWNERS,
    adopts_the_owners_source,
    assert_owned_and_attributed,
    deliver,
    double_for,
    make_cell,
    not_applicable,
    reply_as_agent,
    reply_as_human,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30), pytest.mark.usefixtures("fresh_user_scope")]  # do not increase timeout without approval

CELLS = [pytest.param(owner, provider, id=f"{owner}-{provider}") for owner in OWNERS for provider in CHANNELS]


@pytest.mark.parametrize(("owner_kind", "provider"), CELLS)
async def test_a_message_lands_in_its_owners_stream_inbox_and_is_answered_on_its_channel(owner_kind, provider, monkeypatch):
    if reason := not_applicable(owner_kind, provider):
        pytest.skip(f"n/a: {reason}")
    with double_for(provider) as double:
        cell = await make_cell(owner_kind, provider, double, monkeypatch)
        try:
            item = await deliver(cell)
            _, conversation = await assert_owned_and_attributed(cell, item)
            if owner_kind == "user":
                await reply_as_human(cell, conversation)
            else:
                await reply_as_agent(cell, item, monkeypatch)
            await adopts_the_owners_source(cell, monkeypatch)
        finally:
            await cell.source.delete()
            await cell.agent.delete()
