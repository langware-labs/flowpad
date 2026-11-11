"""Ask for help is a conversation: the person's ``help_request`` message, written at once, then the diagnosis as
a message of its own when the background run ends. Unshared context waits on this computer until Share; nobody
to ask makes the conversation private -- "Diagnose & fix" -- until Report it sends it where the cause points.

The hub hop is the one seam replaced (``Conversation.deliver``); capture, the diagnose runner and the message
send are real. The diagnose is a project-style one in a temp folder.
"""

from __future__ import annotations

import json
import textwrap
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import pytest

import flow_sdk.diagnose as diagnose_pkg
from flow_sdk.app.actions import ask_for_help_action as afh
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import (
    HELP_REQUEST_FILE,
    Attachment,
    AttachmentType,
    FlowMessage,
    FlowMessageKind,
    derive_help_request_kind,
)
from flow_sdk.diagnose import DiagnosisEnvironment, DiagnosisSpec, DiagnosisStatus
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.server.routes.bootstrap import get_or_create_local_user
from flow_sdk.storage import get_entity_embedded_storage

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

FOUND = """
from flow_sdk.diagnose import DiagnosisFinding, DiagnosisSpec

def diagnose(ctx):
    return DiagnosisSpec(status="needs_action", title="Backend down", summary="It does not answer.",
                         findings=[DiagnosisFinding(id="A2", severity="error", title="Backend down", detail="Restart.")])
"""


@pytest.fixture(autouse=True)
def task_storage(tmp_path):
    from flow_sdk.request_context import methods as ctx
    from flow_sdk.storage.local_fs_driver import LocalStorageDriver

    ctx.set_default_test_storage_fallback(LocalStorageDriver(str(tmp_path / "blobs")))
    yield
    ctx.set_default_test_storage_fallback(None)


@pytest.fixture(autouse=True)
def hub(tmp_path, monkeypatch):
    """The hub is elsewhere's concern: deliveries are counted, never made. Held context goes to a temp folder."""
    monkeypatch.setattr(afh, "_held_dir", lambda conv_id: tmp_path / "held" / conv_id)
    monkeypatch.setattr(afh, "_local_mode_share_blocked", lambda: False)
    deliver = AsyncMock()
    with (
        patch.object(Conversation, "deliver", deliver),
        patch.object(Conversation, "kick_delivery", lambda *_a, **_k: None),
    ):
        yield deliver


@pytest.fixture(autouse=True)
def diagnose_with(tmp_path, monkeypatch):
    """Make the diagnose ask-for-help runs the one written here (FOUND unless a test writes another)."""

    def use(body: str, timeout_s: float = 5) -> None:
        folder = tmp_path / "diag" / "agentic-assets" / "diagnose" / "mine"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "diagnose.json").write_text(json.dumps({"name": "mine", "timeout_s": timeout_s}))
        (folder / "diagnose.py").write_text(textwrap.dedent(body))

    real = diagnose_pkg.run_diagnose

    async def run(ctx, **kw):
        folder = tmp_path / "diag" / "agentic-assets" / "diagnose" / "mine"
        return await real(ctx, resolve=lambda _p: (folder, diagnose_pkg.resolve_diagnose(folder.parents[2])[1]), **kw)

    monkeypatch.setattr(diagnose_pkg, "run_diagnose", run)
    use(FOUND)
    return use


async def _call(fn, body: dict, conv_id: str | None = None):
    someone = (await get_or_create_local_user()).typeid
    request = SimpleNamespace(
        someone_typeid=someone,
        get_post_data=AsyncMock(return_value=body),
        target_entity_typeid=TypeId(type="conversation", id=conv_id) if conv_id else None,
    )
    with patch.object(afh, "get_current_request_info", return_value=request):
        return await fn()


async def _messages(conv_id: str) -> list[FlowMessage]:
    return await (await Conversation.get_one({"id": conv_id})).messages()


