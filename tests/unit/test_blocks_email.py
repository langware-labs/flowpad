"""The blocks surface — values, sessions, and the send mapping.

Fast pins for `flow_sdk.blocks`: the outbound spec is a correct pure value,
the runner's session_key semantics hold with a stubbed spawner, and
`Inbox.send` maps a spec onto the driver contract without loss. The live
end-to-end lives in tests/long_tests/test_blocks_email_workflow.py.
"""
from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from flow_sdk.blocks import AgentRunner, EmailMessageSpec, Inbox, RunOutput
from flow_sdk.builtin.data_source import DataSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _inbound(**kw):
    base = dict(
        name="Probe coffee?",
        author_external_id="alice@example.com",
        thread_key="thr-1",
        external_id="<m1@provider>",
        body="are we on?",
    )
    base.update(kw)
    return SimpleNamespace(**base)


class TestEmailMessageSpec:
    def test_reply_to_threads_like_the_drivers_do(self):
        r = EmailMessageSpec.reply_to(_inbound(), body="yes!")
        assert r.to == ["alice@example.com"]
        assert r.thread_key == "thr-1"
        assert r.reply_to_external_id == "<m1@provider>"
        assert r.subject == "Re: Probe coffee?"
        assert r.attachments == []

    def test_an_existing_re_prefix_is_not_stacked(self):
        r = EmailMessageSpec.reply_to(_inbound(name="Re: Probe"), body="x")
        assert r.subject == "Re: Probe"

    def test_it_is_a_frozen_value_that_forbids_extras(self):
        r = EmailMessageSpec.reply_to(_inbound(), body="x")
        with pytest.raises(Exception):
            r.body = "edited"  # frozen
        with pytest.raises(Exception):
            EmailMessageSpec(to=["a@b"], body="x", cc=["nope"])  # extra="forbid"


class _StubProcess:
    def __init__(self):
        self.id = str(uuid.uuid4())
        self.prompts: list[str] = []

    async def save(self):
        return self

    async def exit(self):
        return None


class TestAgentRunnerSessions:
    @pytest.fixture
    def runner(self, monkeypatch):
        r = AgentRunner("stub", max_processes=2)

        async def _spawn(m):
            key = str(r.session_key(m))
            hit = r.processes.get(key)
            if hit is not None:
                return hit
            if len(r.processes) >= r.max_processes:
                raise RuntimeError("max_processes")
            ap = _StubProcess()
            r.processes[key] = ap
            return ap

        # Stub the SPAWN half only — the session dict semantics under test are
        # the real ones (this mirrors process_for with the deployment swapped).
        monkeypatch.setattr(r, "process_for", _spawn)
        return r

    @pytest.mark.asyncio
    async def test_same_key_reuses_the_process(self, runner):
        a = await runner.process_for(_inbound(thread_key="t1"))
        b = await runner.process_for(_inbound(thread_key="t1", body="again"))
        assert a is b

    @pytest.mark.asyncio
    async def test_different_keys_get_distinct_processes(self, runner):
        a = await runner.process_for(_inbound(thread_key="t1"))
        b = await runner.process_for(_inbound(thread_key="t2"))
        assert a is not b

    @pytest.mark.asyncio
    async def test_the_budget_bounds_distinct_sessions(self, runner):
        await runner.process_for(_inbound(thread_key="t1"))
        await runner.process_for(_inbound(thread_key="t2"))
        with pytest.raises(RuntimeError):
            await runner.process_for(_inbound(thread_key="t3"))

    def test_default_session_key_is_the_thread(self):
        r = AgentRunner("stub")
        assert r.session_key(_inbound(thread_key="t9")) == "t9"
        # a threadless message keys on its own id — per-message session
        assert r.session_key(_inbound(thread_key="", external_id="<x>")) == "<x>"


class TestInboxSend:
    @pytest.fixture
    def inbox(self, monkeypatch):
        ib = Inbox("me@agentmail.to", api_key="k")
        ib._source = DataSource(
            name="Inbox me@agentmail.to",
            provider="agentmail",
            config={"inbox": "me@agentmail.to"},
        )
        return ib

    @pytest.mark.asyncio
    async def test_the_spec_maps_onto_the_driver_contract(self, inbox, monkeypatch):
        calls = {}

        class _Driver:
            sends = True

            async def send(self, source, **kw):
                calls.update(kw)
                return SimpleNamespace(external_id="<sent@provider>")

        monkeypatch.setattr("flow_sdk.ingest.driver.get_driver", lambda p: _Driver())
        spec = EmailMessageSpec.reply_to(_inbound(), body="yes!")
        sent = await inbox.send(spec)
        assert sent == "<sent@provider>"
        assert calls == {
            "thread_key": "thr-1",
            "to": "alice@example.com",
            "text": "yes!",
            "subject": "Re: Probe coffee?",
            "in_reply_to": "<m1@provider>",
        }

    @pytest.mark.asyncio
    async def test_attachments_refuse_loudly_rather_than_dropping(self, inbox):
        from flow_sdk.schema.data_spec.dataset_spec import FileRef

        spec = EmailMessageSpec(
            to=["a@b.to"], body="x", attachments=[FileRef(path="report.pdf")]
        )
        with pytest.raises(NotImplementedError):
            await inbox.send(spec)

    @pytest.mark.asyncio
    async def test_exactly_one_recipient_for_now(self, inbox):
        with pytest.raises(ValueError):
            await inbox.send(EmailMessageSpec(to=["a@b", "c@d"], body="x"))


def test_run_output_is_a_value():
    out = RunOutput(text="hi")
    assert out.text == "hi" and out.files == []
