"""`flow diagnose <request id>` — a diagnosis someone supporting you asked for.

The hub is reached through ONE seam, ``hub_anonymous_request`` (the id is the credential), and the
agent run through ``_run_diagnose``; both are stood in for here, as `test_diagnose_cmd.py` does for
the run. What is asserted is the runner's contract: the id is recognised, the user approves the
supporter's instructions before anything runs, the run spends the request's public budget, and
what is submitted is the recorded diagnosis -- cut to the request's size limit.
"""

import asyncio
import io
import logging
import zipfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from flow_sdk.cli.commands import diagnose_cmd
from flow_sdk.cli.commands.diagnose_cmd import fit_run, parse_request_id
from flow_sdk.cli.flow_cli import app

runner = CliRunner()
REQUEST_ID = "0b9e4b44-5d8e-4c39-9d43-4a0b5a2b6d11"
BUDGET = "llm_endpoint-11111111-2222-4333-8444-555555555555"


@pytest.fixture(autouse=True)
def _isolate_cli_side_effects():
    try:
        saved_loop = asyncio.get_event_loop_policy().get_event_loop()
    except RuntimeError:
        saved_loop = None
    yield
    logging.disable(logging.NOTSET)
    if saved_loop is not None:
        asyncio.set_event_loop(saved_loop)


class _Hub:
    """The hub as the runner sees it: a brief to read and a submit that records what arrived."""

    def __init__(self, **brief):
        self.brief = {
            "open": True,
            "instructions": "",
            "llm_endpoint_typeid": BUDGET,
            "max_run_bytes": 2_000_000,
            **brief,
        }
        self.submitted: list[dict] = []
        self.files: dict[str, bytes] = {}

    async def __call__(self, method, kind, entity_id, action, payload=None, *, raw=False):
        assert kind == "diagnosis_request" and entity_id == REQUEST_ID
        if action == "brief":
            return self.brief
        if action.startswith("brief/attachment/"):
            assert raw
            return self.files[action.removeprefix("brief/attachment/")]
        self.submitted.append(payload)
        return {"run": len(self.submitted)}


def _recording_run(calls: list):
    async def run(
        text,
        timeout,
        *,
        emit=None,
        process_options=None,
        steps=(),
        approve=None,
        step_output_dir=None,
        step_context="",
        prompt_extra="",
    ):
        approved = [s for s in steps if approve is None or approve(s)]
        workdir = Path(process_options["workdir"])
        calls.append(
            {
                "text": text,
                "process_options": process_options,
                "approved": approved,
                "extra": prompt_extra,
                "step_output_dir": step_output_dir,
                "step_context": step_context,
                "skill": (workdir / ".claude/skills/db-doctor/SKILL.md").read_text()
                if (workdir / ".claude/skills/db-doctor/SKILL.md").exists()
                else None,
                "file": (workdir / "from-supporter/steps.md").read_text()
                if (workdir / "from-supporter/steps.md").exists()
                else None,
            }
        )
        emit({"type": "narration", "text": "found the lock"})
        emit({"type": "done", "ok": True, "diagnosis_id": "d1"})
        return 0

    return run


async def _diagnosis(_cls, _id):
    return SimpleNamespace(
        title="DB locked",
        summary="the DB was locked",
        symptoms=None,
        rca="two writers",
        fix=None,
        reported_by="Dana <d@x.io>",
        occurred_at=None,
        os="macOS",
        app_version="0.2",
    )


def _invoke(hub, calls, stdin):
    with (
        patch("flow_sdk.cloud_client.transport.hub_http.hub_anonymous_request", hub),
        patch.object(diagnose_cmd, "_run_diagnose", _recording_run(calls)),
        patch.object(diagnose_cmd, "_load_recorded_diagnosis", _diagnosis),
    ):
        return runner.invoke(app, ["diagnose", REQUEST_ID], input=stdin)


def test_the_id_is_recognised_bare_or_typed_and_free_text_is_not():
    assert parse_request_id(REQUEST_ID) == REQUEST_ID
    assert parse_request_id(f"diagnosis_request-{REQUEST_ID}") == REQUEST_ID
    assert parse_request_id("backend") is None


def test_approve_all_runs_on_the_requests_budget_and_submits_the_diagnosis():
    hub, calls = _Hub(instructions="search server.log for 'locked'"), []

    result = _invoke(hub, calls, "a\nit hangs\n\n")

    assert result.exit_code == 0, result.output
    assert {k: v for k, v in calls[0]["process_options"].items() if k != "workdir"} == {
        "llm_endpoint_typeid": BUDGET,
        "llm_endpoint_public": True,
    }
    assert calls[0]["approved"] == ["search server.log for 'locked'"], "approved together, each step still runs first"
    assert "step-<n>.txt" in calls[0]["extra"], "the diagnosis turn sums up what the steps found"
    sent = hub.submitted[0]
    assert sent["title"] == "DB locked" and sent["user_report"] == "it hangs"
    assert sent["files"]["agent-narration.md"] == "found the lock"


