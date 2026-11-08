"""IT Sessions on a box (``core/compute/it_session``) and the hub's door to it (``server/routes/it_session``)."""

import asyncio
import base64
import json
import re
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

import flow_sdk.instance_settings as instance_settings
from flow_sdk.cloud_client import auth_state
from flow_sdk.core.compute import it_session
from flow_sdk.schema.data_spec.returned_value_spec import PromptResult
from flow_sdk.server.routes import it_session as route

SECRET = "gate-secret-for-the-hub"
PERSON = {"status": "logged_in", "user": {"id": "user-1", "email": "student@example.com"}, "reason": None}
NOBODY = {"status": "logged_out", "user": None, "reason": None}
SHAPE = {
    "type": "object",
    "required": ["summary", "tasks"],
    "properties": {"summary": {"type": "string"}, "tasks": {"type": "array"}},
}


@pytest.fixture
def box(tmp_path, monkeypatch):
    """An instance folder of its own (never the real one), signed out, IT Sessions at its default."""
    settings = SimpleNamespace(instance_dir=tmp_path / "instance", records_root=tmp_path / "records")
    settings.instance_dir.mkdir()
    monkeypatch.setattr(instance_settings, "get_instance_settings", lambda: settings)
    login = {"block": NOBODY}
    monkeypatch.setattr(auth_state, "login_block", lambda: login["block"])
    monkeypatch.setattr(it_session, "SIGN_IN_POLL_SECONDS", 0.01)
    return SimpleNamespace(settings=settings, login=login, project=tmp_path / "project")


def _receipt_path(prompt: str) -> Path:
    return Path(re.search(r"exactly this path:\s+(\S+)", prompt).group(1))


def _launch(box, receipt, launched, *, hold: asyncio.Event | None = None):
    """The process-launch edge: a real AgenticProcess row, a records folder and a transcript, like a run makes."""

    async def launch(**kwargs):
        from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

        process = await AgenticProcess(name=kwargs["name"], visible=False, pty_mode=False).save()
        executor = str(process.typeid)
        (box.settings.records_root / "agentic_process" / str(process.id) / "execution").mkdir(parents=True)
        launched.append({**kwargs, "executor": executor, "process_id": process.id})
        kwargs["on_status"](SimpleNamespace(executor=executor))
        if hold is not None:
            await hold.wait()
        if receipt is not None:
            _receipt_path(kwargs["prompt"]).write_text(json.dumps(receipt))
        return PromptResult.satisfied("ran", text="the agent's reply", executor=executor)

    return launch


async def _process_row(process_id):
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    return await AgenticProcess.get_one({"id": process_id})


def _left_behind(box) -> list[Path]:
    root = box.settings.instance_dir / it_session.SESSIONS_DIR
    return list(root.iterdir()) if root.is_dir() else []


# ── the preference and the gates ─────────────────────────────────────────


def test_pref_defaults_off(box):
    assert it_session.it_sessions_on() is False
    assert it_session.refusal() == it_session.OFF


def test_setting_writes_the_preference_file(box):
    assert it_session.set_it_sessions(True) is True
    prefs = json.loads((box.settings.instance_dir / "preferences.json").read_text())
    assert prefs[it_session.PREF_IT_SESSIONS] is True
    assert it_session.refusal() is None


def test_signed_in_person_refuses(box):
    it_session.set_it_sessions(True)
    box.login["block"] = PERSON
    assert it_session.status() == {"on": True, "signed_in": True}
    assert it_session.refusal() == it_session.SIGNED_IN


def test_agent_identity_login_is_not_a_person(box):
    box.login["block"] = {**PERSON, "user": {"id": "identity-abc", "name": "Game Builder"}}
    assert it_session.person_signed_in() is False
    box.login["block"] = {**PERSON, "user": {"id": "x", "kind": "identity"}}
    assert it_session.person_signed_in() is False


def test_shape_mismatch():
    assert it_session.shape_mismatch({"summary": "ok", "tasks": []}, SHAPE) is None
    assert "summary" in it_session.shape_mismatch({"tasks": []}, SHAPE)