def _files(fm: FlowMessage) -> dict[str, str]:
    storage = get_entity_embedded_storage(fm.typeid)
    return {
        a.data.rsplit("/", 1)[-1]: Path(storage.get_storage_path(a.data)).read_text()
        for a in fm.attachment or []
        if a.attachment_type == AttachmentType.FILE
    }


def _ask(text: str = "my build broke", **over) -> dict:
    return {
        "conversation_id": str(uuid.uuid4()),
        "recipients": [{"kind": "person", "email": "dana@x.test", "name": "Dana"}],
        "text": text,
        **over,
    }


async def _settle() -> None:
    """Wait for the background diagnoses the requests started."""
    import asyncio

    while afh._DIAGNOSING:
        await asyncio.gather(*list(afh._DIAGNOSING))


async def test_the_request_is_written_at_once_and_the_diagnosis_follows_as_its_own_message(hub):
    body = _ask()

    response = await _call(afh.ask_for_help, body)

    assert response.data["diagnosing"] is True and response.data["context_shared"] is True
    (request,) = await _messages(body["conversation_id"])
    assert request.kind == FlowMessageKind.HELP_REQUEST
    assert afh.DIAGNOSIS_FILE not in _files(request), "the request never waits for the diagnosis"
    assert json.loads(_files(request)[HELP_REQUEST_FILE])["diagnosing"] is True
    hub.assert_awaited_once()  # the request is delivered at once: the helper never waits on the diagnosis

    await _settle()

    _request, diagnosis = await _messages(body["conversation_id"])
    assert diagnosis.kind == FlowMessageKind.DIAGNOSIS
    assert json.loads(_files(diagnosis)[afh.DIAGNOSIS_FILE])["title"] == "Backend down"
    assert hub.await_count == 2, "the diagnosis follows as an update of the same conversation"


@pytest.mark.parametrize(
    "body, timeout_s",
    [
        ("def diagnose(ctx):\n    raise RuntimeError('boom')\n", 5),
        ("import time\ndef diagnose(ctx):\n    time.sleep(3)\n", 0.2),
    ],
    ids=["raises", "hangs"],
)
async def test_a_failing_diagnose_still_answers_its_baseline(diagnose_with, body, timeout_s):
    diagnose_with(body, timeout_s)
    ask = _ask()

    await _call(afh.ask_for_help, ask)
    await _settle()

    _request, diagnosis = await _messages(ask["conversation_id"])
    assert json.loads(_files(diagnosis)[afh.DIAGNOSIS_FILE])["status"] == "partial"


async def test_unshared_context_stays_here_and_share_sends_it_later(hub):
    ask = _ask(share_context=False)

    await _call(afh.ask_for_help, ask)
    await _settle()

    request, diagnosis = await _messages(ask["conversation_id"])
    assert set(_files(request)) == {HELP_REQUEST_FILE} and _files(diagnosis) == {}, "nothing left this computer"
    assert afh.DIAGNOSIS_FILE in afh.held_context(ask["conversation_id"])

    shared = await _call(afh.help_request_share, {}, ask["conversation_id"])

    assert afh.DIAGNOSIS_FILE in shared.data["shared"]
    *_, follow = await _messages(ask["conversation_id"])
    assert follow.kind == FlowMessageKind.HELP_REQUEST and afh.DIAGNOSIS_FILE in _files(follow)
    assert afh.held_context(ask["conversation_id"]) == {}


async def test_review_first_sends_nothing_until_share(hub):
    ask = _ask(send="review_first")

    response = await _call(afh.ask_for_help, ask)
    await _settle()

    assert response.data["shared"] is False
    conv = await Conversation.get_one({"id": ask["conversation_id"]})
    assert not conv.hub_bound
    hub.assert_not_awaited()

    await _call(afh.help_request_share, {"left_out": ["logs.txt"]}, ask["conversation_id"])

    conv = await Conversation.get_one({"id": ask["conversation_id"]})
    assert conv.hub_bound
    *_, follow = await _messages(ask["conversation_id"])
    assert "logs.txt" not in _files(follow), "what the person left out stays out"
    hub.assert_awaited()


