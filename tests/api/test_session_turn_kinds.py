"""A live session runs the kinds of turn its host approved, and nothing else.

The guest asks for kinds (prompt, command, control), the host leaves some ticked at
Approve, and every turn names its kind on its carrier. A command runs in the session's
folder with no worker and no LLM; its exit code and output are the answer.
"""

from __future__ import annotations

import json
import uuid

import pytest

from flow_sdk.app.actions import execute_prompt as ep
from flow_sdk.builtin.flow_message import Attachment, AttachmentType, FlowMessage, turn_kind_of
from flow_sdk.builtin.remote_worker_session import ALL_TURN_KINDS, RemoteWorkerSession, scratch_workdir
from flow_sdk.builtin.remote_worker_session import RemoteWorkerSessionStatus as S
from tests.api._session_helpers import make_conversation, make_session
from tests.api.test_run_session_turn import fake_worker  # noqa: F401 — the shared worker seam

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

ASKED_ALL = list(ALL_TURN_KINDS)


def _turn(conv_id: str, session_id: str, kind: str, text: str) -> FlowMessage:
    """A guest's turn as it arrives on the host: the text to run, and its kind on the carrier."""
    fm = FlowMessage(
        text="please run this",
        sender_id="guest-remote",
        sender_name="Bob",
        conversation_id=conv_id,
        remote_worker_session_id=session_id,
        attachment=[
            Attachment(attachment_type=AttachmentType.PROMPT, data=text),
            Attachment(
                attachment_type=AttachmentType.TYPE_ID,
                data=f"remote_worker_session-{session_id}",
                prompt_preview=json.dumps({"turn": {"kind": kind}}),
            ),
        ],
    )
    fm.id = str(uuid.uuid4())
    return fm


async def _run(conv_id: str, session_id: str, kind: str, text: str) -> list[FlowMessage]:
    """Deliver one turn through the real inbound gate; answer what the session then holds."""
    fm = _turn(conv_id, session_id, kind, text)
    await fm.save(notify=False)
    await ep.process_inbound_prompt(fm.id, conv_id)
    return [m for m in await FlowMessage.get_all({"conversation_id": conv_id}) if m.id != fm.id]


async def _approved(client, kinds: list[str], **session) -> tuple[str, RemoteWorkerSession]:
    conv_id = await make_conversation(client)
    rws = await make_session(conv_id, S.PENDING.value, requested_turn_kinds=ASKED_ALL, **session)
    resp = await client.post(
        f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={"scratch": True, "turn_kinds": kinds}
    )
    assert resp.json().get("status") == "SUCCESS", resp.text
    return conv_id, await RemoteWorkerSession.get_one({"id": rws.id})


@pytest.mark.parametrize(
    ("ticked", "approved"),
    [(None, ASKED_ALL), (["prompt", "command"], ["prompt", "command"]), (["command"], ["command"])],
)
async def test_approve_keeps_what_the_host_left_ticked(bootstrapped_client, user, ticked, approved):
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.PENDING.value, requested_turn_kinds=ASKED_ALL)
    body = {"scratch": True, **({"turn_kinds": ticked} if ticked is not None else {})}
    resp = await bootstrapped_client.post(f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json=body)
    assert resp.json().get("status") == "SUCCESS", resp.text
    after = await RemoteWorkerSession.get_one({"id": rws.id})
    assert after.turn_kinds == approved and after.snapshot()["turn_kinds"] == approved  # the guest is told


@pytest.mark.parametrize(
    ("asked", "ticked"),
    [(ASKED_ALL, []), (["prompt"], ["prompt", "command"]), (ASKED_ALL, ["prompt", "format-the-disk"])],
)
async def test_approve_refuses_nothing_ticked_and_more_than_was_asked(bootstrapped_client, user, asked, ticked):
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.PENDING.value, requested_turn_kinds=asked)
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/remote_worker_session/{rws.id}/approve", json={"scratch": True, "turn_kinds": ticked}
    )
    assert resp.status_code == 400, resp.text
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.PENDING.value