def test_approve_each_asks_before_every_step_and_runs_only_the_approved():
    hub, calls = _Hub(instructions="read server.log\nrestart the backend"), []

    result = _invoke(hub, calls, "e\n\n\nn\n\n")

    assert result.exit_code == 0, result.output
    assert calls[0]["approved"] == ["read server.log"]
    assert "read server.log" not in calls[0]["extra"], "steps run one by one are not repeated in the diagnosis turn"


def test_cancelling_runs_nothing_and_sends_nothing():
    hub, calls = _Hub(instructions="read server.log"), []

    result = _invoke(hub, calls, "n\n")

    assert result.exit_code == 1 and not calls and not hub.submitted


def test_a_closed_request_runs_nothing():
    hub, calls = _Hub(open=False, write_expires_at="2026-10-01T00:00:00+00:00"), []

    result = _invoke(hub, calls, "a\n")

    assert result.exit_code == 1 and not calls and "closed" in result.output


def test_free_text_after_diagnose_still_runs_a_plain_diagnosis():
    with patch.object(diagnose_cmd, "_run_diagnose") as plain:
        plain.return_value = None

        async def done(*_a, **_k):
            return 0

        plain.side_effect = done
        result = runner.invoke(app, ["diagnose", "backend", "down"], input="x\n")

    assert result.exit_code == 0 and plain.call_args.args[0] == "x"


def test_a_run_is_cut_to_the_requests_size_limit_and_the_diagnosis_survives():
    run = fit_run({"title": "t"}, {"a.log": "x" * 5000, "b.log": "y" * 100}, 2000)

    assert len(run.model_dump_json().encode()) <= 2000
    assert run.title == "t" and run.files["b.log"] == "y" * 100
    assert run.files["a.log"].endswith("cut to fit the request's size limit]")


def test_what_the_supporter_attached_is_installed_for_the_run_only():
    hub, calls = (
        _Hub(attachments=[{"kind": "skills", "name": "db-doctor.zip"}, {"kind": "files", "name": "steps.md"}]),
        [],
    )
    skill = io.BytesIO()
    with zipfile.ZipFile(skill, "w") as z:
        z.writestr("SKILL.md", "---\nname: db-doctor\n---\nfix locked DBs")
    hub.files = {"skills/db-doctor.zip": skill.getvalue(), "files/steps.md": b"check the lock"}

    result = _invoke(hub, calls, "a\n\n\n")

    assert result.exit_code == 0, result.output
    assert "db-doctor" in result.output and "steps.md" in result.output, "the user sees what was sent before approving"
    assert "fix locked DBs" in calls[0]["skill"], "a skill lands where the agent finds project skills"
    assert calls[0]["file"] == "check the lock"
    assert "db-doctor" in calls[0]["extra"] and "steps.md" in calls[0]["extra"]
    assert not Path(calls[0]["process_options"]["workdir"]).exists(), "nothing outlives the run"


def _two_attachments_hub():
    hub = _Hub(attachments=[{"kind": "skills", "name": "db-doctor.zip"}, {"kind": "files", "name": "steps.md"}])
    skill = io.BytesIO()
    with zipfile.ZipFile(skill, "w") as z:
        z.writestr("SKILL.md", "---\nname: db-doctor\n---\nfix locked DBs")
    hub.files = {"skills/db-doctor.zip": skill.getvalue(), "files/steps.md": b"check the lock"}
    return hub


def test_approving_each_asks_about_every_attachment_and_yes_is_the_default():
    hub, calls = _two_attachments_hub(), []

    result = _invoke(hub, calls, "e\nn\n\n\n\n")  # e, refuse the skill, keep the file (Enter), describe, send

    assert result.exit_code == 0, result.output
    assert calls[0]["skill"] is None, "a refused skill is never installed"
    assert calls[0]["file"] == "check the lock"


def test_the_user_sees_what_leaves_and_may_keep_it():
    hub, calls = _Hub(instructions="read server.log"), []

    result = _invoke(hub, calls, "a\n\nv\nn\n")  # approve, no description, view the files, then decline

    assert result.exit_code == 1 and not hub.submitted
    assert "About to send" in result.output and "agent-narration.md" in result.output
    assert "found the lock" in result.output, "v shows the files themselves"
    assert "Dana <d@x.io>" in result.output, "who they are, as recorded, is shown before it leaves"
