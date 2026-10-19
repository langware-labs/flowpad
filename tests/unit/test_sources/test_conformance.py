"""The conformance kit over the three in-process subjects.

Each parametrized case is one contract clause; the set of cases per subject is what the
source's capabilities make applicable — a folder gets the ByteStore clauses, the memory
records source the Mutable ones, the memory messages source the Messaging and Drafting ones.
"""

from __future__ import annotations

import pytest

from flow_sdk.sources import FolderSource, MemoryMessages, MemorySource
from flow_sdk.sources.testing import checks_for

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.mark.parametrize("check", checks_for(FolderSource), ids=str)
async def test_folder_source(check, folder_subject):
    await check.run(folder_subject)


@pytest.mark.parametrize("check", checks_for(MemorySource), ids=str)
async def test_memory_records(check, records_subject):
    await check.run(records_subject)


@pytest.mark.parametrize("check", checks_for(MemoryMessages), ids=str)
async def test_memory_messages(check, messages_subject):
    await check.run(messages_subject)


def test_the_kit_selects_by_capability():
    names = {c.name for c in checks_for(FolderSource)}
    assert "write_get_open_delete_round_trip" in names and "send_needs_exactly_one_addressing_mode" not in names
    names = {c.name for c in checks_for(MemoryMessages)}
    assert "reply_is_routed_from_the_answered_message" in names and "chunk_size_is_validated" not in names
