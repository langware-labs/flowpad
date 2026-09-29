"""The wizard trust boundary: WHERE a wizard lives decides whether its shell
commands run without asking.

This is the gate that keeps "clone a repo and open the project" from being a
code-execution primitive. `.flowpad/bootstrap.json` already attaches content
projects from third-party repos and `repo_assets_fn` indexes everything under
`agentic-assets/`, so an executable asset from an untrusted root is exactly the
thing the rest of the codebase refuses (``CapabilitySpec.install_commands`` is
display-only for the same reason).
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.builtin.wizard import Wizard

pytestmark = pytest.mark.timeout(5)


def _wizard_at(root: Path) -> Wizard:
    return Wizard(name="w", asset_ref=str(root / "agentic-assets" / "wizard" / "llm-setup"))


def test_a_shipped_wizard_is_trusted(tmp_path):
    shipped = tmp_path / "site-packages" / "flow_sdk" / "system_projects" / "flowpad_assistant"
    assert _wizard_at(shipped).is_system() is True


def test_a_wizard_in_an_ordinary_project_is_not(tmp_path):
    assert _wizard_at(tmp_path / "Flowpad workspace" / "cloned-repo").is_system() is False


def test_a_lookalike_path_is_not_trusted(tmp_path):
    """Systemness is structural — ``<install>/flow_sdk/system_projects/<name>``.
    A folder merely NAMED system_projects does not qualify."""
    fake = tmp_path / "system_projects" / "flowpad_assistant"
    assert _wizard_at(fake).is_system() is False


def test_a_wizard_with_no_asset_ref_is_not_trusted():
    assert Wizard(name="w", asset_ref="").is_system() is False


def test_the_shipped_llm_setup_wizard_is_trusted_where_it_actually_lives():
    """Guards the real path, so moving the asset cannot silently un-trust it."""
    from flow_sdk.config import system_projects_root

    ref = system_projects_root() / "flowpad_assistant" / "agentic-assets" / "wizard" / "llm-setup"
    assert Wizard(name="llm-setup", asset_ref=str(ref)).is_system() is True


# ── refusal and busy are ANSWERS; only the HTTP edge turns them into codes ───


def _folder_wizard(tmp_path, monkeypatch):
    import json

    from flow_sdk.builtin.wizard import Wizard
    from flow_sdk.core.wizard import execute as wizard_execute
    from flow_sdk.core.wizard import state as wizard_state

    monkeypatch.setattr(wizard_state, "run_dir", lambda wid: tmp_path / "runs" / wid)
    monkeypatch.setattr(wizard_execute, "run_dir", lambda wid: tmp_path / "runs" / wid)
    folder = tmp_path / "project" / "agentic-assets" / "wizard" / "demo"
    folder.mkdir(parents=True)
    (folder / "wizard.json").write_text(
        json.dumps({"name": "demo", "steps": [{"id": "a", "kind": "compute", "ref": "nothing-by-this-name"}]})
    )
    return Wizard(name="demo", asset_ref=str(folder))


def test_an_unapproved_wizard_answers_refused_and_never_raises(tmp_path, monkeypatch):
    import asyncio

    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, WizardResult

    wizard = _folder_wizard(tmp_path, monkeypatch)
    result = asyncio.run(wizard.run())
    assert type(result) is WizardResult
    assert result.exit_code is ExitCode.REFUSED and result.ran is False


def test_run_action_answers_refused_with_a_200_and_the_answer_in_the_body(tmp_path, monkeypatch):
    """The exit code IS the answer, read from one place — as `POST
    /compute_op/<id>/run` does. A 403 would make `flow op`/`flow wizard` exit 2
    ("the request failed") for what is really a refusal (7)."""
    import asyncio

    from flow_sdk.responses.response import ApiSuccessResponse

    wizard = _folder_wizard(tmp_path, monkeypatch)
    response = asyncio.run(wizard.run_action())
    assert isinstance(response, ApiSuccessResponse)
    assert response.data["exit_code"] == 7 and "steps" in response.data


def test_open_action_shows_the_wizard_blank_without_running_it(tmp_path, monkeypatch):
    """`POST /wizard/<id>/open` — Settings' "Run setup again": the page, cleared, and nothing runs."""
    import asyncio

    from flow_sdk.responses.response import ApiSuccessResponse
    from flow_sdk.server import builtin_triggers

    shown = []

    async def _show(wizard):
        shown.append(wizard)

    monkeypatch.setattr(builtin_triggers, "show_wizard_fresh", _show)
    wizard = _folder_wizard(tmp_path, monkeypatch)
    response = asyncio.run(wizard.open_action())
    assert isinstance(response, ApiSuccessResponse) and response.data == {"opened": True}
    assert shown == [wizard]


def test_start_action_settles_a_source_then_runs_this_wizard_with_the_person_present(tmp_path, monkeypatch):
    """`POST /wizard/<id>/start` — the Start button: both verdicts in the body, and never
    `unattended`, so a question raised on the way is put to the person watching."""
    import asyncio

    from flow_sdk.responses.response import ApiSuccessResponse
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, WizardResult
    from flow_sdk.server import builtin_triggers

    seen = {}

    async def _run(wizard, *, unattended):
        seen.update(wizard=wizard, unattended=unattended)
        return CliResult.satisfied("funded"), WizardResult.satisfied("stubbed")

    monkeypatch.setattr(builtin_triggers, "start_wizard", _run)
    wizard = _folder_wizard(tmp_path, monkeypatch)
    response = asyncio.run(wizard.start_action())
    assert isinstance(response, ApiSuccessResponse)
    assert set(response.data) == {"llm_source", "wizard"}
    assert seen == {"wizard": wizard, "unattended": False}


