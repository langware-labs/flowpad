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


def test_run_action_maps_refused_to_403_with_the_answer_in_the_body(tmp_path, monkeypatch):
    import asyncio

    from flow_sdk.responses.response import ApiFailResponse

    wizard = _folder_wizard(tmp_path, monkeypatch)
    response = asyncio.run(wizard.run_action())
    assert isinstance(response, ApiFailResponse) and response.status_code == 403
    assert response.data["exit_code"] == 7 and "steps" in response.data


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
    assert "already running" in response.message
