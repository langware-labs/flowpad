from __future__ import annotations

import subprocess
from types import SimpleNamespace

import pytest

import flow_sdk.core.capabilities.discovery as discovery_mod
from flow_sdk.core.capabilities import CapabilityKind, CapabilityResult, get_capability_registry
from flow_sdk.core.capabilities.discovery import get_capability_value, set_capability_value
from flow_sdk.core.capabilities.models import CapabilityValue


@pytest.fixture(autouse=True)
def _clear_discovery_dict():
    """Discovery values are a module-global dict — isolate every test."""
    discovery_mod._VALUES.clear()
    discovery_mod._DISCOVERED_ONCE.clear()
    yield
    discovery_mod._VALUES.clear()
    discovery_mod._DISCOVERED_ONCE.clear()


def _seed_cli_value(kind: str, folder: str) -> None:
    set_capability_value(
        CapabilityValue(
            kind=kind,
            value={"path": folder, "ref_type": "folder"},
            value_type="folder",
            message="seeded",
        )
    )


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
async def test_default_worker_type_follows_persisted_harness_reference(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    runner = get_capability_registry().get(CapabilityKind.HARNESS.value)

    async def selected_codex():
        return CapabilityKind.CODEX_CLI.value

    monkeypatch.setattr(runner, "resolve_reference_kind", selected_codex)

    assert await registry_mod.resolve_default_worker_type() == "codex"


@pytest.mark.asyncio
async def test_cli_capability_test_uses_discovered_value(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    _seed_cli_value(CapabilityKind.CLAUDE_CLI.value, "/usr/bin")
    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable, path=None: f"/usr/bin/{executable}")
    monkeypatch.setattr(
        registry_mod.subprocess,
        "run",
        lambda *args, **kwargs: type("Completed", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
    )

    result = await get_capability_registry().test(CapabilityKind.CLAUDE_CLI.value)

    assert result.result.available is True
    assert result.result.ok is True
    assert result.result.details["path"] == "/usr/bin/claude"


@pytest.mark.asyncio
async def test_cli_capability_test_unavailable_without_discovered_value():
    result = await get_capability_registry().test(CapabilityKind.CODEX_CLI.value)

    assert result.result.available is False
    assert "not found" in result.result.message


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

    result = await get_capability_registry().setup(CapabilityKind.CODEX_CLI.value)

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

    # Only `flow_home` is being redirected; everything else must stay real,
    # because the install now launches through the named `capability-installer`
    # Agent, and upserting its deployment reads settings this test never
    # thought about (instance_name, records_root, …). Delegating beats
    # enumerating — a substituted namespace goes stale the moment a new
    # setting is read.
    _real_settings = instance_settings_pkg.get_instance_settings()

    class _FlowHomeOverride:
        flow_home = str(tmp_path)

        def __getattr__(self, item):
            return getattr(_real_settings, item)

    monkeypatch.setattr(instance_settings_pkg, "get_instance_settings", _FlowHomeOverride)
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

    result = await get_capability_registry().setup(CapabilityKind.CODEX_CLI.value)

    assert result.result.ok is False
    assert "failed" in result.result.message


@pytest.mark.asyncio
async def test_cli_capability_test_runs_version_command(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    calls = []

    def fake_run(argv, **kwargs):
        calls.append((argv, kwargs))
        return SimpleNamespace(returncode=0, stdout="claude 1.2.3\n", stderr="")

    _seed_cli_value(CapabilityKind.CLAUDE_CLI.value, "/bin")
    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable, path=None: f"{path}/{executable}")
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

    _seed_cli_value(CapabilityKind.CODEX_CLI.value, "/bin")
    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable, path=None: f"{path}/{executable}")
    monkeypatch.setattr(registry_mod.subprocess, "run", fake_run)

    result = await get_capability_registry().test(CapabilityKind.CODEX_CLI.value)

    assert result.result.ok is False
    assert result.result.available is True
    assert "timed out" in result.result.message


@pytest.mark.asyncio
async def test_chrome_probe_is_blocked_when_claude_dependency_missing():
    # Empty discovery dict ⇔ claude has no discovered value.
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

    _seed_cli_value(CapabilityKind.CLAUDE_CLI.value, "/bin")
    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable, path=None: f"/bin/{executable}")
    monkeypatch.setattr(
        registry_mod.subprocess,
        "run",
        lambda *args, **kwargs: type("Completed", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
    )
    monkeypatch.setattr(registry_mod, "run_chrome_authenticated_probe", fake_probe)

    result = await get_capability_registry().test(CapabilityKind.CHROME_AUTHENTICATED.value)

    assert result.result.ok is True
    assert result.result.process_id == "agentic-process-id"
    assert CapabilityKind.CLAUDE_CLI.value in result.dependencies


@pytest.mark.asyncio
async def test_harness_reference_delegates_to_target_and_stamps_reference(monkeypatch):
    import flow_sdk.core.capabilities.registry as registry_mod

    _seed_cli_value(CapabilityKind.CLAUDE_CLI.value, "/usr/bin")
    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable, path=None: f"/usr/bin/{executable}")
    monkeypatch.setattr(
        registry_mod.subprocess,
        "run",
        lambda *args, **kwargs: type("Completed", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
    )
    runner = get_capability_registry().get(CapabilityKind.HARNESS.value)

    async def fake_resolve():
        return CapabilityKind.CLAUDE_CLI.value

    monkeypatch.setattr(runner, "_resolve_reference_kind", fake_resolve)

    result = await get_capability_registry().test(CapabilityKind.HARNESS.value)

    assert result.result.available is True
    assert result.result.details["reference_kind"] == CapabilityKind.CLAUDE_CLI.value
    assert result.result.details["path"] == "/usr/bin/claude"


@pytest.mark.asyncio
async def test_harness_reference_rejects_target_outside_allowed_query(monkeypatch):
    runner = get_capability_registry().get(CapabilityKind.HARNESS.value)

    async def fake_resolve():
        return CapabilityKind.CHROME_AUTHENTICATED.value

    monkeypatch.setattr(runner, "_resolve_reference_kind", fake_resolve)

    result = await get_capability_registry().test(CapabilityKind.HARNESS.value)

    assert result.result.available is False
    assert "must be a harness" in result.result.message


@pytest.mark.asyncio
async def test_harness_reference_rejects_unregistered_target(monkeypatch):
    runner = get_capability_registry().get(CapabilityKind.HARNESS.value)

    async def fake_resolve():
        return "harness.unknown.cli"

    monkeypatch.setattr(runner, "_resolve_reference_kind", fake_resolve)

    result = await get_capability_registry().test(CapabilityKind.HARNESS.value)

    assert result.result.available is False
    assert "not registered" in result.result.message


# ── discovery engine ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_run_discovery_populates_dict_and_mirrors_rows(monkeypatch, tmp_path):
    import flow_sdk.builtin.capability as capability_mod
    import flow_sdk.core.capabilities.registry as registry_mod

    bin_dir = tmp_path / "nvm-bin"
    bin_dir.mkdir()

    async def fake_probe(executables):
        return {
            "path": f"{bin_dir}:/usr/bin",
            "executables": {exe: (str(bin_dir / exe) if exe == "codex" else None) for exe in executables},
        }

    monkeypatch.setattr(discovery_mod, "_run_env_probe", fake_probe)
    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable, path=None: f"/bin/{executable}")
    monkeypatch.setattr(
        registry_mod.subprocess,
        "run",
        lambda *args, **kwargs: type("Completed", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
    )

    saved_rows: list[tuple[str, dict | None, str | None]] = []

    class FakeRow:
        def __init__(self, kind):
            self.kind = kind
            self.reference_kind = (
                CapabilityKind.CODEX_CLI.value if kind == CapabilityKind.HARNESS.value else None
            )
            self.value = None
            self.value_type = None
            self.last_check = None
            self.state = "none"
            self.last_setup = None

        # Real derive_state semantics over the fake's fields.
        def derive_state(self, result, *, attempted=False):
            from flow_sdk.builtin.capability import Capability

            return Capability.derive_state(self, result, attempted=attempted)

        async def save(self, notify=True):
            saved_rows.append((self.kind, self.value, self.value_type, self.last_check))
            return self

    async def fake_get_by_kind(kind):
        return FakeRow(kind)

    monkeypatch.setattr(capability_mod.Capability, "get_by_kind", staticmethod(fake_get_by_kind))

    # Pin the harness reference target without a DB read.
    harness_runner = get_capability_registry().get(CapabilityKind.HARNESS.value)

    async def fake_reference():
        return CapabilityKind.CODEX_CLI.value

    monkeypatch.setattr(harness_runner, "resolve_reference_kind", fake_reference)

    discovered = await discovery_mod.run_discovery()

    codex = get_capability_value(CapabilityKind.CODEX_CLI.value)
    assert codex is not None and codex.value["path"] == str(bin_dir)
    assert codex.value_type == "folder"

    claude = get_capability_value(CapabilityKind.CLAUDE_CLI.value)
    assert claude is not None and claude.value is None  # probed, absent

    # Reference mirrors its target's fresh value within the same sweep.
    harness = get_capability_value(CapabilityKind.HARNESS.value)
    assert harness is not None and harness.value["path"] == str(bin_dir)

    # Rows mirrored (changed rows saved with the new value + refreshed badge).
    mirrored = {kind: (value, value_type, last_check) for kind, value, value_type, last_check in saved_rows}
    assert mirrored[CapabilityKind.CODEX_CLI.value][0]["path"] == str(bin_dir)
    assert mirrored[CapabilityKind.CODEX_CLI.value][1] == "folder"
    # last_check refreshed in the same sweep → badge agrees with the value.
    assert mirrored[CapabilityKind.CODEX_CLI.value][2]["available"] is True
    assert mirrored[CapabilityKind.CLAUDE_CLI.value][2]["available"] is False
    assert CapabilityKind.HARNESS.value in discovered
    assert discovery_mod._DISCOVERED_ONCE.is_set()


@pytest.mark.asyncio
async def test_partial_run_discovery_does_not_mark_full_sweep(monkeypatch, tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()

    async def fake_probe(executables):
        return {
            "path": str(bin_dir),
            "executables": {exe: str(bin_dir / exe) for exe in executables},
        }

    async def fake_mirror(discovered):
        return None

    monkeypatch.setattr(discovery_mod, "_run_env_probe", fake_probe)
    monkeypatch.setattr(discovery_mod, "_mirror_to_rows", fake_mirror)

    await discovery_mod.run_discovery([CapabilityKind.CODEX_CLI.value])

    assert get_capability_value(CapabilityKind.CODEX_CLI.value) is not None
    assert not discovery_mod._DISCOVERED_ONCE.is_set()


@pytest.mark.asyncio
async def test_ensure_discovered_runs_one_full_sweep(monkeypatch):
    calls = []

    async def fake_full_sweep(kinds):
        calls.append(kinds)
        discovery_mod._DISCOVERED_ONCE.set()
        return {}

    monkeypatch.setattr(discovery_mod, "_run_discovery_inner", fake_full_sweep)

    assert await discovery_mod.ensure_discovered() is True
    assert await discovery_mod.ensure_discovered() is True
    assert calls == [None]


@pytest.mark.asyncio
async def test_compute_harness_state_reports_default_and_installed(monkeypatch):
    import flow_sdk.core.capabilities.harness_state as harness_state_mod
    import flow_sdk.core.capabilities.registry as registry_mod

    async def fake_ensure_discovered():
        return True

    runner = get_capability_registry().get(CapabilityKind.HARNESS.value)

    async def fake_reference():
        return CapabilityKind.CODEX_CLI.value

    monkeypatch.setattr(harness_state_mod, "ensure_discovered", fake_ensure_discovered)
    monkeypatch.setattr(registry_mod.shutil, "which", lambda executable, path=None: f"/bin/{executable}")
    monkeypatch.setattr(
        registry_mod.subprocess,
        "run",
        lambda *args, **kwargs: type("Completed", (), {"returncode": 0, "stdout": "ok", "stderr": ""})(),
    )
    monkeypatch.setattr(runner, "_resolve_reference_kind", fake_reference)
    _seed_cli_value(CapabilityKind.CODEX_CLI.value, "/bin")

    state = await harness_state_mod.compute_harness_state()

    assert state["show_harness_select"] is False
    by_kind = {h["kind"]: h for h in state["harnesses"]}
    assert by_kind[CapabilityKind.CODEX_CLI.value]["installed"] is True
    assert by_kind[CapabilityKind.CODEX_CLI.value]["is_default"] is True
    assert by_kind[CapabilityKind.CLAUDE_CLI.value]["installed"] is False
    assert by_kind[CapabilityKind.CLAUDE_CLI.value]["is_default"] is False


@pytest.mark.asyncio
async def test_run_discovery_probe_timeout_falls_back_to_process_path(monkeypatch):
    import asyncio as _asyncio

    class FakeProc:
        returncode = None

        async def communicate(self):
            await _asyncio.sleep(1)

        def kill(self):
            pass

        async def wait(self):
            return 0

    async def fake_exec(*argv, **kwargs):
        return FakeProc()

    monkeypatch.setattr(discovery_mod.asyncio, "create_subprocess_exec", fake_exec)
    monkeypatch.setattr(discovery_mod, "PROBE_TIMEOUT_SECONDS", 0.05)
    monkeypatch.setattr(discovery_mod.shutil, "which", lambda exe: f"/fallback/{exe}")

    probe = await discovery_mod._run_env_probe(["codex"])

    assert probe.get("fallback") is True
    assert probe["executables"]["codex"] == "/fallback/codex"


def test_env_probe_resolves_against_captured_path(tmp_path, monkeypatch):
    from flow_sdk.core.capabilities import env_probe

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    exe = bin_dir / "codex"
    exe.write_text("#!/bin/sh\n")
    exe.chmod(0o755)

    monkeypatch.setattr(env_probe, "capture_terminal_path", lambda: str(bin_dir))

    result = env_probe.probe(["codex", "missing-tool"])

    assert result["path"] == str(bin_dir)
    assert result["executables"]["codex"] == str(exe)
    assert result["executables"]["missing-tool"] is None


# ── worker consumption ───────────────────────────────────────────────────────


def test_worker_path_env_prepends_discovered_folder(monkeypatch):
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_path_env

    _seed_cli_value(CapabilityKind.CODEX_CLI.value, "/discovered/bin")
    monkeypatch.setenv("PATH", "/usr/bin:/bin")

    env = worker_path_env("codex")

    assert env == {"PATH": "/discovered/bin:/usr/bin:/bin"}


def test_worker_path_env_none_when_capability_absent():
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_path_env

    assert worker_path_env("codex") is None
    set_capability_value(
        CapabilityValue(kind=CapabilityKind.CODEX_CLI.value, value=None, value_type="folder")
    )
    assert worker_path_env("codex") is None


@pytest.mark.asyncio
async def test_cli_runner_discover_produces_folder_value():
    runner = get_capability_registry().get(CapabilityKind.CODEX_CLI.value)

    found = await runner.discover(
        {"path": "/x", "executables": {"codex": "/some/dir/codex"}}
    )
    assert found.value["path"] == "/some/dir"
    assert found.value_type == "folder"

    missing = await runner.discover({"path": "/x", "executables": {"codex": None}})
    assert missing.value is None
    assert missing.value_type == "folder"