def _verdict(cause: str, asset: str = "") -> DiagnosisSpec:
    return DiagnosisSpec(status="needs_action", title="Plan route rejects plans", cause=cause, cause_asset=asset)


@pytest.mark.parametrize(
    "cause, asset, adopted, desk, pass_on",
    [
        ("flowpad", "", None, "support-desk", ""),
        ("unknown", "", None, "support-desk", ""),
        ("dependency", "acme-planner", "/w/deps/acme-planner", "acme-desk", ""),
        ("dependency", "plan-kit", None, "support-desk", "plan-kit"),
    ],
    ids=["flowpad", "unknown", "dependency-with-desk", "dependency-no-desk"],
)
async def test_diagnose_and_fix_is_private_until_report_it_sends_it_where_the_cause_points(
    hub, monkeypatch, cause, asset, adopted, desk, pass_on
):
    from flow_sdk.app import helpdesk_resolver
    from flow_sdk.app.actions import flow_message_action

    monkeypatch.setattr(afh, "_diagnose", AsyncMock(return_value=(_verdict(cause, asset), None)))
    monkeypatch.setattr(
        flow_message_action, "_hub_default_helpdesk", AsyncMock(return_value=SimpleNamespace(project_id="support-desk"))
    )
    found = SimpleNamespace(queue_project_id="acme-desk", mount_path=adopted) if adopted else None
    monkeypatch.setattr(helpdesk_resolver, "resolve_adopted_helpdesk", AsyncMock(return_value=found))
    from flow_sdk import notifications

    arrived = AsyncMock()
    monkeypatch.setattr(notifications, "notify_message_arrival", arrived)
    ask = _ask(
        text="Diagnose & fix: Cloud request rejected",
        recipients=[],
        purpose="repair",
        origin="warning",
        project_id=str(uuid.uuid4()),
    )

    await _call(afh.ask_for_help, ask)
    await _settle()

    request, diagnosis = await _messages(ask["conversation_id"])
    assert diagnosis.kind == FlowMessageKind.DIAGNOSIS and _files(diagnosis) == {}, "private: details held here"
    hub.assert_not_awaited()
    # The answer is a message on the Diagnosis channel; its arrival is the one notification.
    assert (await Conversation.get_one({"id": ask["conversation_id"]})).channel == "diagnosis"
    arrived.assert_awaited_once()
    assert arrived.await_args.args == (ask["conversation_id"], diagnosis.id)

    reported = await _call(afh.help_request_report, {}, ask["conversation_id"])

    assert reported.data["pass_on"] == pass_on
    conv = await Conversation.get_one({"id": ask["conversation_id"]})
    assert conv.kind == "helpdesk" and conv.remote_project_id == desk and conv.hub_bound
    assert conv.channel == "diagnosis", "reported, it stays one conversation on the Diagnosis channel"
    *_, line = await _messages(ask["conversation_id"])
    assert afh.DIAGNOSIS_FILE in _files(line)
    assert json.loads(_files(line)[HELP_REQUEST_FILE])["pass_on"] == pass_on
    assert afh.held_context(ask["conversation_id"]) == {}
    hub.assert_awaited()


@pytest.mark.parametrize(
    "status, cause, reportable",
    [
        ("fixed", "project", False),
        ("needs_action", "machine", False),
        ("ok", "flowpad", False),
        ("needs_action", "flowpad", True),
        ("fixed", "dependency", True),
        ("unrecognized", "unknown", True),
    ],
)
def test_a_report_is_offered_only_when_someone_else_owns_the_fix(status, cause, reportable):
    assert DiagnosisSpec(status=status, cause=cause).reportable is reportable


async def test_nobody_to_ask_is_a_private_conversation(hub):
    ask = _ask(recipients=[])

    response = await _call(afh.ask_for_help, ask)
    await _settle()

    assert response.data["shared"] is False
    conv = await Conversation.get_one({"id": ask["conversation_id"]})
    assert not conv.hub_bound and not conv.members
    refused = await _call(afh.help_request_share, {}, ask["conversation_id"])
    assert refused.status_code == 400
    hub.assert_not_awaited()


