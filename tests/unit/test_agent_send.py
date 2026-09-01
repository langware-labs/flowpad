"""The send verb — and the two ways it must NOT resemble fetch.

Sending is the only irreversible thing this subsystem does. Fetch is safe to
retry because the digest gate makes a re-run an upsert; a retried send puts a
second copy in someone's inbox. These tests pin the asymmetry.
"""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.builtin.agentic_process.launch_health import LaunchError, LaunchHealth
from flow_sdk.ingest.driver import SendOutcome, SendStatus
from flow_sdk.ingest.drivers.agent import (
    DEFAULT_SEND_AGENT,
    SEND_RECEIPT_FILENAME,
    AgentDriver,
    _send_slots,
    _slots,
)


class TestBudgetIsSeparate:
    def test_a_reply_never_queues_behind_a_mailbox_poll(self):
        # Sharing `_slots` would park a foreground reply behind up to two
        # 300-second fetches while the user watches a spinner.
        assert _send_slots is not _slots

    def test_but_a_reply_is_still_bounded(self):
        # The alternative failure: N clicks spawning N unbounded workers.
        assert _send_slots._value >= 1


class TestReceiptReading:
    driver = AgentDriver()

    def test_a_confirmed_send_yields_its_ids(self):
        out = self.driver._send_result_from(
            {"sent": True, "external_id": "m-1", "recorded": True})
        assert out == SendOutcome(external_id="m-1", status=SendStatus.SENT,
                                  recorded=True)

    def test_a_receipt_without_confirmation_is_not_an_outcome(self):
        # No error, no send and no draft is ambiguous, and ambiguity must not
        # read as success — a caller would tell the user their mail went out.
        with pytest.raises(LaunchError) as caught:
            self.driver._send_result_from({"external_id": "m-1"})
        assert caught.value.health is LaunchHealth.CONFIG_ERROR

    def test_a_draft_is_a_real_outcome_not_a_failure(self):
        # The claude.ai Gmail connector exposes `create_draft` and NO send verb
        # at all, so drafting is the best a whole class of connectors can do.
        # Reporting it as an error would make the feature look broken.
        out = self.driver._send_result_from(
            {"drafted": True, "draft_id": "r-1"})
        assert out.drafted is True
        assert out.external_id == "r-1"
        # A draft has reached nobody, so it is never recorded as a message.
        assert out.recorded is False

    def test_a_reported_error_is_never_retryable(self):
        with pytest.raises(LaunchError) as caught:
            self.driver._send_result_from({"error": "auth_failed"})
        assert caught.value.health is LaunchHealth.CONFIG_ERROR

    def test_a_missing_connector_is_a_config_problem(self):
        with pytest.raises(LaunchError) as caught:
            self.driver._send_result_from({"error": "no_connector"})
        assert caught.value.health is LaunchHealth.CONFIG_ERROR

    def test_the_mail_can_be_sent_even_when_recording_failed(self):
        # The mail is gone. Reporting this as a failure invites a re-send.
        out = self.driver._send_result_from(
            {"sent": True, "external_id": "m-1", "recorded": False, "error": None})
        assert out.external_id == "m-1"
        assert out.recorded is False

class TestTimeoutIsNotRetryable:
    """THE test. `fetch` classes a timeout transient — "the next attempt may
    succeed" — which for a send means mailing the recipient twice."""

    @pytest.mark.long  # 1.00s
    @pytest.mark.asyncio
    async def test_a_timed_out_send_refuses_a_retry(self, monkeypatch):
        driver = AgentDriver()

        async def _never(*a, **kw):
            await asyncio.sleep(10)

        monkeypatch.setattr(driver, "_run_send_agent", _never)
        monkeypatch.setattr("flow_sdk.ingest.drivers.agent.ensure_launchable",
                            _async_none)

        source = _source(send_deadline_seconds=1)
        with pytest.raises(LaunchError) as caught:
            await driver.send(source, thread_key="t", to="a@b.c", text="hi")

        # CONFIG, never TRANSIENT: transient is what tells the caller to try
        # again, and there must not be a next attempt.
        assert caught.value.health is LaunchHealth.CONFIG_ERROR
        assert "may or may not" in caught.value.detail

    @pytest.mark.asyncio
    async def test_a_send_failure_never_parks_the_data_source(self, monkeypatch):
        # `SourceError` health drives DataSource parking. One failed reply must
        # not stop a mailbox from syncing.
        driver = AgentDriver()

        async def _boom(*a, **kw):
            raise RuntimeError("connector exploded")

        monkeypatch.setattr(driver, "_run_send_agent", _boom)
        monkeypatch.setattr("flow_sdk.ingest.drivers.agent.ensure_launchable",
                            _async_none)

        with pytest.raises(LaunchError):
            await driver.send(_source(), thread_key="t", to="a@b.c", text="hi")

    @pytest.mark.asyncio
    async def test_an_unlaunchable_harness_is_reported_before_any_worker(self, monkeypatch):
        driver = AgentDriver()
        problem = LaunchError.config("not_installed", "no claude", "claude")

        async def _problem(*a, **kw):
            return problem

        monkeypatch.setattr("flow_sdk.ingest.drivers.agent.ensure_launchable", _problem)
        with pytest.raises(LaunchError) as caught:
            await driver.send(_source(), thread_key="t", to="a@b.c", text="hi")
        assert caught.value is problem


class TestInstruction:
    def test_the_body_is_fenced_verbatim(self):
        text = "please  DON'T   fix my spacing\nor my grammer"
        out = AgentDriver._send_instruction(
            _source(), {}, "/tmp/sent.json",
            thread_key="t-1", to="a@b.c", text=text, subject="Re: x",
        )
        # Fenced so the model can see exactly where the user's words begin and
        # end — and present byte-for-byte.
        assert f"```\n{text}\n```" in out
        assert "send exactly this" in out.lower()

    def test_it_carries_the_absolute_cli_path(self):
        out = AgentDriver._send_instruction(
            _source(), {}, "/tmp/sent.json",
            thread_key="t", to="a@b.c", text="hi", subject="",
        )
        # A bare `flow` on PATH resolved to a pyenv shim of an older build.
        assert "by absolute path" in out
        assert "/tmp/sent.json" in out

    def test_a_threadless_send_says_so_rather_than_sending_blank(self):
        out = AgentDriver._send_instruction(
            _source(), {}, "/tmp/sent.json",
            thread_key="", to="a@b.c", text="hi", subject="Hello",
        )
        assert "start a new thread" in out


class TestDriverContract:
    def test_the_agent_transport_declares_that_it_sends(self):
        assert AgentDriver.sends is True

    def test_replying_uses_its_own_agent_not_the_summarizer(self):
        # `email-summarizer`'s persona says "You do not open the mailbox".
        assert DEFAULT_SEND_AGENT == "emailer"

    def test_the_two_verbs_never_read_each_others_receipt(self):
        from flow_sdk.ingest.drivers.agent import RECEIPT_FILENAME

        assert SEND_RECEIPT_FILENAME != RECEIPT_FILENAME


async def _async_none(*a, **kw):
    return None


def _source(**config):
    from types import SimpleNamespace

    return SimpleNamespace(id="ds-1", name="Gmail", config=config or {})
