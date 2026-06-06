from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

from flow_sdk.core.capabilities import CapabilityKind, CapabilityResult, get_capability_registry


def test_capability_kind_ontology_prefix_matching():
    registry = get_capability_registry()

    harness_kinds = {spec.kind for spec in registry.matching_specs("harness")}
    claude_kinds = {spec.kind for spec in registry.matching_specs("harness.claude")}

    assert CapabilityKind.CLAUDE_CLI.value in harness_kinds
    assert CapabilityKind.CODEX_CLI.value in harness_kinds
    assert claude_kinds == {CapabilityKind.CLAUDE_CLI.value}


def test_harness_capability_specs_include_install_homepages():
    registry = get_capability_registry()

    claude = registry.get(CapabilityKind.CLAUDE_CLI.value).spec
    codex = registry.get(CapabilityKind.CODEX_CLI.value).spec

    assert claude.homepage_url == "https://docs.anthropic.com/en/docs/claude-code/getting-started"
    assert codex.homepage_url == "https://openai.com/codex/"


@pytest.mark.asyncio
async def test_cli_capability_check_uses_executable_resolution(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable: f"/usr/bin/{executable}")

    result = await get_capability_registry().check(CapabilityKind.CLAUDE_CLI.value)

    assert result.result.available is True
    assert result.result.ok is True
    assert result.result.details["path"] == "/usr/bin/claude"


@pytest.mark.asyncio
async def test_cli_capability_install_starts_agentic_process(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    seen_prompts: list[str | None] = []

    async def fake_install_process(spec):
        seen_prompts.append(spec.install_prompt)
        return CapabilityResult(
            ok=True,
            available=False,
            message="Install process completed.",
            details={"prompt": spec.install_prompt or registry_mod.DEFAULT_INSTALL_PROMPT},
            process_id="install-process-id",
        )

    monkeypatch.setattr(registry_mod, "run_capability_install_process", fake_install_process)
    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable: None)

    result = await get_capability_registry().install(CapabilityKind.CODEX_CLI.value)

    assert result.result.available is False
    assert result.result.process_id == "install-process-id"
    assert result.result.details["prompt"] == registry_mod.DEFAULT_INSTALL_PROMPT
    assert seen_prompts == [None]


@pytest.mark.asyncio
async def test_capability_install_process_uses_default_harness_worker(monkeypatch, tmp_path):
    import flow_sdk.builtin.agentic_process as agentic_process_pkg
    import flow_sdk.core.capabilities.registry as registry_mod
    import flow_sdk.instance_settings as instance_settings_pkg
    from flow_sdk.responses.response import ApiSuccessResponse

    created: list[dict] = []
    scheduled: list[tuple[str, str]] = []

    class FakeAgenticProcess:
        def __init__(self, **kwargs):
            self.id = "install-process-id"
            self.name = kwargs.get("name")
            self.context_data = kwargs.get("context_data") or {}
            created.append(kwargs)

        async def save(self, notify=True):
            return self

        async def prompt(self, prompt):
            created.append({"prompt": prompt})
            return ApiSuccessResponse(data={"status": "started", "worker": "codex"})

    async def fake_resolve_default_harness_kind():
        return CapabilityKind.CODEX_CLI.value

    monkeypatch.setattr(instance_settings_pkg, "get_instance_settings", lambda: SimpleNamespace(flow_home=str(tmp_path)))
    monkeypatch.setattr(agentic_process_pkg, "AgenticProcess", FakeAgenticProcess)
    monkeypatch.setattr(registry_mod, "resolve_default_harness_kind", fake_resolve_default_harness_kind)
    monkeypatch.setattr(registry_mod, "_schedule_install_monitor", lambda process_id, kind: scheduled.append((process_id, kind)))

    result = await registry_mod.run_capability_install_process(
        registry_mod.get_capability_registry().get(CapabilityKind.CLAUDE_CLI.value).spec
    )

    process_kwargs = created[0]
    assert process_kwargs["worker_type"] == "codex"
    assert process_kwargs["cli_config"]["worker_type"] == "codex"
    assert process_kwargs["context_data"]["install_harness_kind"] == CapabilityKind.CODEX_CLI.value
    assert created[1]["prompt"] == registry_mod.DEFAULT_INSTALL_PROMPT
    assert result.ok is True
    assert result.process_id == "install-process-id"
    assert result.details["harness_kind"] == CapabilityKind.CODEX_CLI.value
    assert result.details["worker_type"] == "codex"
    assert scheduled == [("install-process-id", CapabilityKind.CLAUDE_CLI.value)]