async def test_left_out_items_are_never_written():
    ask = _ask(left_out=["screen.value.json"])

    await _call(afh.ask_for_help, ask)

    (only,) = await _messages(ask["conversation_id"])
    assert "screen.value.json" not in _files(only)


async def test_the_same_request_sent_again_is_one_message():
    ask = _ask()

    await _call(afh.ask_for_help, ask)
    await _call(afh.ask_for_help, ask)
    await _settle()

    kinds = [m.kind for m in await _messages(ask["conversation_id"])]
    assert kinds.count(FlowMessageKind.HELP_REQUEST) == 1


async def test_a_diagnosis_already_taken_is_attached_as_it_stands(diagnose_with):
    from flow_sdk.builtin.flowpad_diagnosis import FlowpadDiagnosis

    diagnose_with("def diagnose(ctx):\n    raise RuntimeError('must not run')\n")
    value = DiagnosisSpec(
        status=DiagnosisStatus.NEEDS_ACTION, title="Hub unreachable", environment=DiagnosisEnvironment(os="macOS-15")
    )
    record = await FlowpadDiagnosis(
        name="Hub unreachable", title="Hub unreachable", reported_by="me", diagnosis=value.model_dump(mode="json")
    ).save()
    ask = _ask(diagnosis_id=record.id)

    await _call(afh.ask_for_help, ask)

    (only,) = await _messages(ask["conversation_id"])
    sent = json.loads(_files(only)[afh.DIAGNOSIS_FILE])
    assert sent["title"] == "Hub unreachable" and sent["environment"]["os"] == "macOS-15"


async def test_an_unknown_diagnosis_writes_no_request():
    ask = _ask(diagnosis_id=str(uuid.uuid4()))

    response = await _call(afh.ask_for_help, ask)

    assert response.status_code == 404
    assert await Conversation.get_one({"id": ask["conversation_id"]}) is None


async def test_a_receiver_reads_the_kind_from_the_carrier_the_hub_keeps():
    fm = FlowMessage(
        text="help", attachment=[Attachment(attachment_type=AttachmentType.FILE, data=f"data/{HELP_REQUEST_FILE}")]
    )

    derive_help_request_kind(fm)

    assert fm.kind == FlowMessageKind.HELP_REQUEST


async def test_a_desk_and_a_person_each_get_the_request_diagnosed_once(monkeypatch):
    runs = []
    real = afh.capture_context

    async def counted(ask, recorded=None):
        runs.append(ask.conversation_id)
        return await real(ask, recorded)

    monkeypatch.setattr(afh, "capture_context", counted)
    ask = _ask(
        recipients=[{"kind": "desk", "desk_project_id": str(uuid.uuid4())}, {"kind": "person", "email": "dana@x.test"}]
    )

    response = await _call(afh.ask_for_help, ask)

    (ticket_id,) = response.data["also"]
    people = await Conversation.get_one({"id": ask["conversation_id"]})
    ticket = await Conversation.get_one({"id": ticket_id})
    assert people.members and str(getattr(ticket.kind, "value", ticket.kind)) == "helpdesk"
    assert len(await _messages(people.id)) == 1 and len(await _messages(ticket.id)) == 1
    assert len(runs) == 1, "one request is diagnosed once"


def test_the_warning_learns_the_help_desk_replied_only_from_someone_elses_last_word():
    def fm(kind, sender):
        return SimpleNamespace(kind=kind, sender_id=sender)

    def conv(*messages):
        return list(messages)

    asked = [fm("help_request", "me"), fm("diagnosis", "me"), fm("help_request", "me")]
    assert not afh._desk_replied(conv(*asked)), "reported, nobody answered yet"
    assert afh._desk_replied(conv(*asked, fm("user", "dana"))), "the desk answered"
    assert not afh._desk_replied(conv(*asked, fm("user", "dana"), fm("user", "me"))), "the asker spoke last"