async def test_a_prompt_request_and_an_older_guest_are_prompts_only(bootstrapped_client, user):
    one_prompt = RemoteWorkerSession(prompt_limit=1, requested_turn_kinds=ASKED_ALL, turn_kinds=ASKED_ALL)
    older_guest = RemoteWorkerSession()  # asks for nothing: it predates the field
    assert one_prompt.effective_turn_kinds == older_guest.effective_turn_kinds == ["prompt"]
    # A guest's snapshot never writes what the host approved onto a fresh host row.
    minted = RemoteWorkerSession.apply_snapshot(
        None, {"id": str(uuid.uuid4()), "requested_turn_kinds": ASKED_ALL, "turn_kinds": ASKED_ALL}, local_is_host=True
    )
    assert minted.turn_kinds is None and minted.requested_turn_kinds == ASKED_ALL


async def test_a_command_runs_in_the_session_folder_and_answers_with_its_result(bootstrapped_client, user, fake_worker):  # noqa: F811
    conv_id, rws = await _approved(bootstrapped_client, ASKED_ALL)

    msgs = await _run(conv_id, rws.id, "command", "echo from-the-host && pwd")

    [reply] = [m for m in msgs if (m.text or "").startswith("exit ")]
    assert reply.text.splitlines()[:2] == ["exit 0", "from-the-host"]
    assert reply.text.splitlines()[2].endswith(scratch_workdir().name)  # where the session runs
    assert turn_kind_of(reply) == "command"  # the views label the answer by it
    assert fake_worker["prompts"] == []  # no worker, no LLM
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.IDLE.value


async def test_a_command_that_fails_is_an_answer_not_a_failed_session(bootstrapped_client, user):
    conv_id, rws = await _approved(bootstrapped_client, ASKED_ALL)

    msgs = await _run(conv_id, rws.id, "command", "echo broke 1>&2; exit 3")

    assert [m.text for m in msgs if (m.text or "").startswith("exit ")] == ["exit 3\nbroke"]
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.IDLE.value


@pytest.mark.parametrize("kind", ["command", "format-the-disk"])
async def test_a_kind_the_host_did_not_approve_is_refused_and_nothing_runs(bootstrapped_client, user, tmp_path, kind):
    conv_id, rws = await _approved(bootstrapped_client, ["prompt"])
    proof = tmp_path / "ran"

    msgs = await _run(conv_id, rws.id, kind, f"touch {proof}")

    assert any(f"a {kind} is not approved for this live session" in (m.text or "") for m in msgs)
    assert not proof.exists()


async def test_the_sender_refuses_a_kind_the_host_did_not_report(bootstrapped_client, user):
    """A host that predates turn kinds reports none, and would run a command as a prompt."""
    conv_id = await make_conversation(bootstrapped_client)
    rws = await make_session(conv_id, S.IDLE.value)  # approved by an older host: no turn_kinds
    resp = await bootstrapped_client.post(
        f"/api/v1/graph/conversation/{conv_id}/add_message",
        json={"text": "check", "prompt_text": "flow llm list", "remote_worker_session_id": rws.id, "turn_kind": "command"},
    )
    assert resp.status_code == 409, resp.text
    assert not await FlowMessage.get_all({"conversation_id": conv_id})


async def test_an_interrupted_command_is_reported_once_and_never_run_again(bootstrapped_client, user):
    conv_id, rws = await _approved(bootstrapped_client, ASKED_ALL)
    fm = _turn(conv_id, rws.id, "command", "echo twice")
    fm.prompt_auto_handled = True  # consumed, then the host stopped before any answer
    await fm.save(notify=False)

    await ep._release_interrupted_turn(rws, [fm], str(user.typeid))

    assert (await FlowMessage.get_one({"id": fm.id})).prompt_auto_handled is True  # not given back to the queue
    texts = [m.text or "" for m in await FlowMessage.get_all({"conversation_id": conv_id})]
    assert any("restarted while this command ran — it was not run again" in t for t in texts)


async def test_a_script_fails_the_turn_when_the_host_has_no_flowpad_tab_open(bootstrapped_client, user):
    conv_id, rws = await _approved(bootstrapped_client, ASKED_ALL)

    msgs = await _run(conv_id, rws.id, "control", "return 1")

    assert any("No Flowpad tab is open on this machine" in (m.text or "") for m in msgs)