def test_attachments_stay_in_their_folder(tmp_path):
    payload = base64.b64encode(b"hello").decode()
    written = it_session.write_attachments(tmp_path / "att", [{"name": "../../escape.txt", "content_b64": payload}])
    assert written == [tmp_path / "att" / "escape.txt"]
    assert written[0].read_bytes() == b"hello"


def test_startup_sweep_clears_leftovers(box):
    leftover = box.settings.instance_dir / it_session.SESSIONS_DIR / "it-dead"
    leftover.mkdir(parents=True)
    (leftover / "result.json").write_text("{}")
    assert it_session.sweep_leftovers() == 1
    assert _left_behind(box) == []


# ── the run leaves nothing behind ────────────────────────────────────────


async def test_run_answers_its_value_and_leaves_nothing(box, monkeypatch):
    from flow_sdk.builtin.flow_message import FlowMessage

    launched = []
    value = {"summary": "Snake works.", "tasks": [{"name": "Build game", "status": "done"}]}
    receipt = {"status": "done", "summary": "Snake is built and runs.", "data": {it_session.VALUE_KEY: value}}
    monkeypatch.setattr("flow_sdk.core.compute.process_step.launch_step_process", _launch(box, receipt, launched))
    box.project.mkdir()
    messages_before = len(await FlowMessage.get_all({}))
    att = [{"name": "class-status.md", "content_b64": base64.b64encode(b"# skill").decode()}]

    answer = await it_session.run_it_session(
        call_id="call-1", text="Check progress", attachments=att, answer_shape=SHAPE, workdir=box.project
    )

    assert answer.as_data() == {"answer": "Snake is built and runs.", "value": value}
    run = launched[0]
    assert run["workdir"] == box.project and run["remember_prompt"] is False
    assert "class-status.md" in run["prompt"]
    # Nothing stays: no process row, no records folder, no temp folder, no messages.
    assert await _process_row(run["process_id"]) is None
    assert not (box.settings.records_root / "agentic_process" / str(run["process_id"])).exists()
    assert _left_behind(box) == []
    assert not any(box.project.rglob("result.json"))
    assert len(await FlowMessage.get_all({})) == messages_before


async def test_value_off_its_shape_is_null_and_says_why(box, monkeypatch):
    receipt = {"status": "done", "summary": "Answered.", "data": {it_session.VALUE_KEY: {"tasks": "nope"}}}
    monkeypatch.setattr("flow_sdk.core.compute.process_step.launch_step_process", _launch(box, receipt, []))
    answer = await it_session.run_it_session(call_id="c2", text="x", answer_shape=SHAPE, workdir=box.settings.instance_dir)
    assert answer.value is None
    assert "does not match its shape" in answer.answer


async def test_plain_answer_without_a_shape(box, monkeypatch):
    receipt = {"status": "done", "summary": "s", "data": {it_session.OUTCOME_KEY: "All 4 tasks done."}}
    monkeypatch.setattr("flow_sdk.core.compute.process_step.launch_step_process", _launch(box, receipt, []))
    answer = await it_session.run_it_session(call_id="c3", text="x", workdir=box.settings.instance_dir)
    assert answer.as_data() == {"answer": "All 4 tasks done.", "value": None}


async def test_sign_in_mid_run_cancels_and_cleans(box, monkeypatch):
    launched, hold = [], asyncio.Event()
    monkeypatch.setattr(
        "flow_sdk.core.compute.process_step.launch_step_process", _launch(box, None, launched, hold=hold)
    )
    run = asyncio.ensure_future(it_session.run_it_session(call_id="c4", text="x", workdir=box.settings.instance_dir))
    while not launched:
        await asyncio.sleep(0.01)
    box.login["block"] = PERSON  # a student signs in
    answer = await asyncio.wait_for(run, 5)
    assert answer.answer == it_session.CANCELLED_BY_SIGN_IN and answer.value is None
    assert await _process_row(launched[0]["process_id"]) is None
    assert not (box.settings.records_root / "agentic_process" / str(launched[0]["process_id"])).exists()
    assert _left_behind(box) == []


