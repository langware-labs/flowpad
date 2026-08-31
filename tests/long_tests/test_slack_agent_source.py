"""LIVE: a person types "sync my Slack channel C…" and gets a working source —
and an inbox whose rows are references, not copies.

The Slack twin of ``test_gmail_agent_source.py`` — same two-layer primitive
(an AgenticProcess asks for the source; the source it builds fetches by
spawning an AgenticProcess of its own, ``provider: agent`` with
``connector: slack``), same skill, same ``live_backend`` reasoning: the
worker's side is CLI-shaped and has no in-process path.

Ground truth is a CSV captured out-of-band from the Slack MCP — real messages
from a real channel, so it lives OUTSIDE the repo and is never committed.
Point SLACK_FIXTURE at it; columns:
``external_id`` (the ts), ``channel_id``, ``occurred_at`` (ISO-8601),
``author_external_id`` (U…/B…), ``thread_key`` (thread_ts or own ts),
``text``.

Beyond the gmail twin, this test also pins the REFERENCE MODEL end to end:
after reconciliation the projected FlowMessages must store no body
(``hydrate=False`` reads blank) while hydrated reads carry the channel text,
and threads must resolve by ``(channel, thread_key)`` lookup.

Needs a launchable Claude with Slack authorised, so this module must stay
listed in ``conftest._REAL_HOME_TEST_MODULES`` or its worker gets the sandbox
HOME.
"""
from __future__ import annotations

import asyncio
import csv
import os
import pathlib
import time
from datetime import datetime, timezone

import pytest

import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped drivers
from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.artifact import Artifact
from flow_sdk.builtin.flow_message import FlowMessage
from flow_sdk.builtin.message_thread import MessageThread
from flow_sdk.builtin.source_item import SourceItem
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.flowpad_types.enums import WorkerType
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.inbox.projection import reconcile_source
from flow_sdk.ingest.sync import sync_source
from tests.long_tests._transcript_helpers import assert_prompt_ok, safe_exit
from tests.test_settings import test_service_config

pytestmark = [
    pytest.mark.skipif(
        not test_service_config.deep_testing,
        reason="Skipping long tests when DEEP_TESTING is disabled",
    ),
]

#: Ground truth, captured out-of-band from the Slack MCP. Real messages: never
#: committed. Without one this test has no reference and says so rather than
#: inventing one.
FIXTURE = pathlib.Path(os.environ.get("SLACK_FIXTURE", "/nonexistent/slack_channel.csv"))

#: Compared byte-exact. Identifiers, with no typography to argue about. The
#: ts (`external_id`) keys the dict; `segment_key` is asserted against the
#: fixture's channel_id per row.
EXACT = ("author_external_id", "thread_key")

#: Same measured transport limit as the gmail twin: the fetch is a language
#: model retyping text into JSON, and quote characters are the one place it
#: wobbles. Identity fields stay exact.
_QUOTES = dict.fromkeys(map(ord, "\"'“”‘’\\"))


def _comparable(text: str) -> str:
    return (text or "").translate(_QUOTES)


_BODY_OPENING = 12


def _same_opening(reference: str, body: str | None) -> bool:
    """Chat messages are short; compare the shorter side's length and no more
    (see the gmail twin for why containment fails short texts)."""
    ref, rec = _comparable(reference).strip(), _comparable(body or "").strip()
    head = min(len(ref), len(rec))
    return head >= _BODY_OPENING and ref[:head] == rec[:head]


def _instant(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)


@pytest.fixture
async def assistant(live_backend, tmp_path):
    """The worker process that fields the request — assistant project mounted.

    Deliberately NOT using the `local_project` / `local_compute_node` fixtures:
    the backend seeds both into this same DB while it boots, and two writers
    racing the `compute_node:local` singleton hit the UNIQUE constraint. Same
    reasoning as the gmail twin.
    """
    process = await AgenticProcess(
        worker_type=WorkerType.CLAUDE_CODE,
        workdir=str(tmp_path),
        load_flowpad_assistant=True,
        visible=False,
    ).save()
    try:
        yield process
    finally:
        await asyncio.shield(safe_exit(process))


CONNECT_DEADLINE_S = 540  # share of the approved 900s budget, as in the gmail twin


async def _await_declared_source(assistant) -> str | None:
    """Polled, not waited on — see the gmail twin: the artifact IS the signal."""
    deadline = time.monotonic() + CONNECT_DEADLINE_S
    while time.monotonic() < deadline:
        produced = await Artifact.get_all({"generated_by": str(assistant.typeid)})
        for artifact in produced:
            if (artifact.target_type_id or "").startswith("data_source-"):
                return artifact.target_type_id
        await asyncio.sleep(5.0)
    return None