@pytest.mark.parametrize(
    ("tab_says", "answer"),
    [
        ({"ok": True, "value": {"login": "signed_out"}}, 'returned\n{\n "login": "signed_out"\n}'),
        ({"ok": False, "error": "TypeError: x is not a function"}, "threw\nTypeError: x is not a function"),
    ],
)
async def test_a_script_runs_in_the_hosts_tab_and_its_value_or_its_throw_is_the_answer(
    bootstrapped_client, user, monkeypatch, tab_says, answer
):
    from flow_sdk.core import navigate
    from flow_sdk.notifications import tab_script, ui_command

    sent: list[dict] = []

    async def to_the_tab(ws, kind, **fields):  # the tab answers at once, as the listener does
        sent.append({"kind": kind, **fields})
        tab_script.script_answered({"request_id": fields["request_id"], **tab_says})

    monkeypatch.setattr(navigate, "pick_connection", lambda connection_id: ("tab-1", object()))
    monkeypatch.setattr(ui_command, "send_ui_command", to_the_tab)
    conv_id, rws = await _approved(bootstrapped_client, ASKED_ALL)

    msgs = await _run(conv_id, rws.id, "control", "return await sdk.status()")

    assert [(s["kind"], s["code"]) for s in sent] == [("run_script", "return await sdk.status()")]
    assert answer in [m.text for m in msgs]
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.IDLE.value
    assert tab_script._waiting == {}


async def test_a_script_is_answered_at_once_when_its_tab_closes(monkeypatch):
    import asyncio

    from flow_sdk.core import navigate
    from flow_sdk.notifications import tab_script, ui_command

    async def never_answers(ws, kind, **fields):
        asyncio.get_running_loop().call_soon(tab_script.tab_closed, "tab-1")

    monkeypatch.setattr(navigate, "pick_connection", lambda connection_id: ("tab-1", object()))
    monkeypatch.setattr(ui_command, "send_ui_command", never_answers)

    answer = await tab_script.run_script_in_tab("await new Promise(() => {})")

    assert answer == {"ok": False, "error": "the Flowpad tab closed before the script answered"}


async def test_ending_the_session_stops_the_command_it_is_running(bootstrapped_client, user, tmp_path):
    import asyncio

    conv_id, rws = await _approved(bootstrapped_client, ASKED_ALL)
    proof = tmp_path / "finished"
    running = asyncio.create_task(_run(conv_id, rws.id, "command", f"sleep 20; touch {proof}"))
    while rws.id not in ep._RUNNING_COMMANDS:  # the command is up (the test's 30s cap bounds this)
        await asyncio.sleep(0.02)

    await (await RemoteWorkerSession.get_one({"id": rws.id})).end("ended", announce=False)
    msgs = await running

    assert any("[stopped: the live session ended]" in (m.text or "") for m in msgs)
    assert not proof.exists()
    assert (await RemoteWorkerSession.get_one({"id": rws.id})).status == S.ENDED.value


async def test_a_long_output_answers_with_its_end_and_rides_whole_as_a_file(bootstrapped_client, user):
    conv_id, rws = await _approved(bootstrapped_client, ASKED_ALL)

    msgs = await _run(conv_id, rws.id, "command", "python3 -c \"print('a' * 20000 + 'THE-END')\"")

    [reply] = [m for m in msgs if (m.text or "").startswith("exit 0")]
    assert reply.text.endswith("THE-END") and len(reply.text) < 9000
    assert any(a.attachment_type == AttachmentType.FILE and "command-output.txt" in a.data for a in reply.attachment)


async def test_turns_that_arrived_while_the_host_was_away_run_once_it_catches_up(bootstrapped_client, user):
    """The hub's catch-up stores a missed turn and kicks nothing: the queue is drained after it."""
    me, _ = await ep._local_me()
    conv_id, rws = await _approved(bootstrapped_client, ASKED_ALL, host_user_id=me)  # a session THIS machine hosts
    for n in (1, 2):
        await _turn(conv_id, rws.id, "command", f"echo missed-{n}").save(notify=False)  # stored, gate not kicked

    await ep.redrive_hosted_sessions()

    got = [m.text for m in await FlowMessage.get_all({"conversation_id": conv_id}) if (m.text or "").startswith("exit ")]
    assert sorted(got) == ["exit 0\nmissed-1", "exit 0\nmissed-2"]
