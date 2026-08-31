"""Every headless driver stamps the API-key model slug onto its context.

Regression: only opencode applied ``apply_api_model_to_options`` in
``headless_prompt``, so claude/codex/copilot spawned in api-auth mode with the
provider token injected but the *vendor default* model — a slug the provider
(OpenRouter, or the hub endpoint) does not recognise. All four now go through
``api_auth.stamp_api_model``.
"""

from __future__ import annotations

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess, PreparedProcessAssets
from flow_sdk.builtin.agentic_process.cli_drivers import api_auth
from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import WorkerApiAuth
from flow_sdk.builtin.agentic_process.cli_drivers.claude import driver as claude_driver_module
from flow_sdk.builtin.agentic_process.cli_drivers.codex import driver as codex_driver_module
from flow_sdk.builtin.agentic_process.cli_drivers.copilot import driver as copilot_driver_module
from flow_sdk.builtin.agentic_process.cli_drivers.opencode import driver as opencode_driver_module
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType

STAMPED_SLUG = "anthropic/claude-haiku-4.5"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("worker_type", "driver_module"),
    [
        (WorkerType.CLAUDE_CODE, claude_driver_module),
        (WorkerType.CODEX, codex_driver_module),
        (WorkerType.COPILOT, copilot_driver_module),
        (WorkerType.OPENCODE, opencode_driver_module),
    ],
)
async def test_headless_prompt_stamps_api_model(monkeypatch, tmp_path, worker_type, driver_module):
    captured: dict[str, object] = {}

    async def no_op(_self, *_args, **_kwargs):
        return None

    async def prepare(_self):
        return PreparedProcessAssets()

    monkeypatch.setattr(AgenticProcess, "get_project", no_op)
    monkeypatch.setattr(AgenticProcess, "save", no_op)
    monkeypatch.setattr(AgenticProcess, "prepare_process_assets", prepare)

    async def secret_env(_env, _process):
        return None

    monkeypatch.setattr(driver_module, "apply_worker_secret_env", secret_env)

    async def resolve(_process):
        return WorkerApiAuth(env={}, model_slug=STAMPED_SLUG, config_overrides=[])

    monkeypatch.setattr(api_auth, "resolve_worker_api_auth", resolve)

    async def fake_turn(_driver, _process, _worker, *, prompt, context, logger, **_kw):
        captured["context"] = context
        return None

    monkeypatch.setattr(driver_module, "run_headless_turn", fake_turn)

    process = AgenticProcess(
        id=mint_uuid(),
        worker_type=worker_type,
        workdir=str(tmp_path),
        pty_mode=False,
        load_flowpad_assistant=False,
    )
    await process.driver.headless_prompt(process, "hello")

    assert captured["context"].model == STAMPED_SLUG
