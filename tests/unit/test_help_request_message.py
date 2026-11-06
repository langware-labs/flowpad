"""Ask for help is a conversation and ONE ``help_request`` message: the person's words, and as ordinary file
attachments the diagnosis and the context they chose to share. Unshared context waits on this computer until
Share; nobody to ask makes the conversation private.

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


async def test_the_request_is_one_message_carrying_its_diagnosis_and_context(hub):
    body = _ask()

    response = await _call(afh.ask_for_help, body)

    assert response.data["shared"] is True and response.data["context_shared"] is True
    (only,) = await _messages(body["conversation_id"])
    assert only.kind == FlowMessageKind.HELP_REQUEST
    files = _files(only)
    assert {HELP_REQUEST_FILE, afh.DIAGNOSIS_FILE, "screen.value.json"} <= set(files)
    assert json.loads(files[afh.DIAGNOSIS_FILE])["title"] == "Backend down"
    assert json.loads(files[HELP_REQUEST_FILE])["context_shared"] is True
    hub.assert_awaited()


@pytest.mark.parametrize(
    "body, timeout_s",
    [("def diagnose(ctx):\n    raise RuntimeError('boom')\n", 5), ("import time\ndef diagnose(ctx):\n    time.sleep(3)\n", 0.2)],
    ids=["raises", "hangs"],
)
async def test_a_failing_diagnose_still_sends_the_request_with_its_baseline(diagnose_with, body, timeout_s):
    diagnose_with(body, timeout_s)
    ask = _ask()

    await _call(afh.ask_for_help, ask)

    (only,) = await _messages(ask["conversation_id"])
    assert json.loads(_files(only)[afh.DIAGNOSIS_FILE])["status"] == "partial"


async def test_unshared_context_stays_here_and_share_sends_it_later(hub):
    ask = _ask(share_context=False)

    await _call(afh.ask_for_help, ask)

    (request,) = await _messages(ask["conversation_id"])
    assert set(_files(request)) == {HELP_REQUEST_FILE}, "nothing of the context left this computer"
    assert afh.DIAGNOSIS_FILE in afh.held_context(ask["conversation_id"])

    shared = await _call(afh.help_request_share, {}, ask["conversation_id"])

    assert afh.DIAGNOSIS_FILE in shared.data["shared"]
    _request, follow = await _messages(ask["conversation_id"])
    assert follow.kind == FlowMessageKind.HELP_REQUEST and afh.DIAGNOSIS_FILE in _files(follow)
    assert afh.held_context(ask["conversation_id"]) == {}


async def test_review_first_sends_nothing_until_share(hub):
    ask = _ask(send="review_first")

    response = await _call(afh.ask_for_help, ask)

    assert response.data["shared"] is False
    conv = await Conversation.get_one({"id": ask["conversation_id"]})
    assert not conv.hub_bound
    hub.assert_not_awaited()

    await _call(afh.help_request_share, {"left_out": ["logs.txt"]}, ask["conversation_id"])

    conv = await Conversation.get_one({"id": ask["conversation_id"]})
    assert conv.hub_bound
    _request, follow = await _messages(ask["conversation_id"])
    assert "logs.txt" not in _files(follow), "what the person left out stays out"
    hub.assert_awaited()


async def test_nobody_to_ask_is_a_private_conversation(hub):
    ask = _ask(recipients=[])

    response = await _call(afh.ask_for_help, ask)

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

    assert len(await _messages(ask["conversation_id"])) == 1


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
    fm = FlowMessage(text="help", attachment=[Attachment(attachment_type=AttachmentType.FILE, data=f"data/{HELP_REQUEST_FILE}")])

    derive_help_request_kind(fm)

    assert fm.kind == FlowMessageKind.HELP_REQUEST
