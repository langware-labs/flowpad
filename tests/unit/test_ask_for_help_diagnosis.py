""" "Send diagnostic": the request is written and answered at once; a diagnosis follows it as its own
message, carrying ``diagnosis.value.json`` -- also when the diagnose fails or hangs.

The hub hop is the one seam replaced (``Conversation.deliver``); capture, the diagnose runner and
the message send are real. The diagnose is a project-style one in a temp folder.
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
from flow_sdk.builtin.flow_message import AttachmentType, FlowMessage
from flow_sdk.diagnose import DiagnosisSpec, DiagnosisStatus
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
def no_hub():
    """The hub is elsewhere's concern -- for the request AND for the diagnosis sent after it."""
    with (
        patch.object(Conversation, "deliver", AsyncMock()),
        patch.object(Conversation, "kick_delivery", lambda *_a, **_k: None),
    ):
        yield


@pytest.fixture
def diagnose_with(tmp_path, monkeypatch):
    """Make the diagnose ask-for-help runs the one written here."""

    def use(body: str, timeout_s: float = 5) -> None:
        folder = tmp_path / "diag" / "agentic-assets" / "diagnose" / "mine"
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "diagnose.json").write_text(json.dumps({"name": "mine", "timeout_s": timeout_s}))
        (folder / "diagnose.py").write_text(textwrap.dedent(body))
        real = diagnose_pkg.run_diagnose

        async def run(ctx, **kw):
            return await real(
                ctx, resolve=lambda _p: (folder, diagnose_pkg.resolve_diagnose(folder.parents[2])[1]), **kw
            )

        monkeypatch.setattr(diagnose_pkg, "run_diagnose", run)

    return use


async def _ask(body: dict):
    someone = (await get_or_create_local_user()).typeid
    request = SimpleNamespace(someone_typeid=someone, get_post_data=AsyncMock(return_value=body))
    with patch.object(afh, "get_current_request_info", return_value=request):
        return await afh.ask_for_help()


async def _diagnosed(conv_id: str) -> None:
    task = afh._DIAGNOSING.get(conv_id)
    if task is not None:
        await task


async def _messages(conv_id: str) -> list[FlowMessage]:
    return await (await Conversation.get_one({"id": conv_id})).messages()


def _diagnosis_of(fm: FlowMessage) -> dict:
    files = [a.data for a in fm.attachment or [] if a.attachment_type == AttachmentType.FILE]
    assert files == [f"data/{afh.DIAGNOSIS_FILE}"], files
    path = Path(get_entity_embedded_storage(fm.typeid).get_storage_path(files[0]))
    return json.loads(path.read_text())


def _person(text: str = "my build broke", **over) -> dict:
    return {
        "conversation_id": str(uuid.uuid4()),
        "recipient": {"kind": "person", "email": "dana@x.test", "name": "Dana"},
        "text": text,
        "diagnose": True,
        **over,
    }


async def test_the_diagnosis_follows_the_request_as_its_own_message(diagnose_with):
    diagnose_with(FOUND)
    body = _person()

    response = await _ask(body)
    assert response.data["diagnosing"] is True, "the run started; the dialog flies to the footer"
    await _diagnosed(body["conversation_id"])

    request, follow = await _messages(body["conversation_id"])
    assert request.text == "my build broke" and request.id == response.data["message_id"]
    assert follow.text == "Diagnostic: Backend down" and follow.outbound, "the outbox owns it like any message of mine"
    sent = _diagnosis_of(follow)
    assert sent["spec_kind"] == "diagnosis", "the file names its kind: it opens in the diagnosis viewer"
    diagnosis = DiagnosisSpec.model_validate({k: v for k, v in sent.items() if k != "spec_kind"})
    assert (diagnosis.status, diagnosis.diagnose, diagnosis.symptoms) == (
        DiagnosisStatus.NEEDS_ACTION,
        "mine",
        "my build broke",
    )
    assert diagnosis.context.purpose == "report" and diagnosis.context.origin == "vibe"
    assert diagnosis.environment.os, "the asker's machine travels with it"


async def test_a_diagnosis_faster_than_the_first_delivery_still_says_it_ran(diagnose_with):
    """Seen live: the sweep finished while the inline delivery was still at the hub, and the
    answer said ``diagnosing: false`` -- so the dialog never flew into the footer."""
    diagnose_with(FOUND)
    body = _person()

    async def slow_hub(conv, *_a, **_k):
        await _diagnosed(conv.id)  # the diagnosis is done before delivery returns

    with patch.object(Conversation, "deliver", slow_hub):
        response = await _ask(body)

    assert response.data["diagnosing"] is True
    assert len(await _messages(body["conversation_id"])) == 2


@pytest.mark.parametrize(
    ("body", "timeout_s", "reason"),
    [
        ("def diagnose(ctx):\n    raise RuntimeError('boom')\n", 5, "mine failed: RuntimeError: boom"),
        (
            "import threading\ndef diagnose(ctx):\n    threading.Event().wait()\n",
            0.3,
            "mine did not finish within 0.3s",
        ),
    ],
    ids=["failing", "hanging"],
)
async def test_a_failing_or_hanging_diagnose_still_sends_its_best_effort(diagnose_with, body, timeout_s, reason):
    diagnose_with(body, timeout_s)
    ask = _person()

    await _ask(ask)
    await _diagnosed(ask["conversation_id"])

    _request, follow = await _messages(ask["conversation_id"])
    sent = _diagnosis_of(follow)
    assert sent["status"] == "partial" and sent["errors"] == [reason]
    assert sent["environment"]["os"] and sent["symptoms"] == "my build broke"
    assert follow.text == "Diagnostic: Diagnosis incomplete"


async def test_unticked_sends_the_request_alone(diagnose_with):
    diagnose_with(FOUND)
    ask = _person(diagnose=False)

    response = await _ask(ask)

    assert response.data["diagnosing"] is False and ask["conversation_id"] not in afh._DIAGNOSING
    assert len(await _messages(ask["conversation_id"])) == 1


async def test_the_same_request_sent_again_is_diagnosed_once(diagnose_with):
    diagnose_with(FOUND)
    ask = _person()

    await _ask(ask)
    await _diagnosed(ask["conversation_id"])
    again = await _ask(ask)
    await _diagnosed(ask["conversation_id"])

    assert again.data["diagnosing"] is False
    assert len(await _messages(ask["conversation_id"])) == 2


async def test_a_desk_is_told_what_was_found_in_the_text(diagnose_with):
    diagnose_with(FOUND)
    ask = {"conversation_id": str(uuid.uuid4()), "recipient": {"kind": "desk"}, "text": "help", "diagnose": True}

    with patch("flow_sdk.app.actions.flow_message_action._last_known_desk", return_value=None):
        await _ask(ask)
    await _diagnosed(ask["conversation_id"])

    _request, follow = await _messages(ask["conversation_id"])
    assert follow.text.splitlines() == ["Diagnostic: Backend down", "It does not answer.", "- Backend down: Restart."]