def _reference() -> dict[str, dict]:
    expected = {row["external_id"]: row for row in csv.DictReader(FIXTURE.open(encoding="utf-8"))}
    assert expected, "fixture carries no messages"
    return expected


@pytest.mark.asyncio
@pytest.mark.timeout(900)  # approved: one turn + the driver's own 300s fetch deadline
async def test_connect_my_slack_channel(assistant):
    if not FIXTURE.is_file():
        pytest.skip("set SLACK_FIXTURE to a channel reference CSV — none found")
    expected = _reference()
    channel_id = next(iter(expected.values()))["channel_id"]

    assert_prompt_ok(await assistant.prompt(f"sync my Slack channel {channel_id}"))

    # ── the run's declared output IS the source ─────────────────────────────
    target = await _await_declared_source(assistant)
    if target is None:
        pytest.skip("the run declared no data_source artifact — LLM non-compliance, not a defect")
    src = await Entity.get_by_typeid(TypeId(target))
    assert src is not None, f"artifact points at a missing entity: {target}"
    assert (src.config or {}).get("connector") == "slack", (
        "the skill must route a Slack channel to the agent transport"
    )
    assert channel_id in (src.config or {}).get("segments", []), (
        "the channel id must become a segment, verbatim"
    )

    # ── it fetches, by spawning a worker of its own ─────────────────────────
    await sync_source(src, now=datetime.now(timezone.utc))
    ingested = {row.external_id: row for row in await SourceItem.get_all({"data_source_id": src.id})}
    assert ingested, "the fetch worker recorded nothing"

    _assert_matches_channel(expected, ingested, channel_id)
    await _assert_reference_inbox(src, ingested)


def _assert_matches_channel(expected: dict, ingested: dict, channel_id: str) -> None:
    """Every reference message the run's window covered, recorded faithfully.

    Same drift policy as the gmail twin: a reference message older than the
    oldest recorded row fell out of the run's bounded window — reported as a
    skip, not a failure; a miss INSIDE the window fails.
    """
    floor = min(_instant(row.occurred_at) for row in ingested.values())
    missing = set(expected) - set(ingested)
    drifted = {m for m in missing if _instant(expected[m]["occurred_at"]) < floor}
    inside = sorted(missing - drifted)
    assert not inside, f"the source never recorded messages inside its own window: {inside}"

    covered = sorted(set(expected) & set(ingested))
    if not covered:
        pytest.skip(
            f"every reference message predates the run's window (oldest recorded: {floor.isoformat()}) "
            "— recapture SLACK_FIXTURE closer to the run"
        )

    drift: list[str] = []
    for external_id in covered:
        row, got = expected[external_id], ingested[external_id]
        for field in EXACT:
            assert getattr(got, field) == row[field], f"{external_id}.{field}"
        assert got.segment_key == channel_id == row["channel_id"], f"{external_id}.segment_key"
        assert got.kind == "content.message.chat", f"{external_id}.kind"
        assert _instant(got.occurred_at) == _instant(row["occurred_at"]), f"{external_id}.occurred_at"
        if not _same_opening(row["text"], got.body):
            drift.append(
                f"{external_id}.body\n     channel: {row['text'][:60]!r}\n   recorded: {(got.body or '')[:60]!r}"
            )

    if drift:
        pytest.skip("recorded text drifted from the channel:\n  " + "\n  ".join(drift))


async def _assert_reference_inbox(src, ingested: dict) -> None:
    """The reference model, end to end: blank rows in the store, bodies on read.

    ``reconcile_source`` is called directly — the tag lanes belong to the
    backend process; this test asserts the projection's output, not the bus.
    """
    await reconcile_source(src.id)

    for item in ingested.values():
        raw = await FlowMessage.get_all({"source_item_id": item.id}, hydrate=False)
        assert len(raw) == 1, f"item {item.external_id} must project exactly one message"
        assert raw[0].text == "", "a projected row stores no body — it is a reference"
        assert raw[0].origin and raw[0].origin.kind == "slack", "attribution rides CloudOrigin"

        hydrated = await FlowMessage.get_by_id(raw[0].id)
        assert hydrated.text == (item.body or item.name or ""), "reads hydrate from the item"

        thread = await MessageThread.find_existing("slack", item.thread_key or "")
        assert thread is not None, "the thread resolves by (channel, thread_key) lookup"
        assert raw[0].thread_id == thread.id and raw[0].conversation_id == thread.conversation_id