def test_a_wizard_that_declares_no_llm_source_is_started_without_settling_one(tmp_path, monkeypatch):
    """The source step is the wizard's own declaration (`requires_llm_source`), not something every
    start does: a wizard without it never opens the chooser, and its first answer is `None`."""
    import asyncio

    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, WizardResult
    from flow_sdk.server import builtin_triggers

    asked = []

    async def _source():
        asked.append("source")
        return CliResult.satisfied("funded")

    async def _fresh(_wizard):
        return None

    async def _run(_self, **_kwargs):
        return WizardResult.satisfied("stubbed")

    monkeypatch.setattr(builtin_triggers, "_resolve_llm_source", _source)
    monkeypatch.setattr(builtin_triggers, "show_wizard_fresh", _fresh)
    monkeypatch.setattr(Wizard, "run", _run)
    wizard = _folder_wizard(tmp_path, monkeypatch)  # declares nothing about an LLM source
    source, result = asyncio.run(builtin_triggers.start_wizard(wizard, unattended=False))
    assert source is None and result.ok and asked == []

    # …and the action says so: no source verdict in the body.
    response = asyncio.run(wizard.start_action())
    assert response.data["llm_source"] is None


def test_start_action_answers_409_when_another_run_holds_the_slot(tmp_path, monkeypatch):
    import asyncio

    from flow_sdk.responses.response import ApiFailResponse
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, WizardResult
    from flow_sdk.server import builtin_triggers

    async def _run(wizard, *, unattended):
        return CliResult.not_yet("x", ran=False), WizardResult.held("already running")

    monkeypatch.setattr(builtin_triggers, "start_wizard", _run)
    wizard = _folder_wizard(tmp_path, monkeypatch)
    response = asyncio.run(wizard.start_action())
    assert isinstance(response, ApiFailResponse) and response.status_code == 409


def test_a_wizard_that_did_not_run_is_not_busy_and_not_a_409(tmp_path, monkeypatch):
    """The regression `busy` exists for. The edge used to send every NOT_YET with
    `ran=False` to 409 — so a wizard whose op does not exist, one that calls
    itself, or one on a box with no agent harness all read as "busy, try later",
    and retrying never changes any of them."""
    import asyncio

    from flow_sdk.builtin.wizard import Wizard
    from flow_sdk.responses.response import ApiSuccessResponse

    wizard = _folder_wizard(tmp_path, monkeypatch)  # its only op does not exist
    monkeypatch.setattr(Wizard, "is_system", lambda _self: True)
    response = asyncio.run(wizard.run_action())
    assert isinstance(response, ApiSuccessResponse), "never-started is an answer, not busy"
    assert response.data["exit_code"] == 1 and response.data["ran"] is False
    assert response.data["busy"] is False


def test_the_disabled_and_conversational_gates_hold_outside_http(tmp_path, monkeypatch):
    """Gates that lived only on the HTTP edge were skipped by triggers and by
    Python; they are decided in `run` now, so every caller meets them."""
    import asyncio
    import json as _json

    from flow_sdk.builtin.wizard import Wizard
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

    wizard = _folder_wizard(tmp_path, monkeypatch)
    monkeypatch.setattr(Wizard, "is_system", lambda _self: True)
    document = Path(wizard.asset_ref) / "wizard.json"

    body = _json.loads(document.read_text())
    document.write_text(_json.dumps({**body, "enabled": False}))
    assert asyncio.run(wizard.run()).exit_code is ExitCode.REFUSED

    # A conversational wizard is an agent and NO steps — the spec refuses both.
    document.write_text(_json.dumps({"name": body["name"], "agent": "helper", "steps": []}))
    assert asyncio.run(wizard.run()).exit_code is ExitCode.NOT_APPLICABLE


def test_run_action_maps_busy_to_409_with_the_answer_in_the_body(tmp_path, monkeypatch):
    """Another run holds the wizard: `NOT_YET` with `ran=False` — did not run,
    try later — which the HTTP edge, and only it, spells as 409."""
    import asyncio

    from filelock import FileLock

    from flow_sdk.builtin.wizard import Wizard
    from flow_sdk.core.wizard import state as wizard_state
    from flow_sdk.responses.response import ApiFailResponse

    wizard = _folder_wizard(tmp_path, monkeypatch)
    monkeypatch.setattr(Wizard, "is_system", lambda _self: True)
    run_dir = wizard_state.run_dir(str(wizard.id))
    run_dir.mkdir(parents=True, exist_ok=True)
    held = FileLock(str(run_dir / "run.lock"))
    held.acquire(blocking=False)
    try:
        response = asyncio.run(wizard.run_action())
    finally:
        held.release()
    assert isinstance(response, ApiFailResponse) and response.status_code == 409
    assert response.data["exit_code"] == 1 and response.data["ran"] is False
    assert response.data["busy"] is True, "busy is the ONE thing the edge maps to 409"
    assert "already running" in response.message
