"""A person's Pull (``POST data_source/<id>/sync``) reads the source NOW — whatever its family — and reports it.

The same answer for a message source and a record source: the cycle's counts with ``ran: true``. A source that is
not runnable (waiting on a setup step, or paused by a person) is not read: ``ran: false`` and the one sentence
``poll_refusal`` writes, so a Pull never fetches what its owner turned off or never finished connecting.
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.builtin.data_source import DataSource, SourceStatus
from flow_sdk.sources.families import RecordSource
from flow_sdk.sources.protocols import Verdict
from tests.utils.fake_source import scripted_provider

pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.timeout(30),  # do not increase timeout without approval
    pytest.mark.usefixtures("fresh_user_scope"),
]

MESSAGES = "sync-now-messages"
RECORDS = "sync-now-records"


class _Records(RecordSource):
    provider = RECORDS

    async def verify(self) -> Verdict:
        return Verdict(ready=True, detail="ok")


@pytest.fixture
def records():
    DataDriver.register(DataDriver.for_class(_Records, kind="datasource.test.sync_now"))


async def _source(provider: str, **kw) -> DataSource:
    """A verified, listening source — a driver with a check starts in SETUP until its Verify passes."""
    me = f"{uuid.uuid4().hex[:8]}-me@sync.test"
    src = DataSource(name=f"pull {uuid.uuid4().hex[:8]}", provider=provider, account_key=me, **kw)
    await src.save()
    src.status = SourceStatus.ACTIVE.value
    await src.save_runtime()
    return src


async def _pull(src: DataSource) -> dict:
    return (await src.sync_action()).data


async def test_a_message_source_is_read_now_and_its_new_messages_counted():
    pages = [[{"key": "m1", "text": "hello"}, {"key": "m2", "text": "again"}]]
    with scripted_provider(MESSAGES, pages=pages):
        src = await _source(MESSAGES)
        answer = await _pull(src)
    assert answer["ran"] is True
    assert answer["created"] == 2 and answer["health"] == "ok"


async def test_a_record_source_answers_the_same_shape(records):
    src = await _source(RECORDS)
    answer = await _pull(src)
    assert answer["ran"] is True
    assert {"created", "updated", "unchanged", "removed", "health", "status", "error_detail", "detail"} <= set(answer)


@pytest.mark.parametrize("status", [SourceStatus.SETUP.value, SourceStatus.DISABLED.value])
async def test_a_source_that_is_not_runnable_is_not_read_and_says_why(status):
    with scripted_provider(MESSAGES, pages=[[{"key": "m1", "text": "x"}]]):
        src = await _source(MESSAGES)
        src.status = status
        src.setup_detail = "Needs GitHub sign-in" if status == SourceStatus.SETUP.value else ""
        await src.save_runtime()
        answer = await _pull(src)
    assert answer["ran"] is False and answer["created"] == 0
    assert answer["status"] == status
    assert answer["detail"] == src.poll_refusal() and answer["detail"]