# ── the route: the hub's hop only ────────────────────────────────────────


@pytest.fixture
def client(box, monkeypatch):
    monkeypatch.setattr("flow_sdk.instance_settings.cookie_gate.get_cookie_gate", lambda: SECRET)
    app = FastAPI()
    app.include_router(route.router)
    return TestClient(app)


HUB = {"x-cookie-gate": SECRET}


def test_routes_refuse_anyone_but_the_hub(client):
    # The box's own UI (no header), a grant-cookie holder, and a wrong secret are all refused.
    assert client.get("/api/v1/it-session/status").status_code == 403
    client.cookies.set("flowpad_gate", SECRET)
    assert client.get("/api/v1/it-session/status").status_code == 403
    client.cookies.clear()
    assert client.post("/api/v1/it-session/setting", json={"on": True}, headers={"x-cookie-gate": "x"}).status_code == 403
    assert client.post("/api/v1/it-session/run", json={"call_id": "c", "text": "t"}).status_code == 403


def test_unarmed_box_refuses_everyone(client, monkeypatch):
    monkeypatch.setattr("flow_sdk.instance_settings.cookie_gate.get_cookie_gate", lambda: None)
    assert client.get("/api/v1/it-session/status", headers=HUB).status_code == 403


def test_status_and_setting_from_the_hub(client):
    assert client.get("/api/v1/it-session/status", headers=HUB).json()["data"] == {"on": False, "signed_in": False}
    res = client.post("/api/v1/it-session/setting", json={"on": True}, headers=HUB)
    assert res.status_code == 200 and res.json()["data"] == {"on": True}
    assert client.post("/api/v1/it-session/setting", json={"on": "yes"}, headers=HUB).status_code == 400


def test_run_refused_when_off_or_signed_in(client, box):
    body = {"call_id": "c", "text": "Check progress", "attachments": [], "answer_shape": None, "timeout_s": 60}
    off = client.post("/api/v1/it-session/run", json=body, headers=HUB)
    assert off.status_code == 409 and off.json()["data"] == {"reason": "off"}
    client.post("/api/v1/it-session/setting", json={"on": True}, headers=HUB)
    box.login["block"] = PERSON
    signed = client.post("/api/v1/it-session/run", json=body, headers=HUB)
    assert signed.status_code == 409 and signed.json()["data"] == {"reason": "signed_in"}


def test_run_from_the_hub_answers(client, box, monkeypatch):
    receipt = {"status": "done", "summary": "s", "data": {it_session.OUTCOME_KEY: "Fine."}}
    monkeypatch.setattr("flow_sdk.core.compute.process_step.launch_step_process", _launch(box, receipt, []))
    monkeypatch.setattr(it_session, "project_workdir", lambda: _async(box.settings.instance_dir))
    client.post("/api/v1/it-session/setting", json={"on": True}, headers=HUB)
    res = client.post("/api/v1/it-session/run", json={"call_id": "c5", "text": "How is it going?"}, headers=HUB)
    assert res.status_code == 200 and res.json()["data"] == {"answer": "Fine.", "value": None}


async def _async(value):
    return value


# ── a machine's reply, as the desktop keeps it ──────────────────────────


def test_it_reply_rides_the_hub_metadata():
    from flow_sdk.builtin.conversation import ConversationKind
    from flow_sdk.builtin.flow_message import FlowMessage, derive_it_reply

    it = {"node_typeid": "compute_node-1", "code_last4": "H8LC", "state": "off", "woke": False, "value": None}
    payload = {"id": "fm-1", "text": "", "metadata": {"it": it}}
    fm = FlowMessage.model_validate(payload)
    derive_it_reply(fm, payload)
    assert fm.it_reply == it
    derive_it_reply(fm, {"text": "no metadata"})  # a refresh without it keeps what arrived
    assert fm.it_reply == it
    assert ConversationKind.IT == "it"