@pytest.mark.asyncio
async def test_cli_capability_install_failure_is_returned(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    async def fake_install_process(spec):
        return CapabilityResult(
            ok=False,
            available=False,
            message="Install process failed: boom",
            process_id="install-process-id",
        )

    monkeypatch.setattr(registry_mod, "run_capability_install_process", fake_install_process)

    result = await get_capability_registry().install(CapabilityKind.CODEX_CLI.value)

    assert result.result.ok is False
    assert "failed" in result.result.message


@pytest.mark.asyncio
async def test_cli_capability_test_runs_version_command(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    calls = []

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        return SimpleNamespace(returncode=0, stdout="claude 1.2.3\n", stderr="")

    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable: f"/bin/{executable}")
    monkeypatch.setattr(registry_mod.subprocess, "run", fake_run)

    result = await get_capability_registry().test(CapabilityKind.CLAUDE_CLI.value)

    assert result.result.ok is True
    assert calls[0][0][0] == "/bin/claude"
    assert calls[0][1]["timeout"] == 5.0


@pytest.mark.asyncio
async def test_cli_capability_test_reports_timeout(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    def fake_run(argv, **kwargs):
        raise subprocess.TimeoutExpired(argv, timeout=kwargs["timeout"])

    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable: f"/bin/{executable}")
    monkeypatch.setattr(registry_mod.subprocess, "run", fake_run)

    result = await get_capability_registry().test(CapabilityKind.CODEX_CLI.value)

    assert result.result.ok is False
    assert result.result.available is True
    assert "timed out" in result.result.message


@pytest.mark.asyncio
async def test_chrome_probe_is_blocked_when_claude_dependency_missing(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable: None)

    result = await get_capability_registry().test(CapabilityKind.CHROME_AUTHENTICATED.value)

    assert result.result.available is False
    assert result.result.details["missing_dependencies"] == [CapabilityKind.CLAUDE_CLI.value]


@pytest.mark.asyncio
async def test_chrome_probe_runner_result_is_returned_when_dependency_passes(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    async def fake_probe():
        return CapabilityResult(
            ok=True,
            available=True,
            message="probe passed",
            process_id="agentic-process-id",
        )

    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable: f"/bin/{executable}")
    monkeypatch.setattr(registry_mod, "run_chrome_authenticated_probe", fake_probe)

    result = await get_capability_registry().test(CapabilityKind.CHROME_AUTHENTICATED.value)

    assert result.result.ok is True
    assert result.result.process_id == "agentic-process-id"
    assert CapabilityKind.CLAUDE_CLI.value in result.dependencies


@pytest.mark.asyncio
async def test_harness_reference_delegates_to_target_and_stamps_reference(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable: f"/usr/bin/{executable}")
    runner = get_capability_registry().get(CapabilityKind.HARNESS.value)

    async def fake_resolve():
        return CapabilityKind.CLAUDE_CLI.value

    monkeypatch.setattr(runner, "_resolve_reference_kind", fake_resolve)

    result = await get_capability_registry().check(CapabilityKind.HARNESS.value)

    assert result.result.available is True
    assert result.result.details["reference_kind"] == CapabilityKind.CLAUDE_CLI.value
    assert result.result.details["path"] == "/usr/bin/claude"


@pytest.mark.asyncio
async def test_harness_reference_rejects_target_outside_allowed_query(monkeypatch):
    runner = get_capability_registry().get(CapabilityKind.HARNESS.value)

    async def fake_resolve():
        return CapabilityKind.CHROME_AUTHENTICATED.value

    monkeypatch.setattr(runner, "_resolve_reference_kind", fake_resolve)

    result = await get_capability_registry().check(CapabilityKind.HARNESS.value)

    assert result.result.available is False
    assert "must be a harness" in result.result.message


@pytest.mark.asyncio
async def test_harness_reference_rejects_unregistered_target(monkeypatch):
    runner = get_capability_registry().get(CapabilityKind.HARNESS.value)

    async def fake_resolve():
        return "harness.unknown.cli"

    monkeypatch.setattr(runner, "_resolve_reference_kind", fake_resolve)

    result = await get_capability_registry().check(CapabilityKind.HARNESS.value)

    assert result.result.available is False
    assert "not registered" in result.result.message
