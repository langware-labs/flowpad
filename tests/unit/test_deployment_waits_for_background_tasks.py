"""A deployment's agent turns wait for their background tasks.

An agent nobody is watching launches a long job, arms a Monitor on it and ends its turn.
``claude -p`` kills background tasks 10 minutes after the answer, so the agent never heard
its job finish (a QA run on a hub sandbox, 2026-09-24). A deployment's turns lift that
ceiling. It must ride the turn's own env: inherited ``CLAUDE_CODE_*`` variables are stripped.
"""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess, PreparedProcessAssets
from flow_sdk.builtin.agentic_process.cli_drivers.claude import driver as claude_driver
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture
def turn_env(monkeypatch, tmp_path):
    """Run one headless Claude turn on a process and return the env its worker would get."""

    async def no_op(_self, *_args, **_kwargs):
        return None

    async def prepare(_self):
        return PreparedProcessAssets()

    async def secret_env(_env, _process):
        return None

    captured: dict = {}

    async def fake_turn(_driver, _process, _worker, *, prompt, context, logger, **_kw):
        captured["env"] = dict(context.env_vars or {})

    monkeypatch.setattr(AgenticProcess, "get_project", no_op)
    monkeypatch.setattr(AgenticProcess, "save", no_op)
    monkeypatch.setattr(AgenticProcess, "prepare_process_assets", prepare)
    monkeypatch.setattr(claude_driver, "apply_worker_secret_env", secret_env)
    monkeypatch.setattr(claude_driver, "run_headless_turn", fake_turn)

    async def run(**fields) -> dict:
        process = AgenticProcess(
            id=mint_uuid(),
            worker_type=WorkerType.CLAUDE_CODE,
            workdir=str(tmp_path),
            pty_mode=False,
            load_flowpad_assistant=False,
            **fields,
        )
        await process.driver.headless_prompt(process, "hello")
        return captured["env"]

    return run


async def test_a_deployments_turn_waits_for_its_background_tasks(turn_env):
    env = await turn_env(deployment_id=str(mint_uuid()))

    assert env[claude_driver.BACKGROUND_WAIT_ENV] == "0"


async def test_a_turn_outside_a_deployment_keeps_the_clis_default(turn_env):
    """A chat someone is watching keeps the ceiling -- a background dev server must not hold it open."""
    env = await turn_env()

    assert claude_driver.BACKGROUND_WAIT_ENV not in env


async def test_a_deployment_that_set_its_own_ceiling_keeps_it(turn_env):
    env = await turn_env(
        deployment_id=str(mint_uuid()),
        cli_config={"env_vars": {claude_driver.BACKGROUND_WAIT_ENV: "900000"}},
    )

    assert env[claude_driver.BACKGROUND_WAIT_ENV] == "900000"
