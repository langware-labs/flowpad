"""The blocks surface — values, sessions, and the send mapping.

Fast pins for `flow_sdk.blocks`: the outbound spec is a correct pure value,
the runner's session_key semantics hold with a stubbed spawner, and
`Inbox.send` maps a spec onto the driver contract without loss. The live
end-to-end lives in tests/long_tests/test_blocks_email_workflow.py.
"""
from __future__ import annotations

import asyncio
import uuid
from types import SimpleNamespace

import pytest

import flow_sdk.blocks as blocks
from flow_sdk.blocks import EmailMessageSpec, Inbox, RunOutput, _AgentRunner
from flow_sdk.builtin.agent import Agent
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
        self.saved = False
        self.exited = False

    async def save(self):
        self.saved = True
        return self

    async def exit(self):
        self.exited = True
        return None


class _DelayedDeployment:
    def __init__(self, process):
        self.process = process
        self.started = asyncio.Event()
        self.finish = asyncio.Event()
        self.spawn_count = 0

    async def resolve(self, _agent):
        return self

    async def create_process(self, _prompt, **_options):
        self.spawn_count += 1
        self.started.set()
        await self.finish.wait()
        return self.process

    def install(self, monkeypatch):
        monkeypatch.setattr(
            "flow_sdk.builtin.agent_registry.get_agent_local_deployment",
            self.resolve,
        )


class TestPrivateAgentRunnerSessions:
    @pytest.fixture
    def runner(self, monkeypatch):
        r = _AgentRunner("stub", max_processes=2)

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
        r = _AgentRunner("stub")
        assert r.session_key(_inbound(thread_key="t9")) == "t9"
        # a threadless message keys on its own id — per-message session
        assert r.session_key(_inbound(thread_key="", external_id="<x>")) == "<x>"

    @pytest.mark.asyncio
    async def test_closed_runner_rejects_new_messages(self):
        runner = _AgentRunner("stub")
        await runner.close()

        with pytest.raises(RuntimeError, match="processing scope is closed"):
            await runner.process_for(_inbound())

    @pytest.mark.asyncio
    async def test_process_finishing_spawn_after_close_is_discarded(self, monkeypatch):
        runner = _AgentRunner("stub")
        process = _StubProcess()
        deployment = _DelayedDeployment(process)
        deployment.install(monkeypatch)
        pending = asyncio.create_task(runner.process_for(_inbound()))
        await deployment.started.wait()

        await runner.close()
        deployment.finish.set()

        with pytest.raises(RuntimeError, match="processing scope is closed"):
            await pending
        assert process.exited is True
        assert process.saved is False
        assert runner.processes == {}

    @pytest.mark.asyncio
    async def test_concurrent_same_key_messages_share_one_spawn(self, monkeypatch):
        runner = _AgentRunner("stub")
        process = _StubProcess()
        deployment = _DelayedDeployment(process)
        deployment.install(monkeypatch)
        first = asyncio.create_task(runner.process_for(_inbound(thread_key="same")))
        await deployment.started.wait()
        second = asyncio.create_task(runner.process_for(_inbound(thread_key="same")))
        deployment.finish.set()

        first_process, second_process = await asyncio.gather(first, second)
        assert first_process is second_process is process
        assert deployment.spawn_count == 1
        await runner.close()

    @pytest.mark.asyncio
    async def test_concurrent_distinct_keys_respect_process_cap(self, monkeypatch):
        runner = _AgentRunner("stub", max_processes=1)
        process = _StubProcess()
        deployment = _DelayedDeployment(process)
        deployment.install(monkeypatch)
        first = asyncio.create_task(runner.process_for(_inbound(thread_key="one")))
        await deployment.started.wait()
        second = asyncio.create_task(runner.process_for(_inbound(thread_key="two")))
        deployment.finish.set()

        assert await first is process
        with pytest.raises(RuntimeError, match="max_processes=1"):
            await second
        assert deployment.spawn_count == 1
        await runner.close()


class TestAgentMessageProcessing:
    @pytest.fixture
    def fake_runner(self, monkeypatch):
        instances = []

        class FakeRunner:
            def __init__(self, agent):
                self.agent = agent
                self.messages = []
                self.closed = False
                self.started = asyncio.Event()
                self.release = asyncio.Event()
                instances.append(self)

            async def run(self, message):
                if self.closed:
                    raise RuntimeError("agent message processing scope is closed")
                self.messages.append(message)
                if message.body == "explode":
                    raise RuntimeError("agent turn exploded")
                if message.body == "wait":
                    self.started.set()
                    await self.release.wait()
                return RunOutput(text=f"answer: {message.body}")

            async def close(self):
                self.closed = True

        monkeypatch.setattr(blocks, "_AgentRunner", FakeRunner)
        return instances

    @pytest.mark.asyncio
    async def test_scope_reuses_the_private_runner_and_closes_it(self, fake_runner):
        agent = Agent(name="stub")
        first = _inbound(body="first")
        second = _inbound(body="second")

        async with agent.process_messages():
            assert (await agent.process_message(first)).text == "answer: first"
            assert (await agent.process_message(second)).text == "answer: second"

        assert len(fake_runner) == 1
        assert fake_runner[0].messages == [first, second]
        assert fake_runner[0].closed is True

    @pytest.mark.asyncio
    async def test_one_shot_message_closes_its_private_runner(self, fake_runner):
        agent = Agent(name="stub")

        assert (await agent.process_message(_inbound(body="hello"))).text == "answer: hello"
        assert len(fake_runner) == 1
        assert fake_runner[0].closed is True

    @pytest.mark.asyncio
    async def test_respond_to_owns_listening_reply_and_cleanup(self, fake_runner):
        agent = Agent(name="stub")
        channel = blocks.MessageSource.get("simple")

        async with agent.respond_to(channel):
            reply = await channel.send("hello")

        assert reply == "answer: hello"
        assert len(fake_runner) == 1
        assert fake_runner[0].closed is True

    @pytest.mark.asyncio
    async def test_respond_to_propagates_a_failed_agent_turn_to_send(self, fake_runner):
        agent = Agent(name="stub")
        channel = blocks.MessageSource.get("simple")

        with pytest.raises(RuntimeError, match="agent turn exploded"):
            async with agent.respond_to(channel):
                await channel.send("explode")

        assert len(fake_runner) == 1
        assert fake_runner[0].closed is True

    @pytest.mark.asyncio
    async def test_cancelled_send_does_not_stop_the_responder(self, fake_runner):
        agent = Agent(name="stub")
        channel = blocks.MessageSource.get("simple")

        async with agent.respond_to(channel):
            abandoned = asyncio.create_task(channel.send("wait"))
            await fake_runner[0].started.wait()
            fake_runner[0].release.set()
            abandoned.cancel()

            with pytest.raises(asyncio.CancelledError):
                await abandoned

            assert await channel.send("next") == "answer: next"

        assert len(fake_runner) == 1
        assert fake_runner[0].closed is True

    @pytest.mark.asyncio
    async def test_child_task_cannot_reuse_runner_after_scope_exit(self, fake_runner):
        agent = Agent(name="stub")
        release_child = asyncio.Event()

        async def run_later():
            await release_child.wait()
            return await agent.process_message(_inbound(body="late"))

        async with agent.process_messages():
            child = asyncio.create_task(run_later())

        release_child.set()
        with pytest.raises(RuntimeError, match="processing scope is closed"):
            await child
        assert len(fake_runner) == 1

    def test_agent_runner_is_not_public(self):
        assert "AgentRunner" not in blocks.__all__
        assert not hasattr(blocks, "AgentRunner")


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
