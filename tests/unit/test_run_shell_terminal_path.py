"""A command Flowpad runs sees the PATH a terminal would have — on unix and Windows.

A backend launched from the Dock inherits a minimal PATH, so the llm-setup
wizard reported a Node.js installed through nvm as missing: its check ran
against the backend's own PATH, not the person's. The capability sweep already
captures the terminal PATH (a login shell on unix, the registry on Windows);
`run_shell`, the in-app terminal and workers all extend their PATH with it, and
none of them knows anything about any one version manager.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import sys
from pathlib import Path

import pytest

from flow_sdk.core.capabilities import discovery
from flow_sdk.core.compute.exec import run_shell

WINDOWS = sys.platform == "win32"


def _path(*entries) -> str:
    return os.pathsep.join(str(e) for e in entries)


def _system_dirs() -> list[str]:
    """What a PATH needs for `run_shell`'s own shell to start at all."""
    if WINDOWS:
        system32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
        return [str(system32), str(system32 / "WindowsPowerShell" / "v1.0")]
    return ["/usr/bin", "/bin"]


def _tool(bin_dir: Path, name: str) -> Path:
    """An executable *name* in *bin_dir* that prints `found`."""
    bin_dir.mkdir(parents=True, exist_ok=True)
    if WINDOWS:
        tool = bin_dir / f"{name}.cmd"
        tool.write_text("@echo found\r\n")
    else:
        tool = bin_dir / name
        tool.write_text("#!/bin/sh\necho found\n")
        tool.chmod(0o755)
    return tool


def _where(name: str) -> str:
    """A one-liner printing where *name* resolves in `run_shell`'s shell, else `missing`."""
    if WINDOWS:
        return f"$c = Get-Command {name} -ErrorAction SilentlyContinue; if ($c) {{ $c.Source }} else {{ 'missing' }}"
    return f"command -v {name} || echo missing"


def _same(a, b) -> bool:
    return a is not None and b is not None and os.path.normcase(str(a)) == os.path.normcase(str(b))


async def _sweep(monkeypatch, probe: dict) -> None:
    """One sweep that captures *probe* and discovers nothing else."""

    async def fake_probe(_executables):
        return probe

    async def nothing(*_args, **_kwargs):
        return None

    class _NoRunners:
        def runners(self):
            return []

    from flow_sdk.core.capabilities import registry

    monkeypatch.setattr(discovery, "_run_env_probe", fake_probe)
    monkeypatch.setattr(discovery, "_mirror_to_rows", nothing)
    monkeypatch.setattr(discovery, "_resolve_login_states", nothing)
    monkeypatch.setattr(registry, "get_capability_registry", lambda: _NoRunners())
    # A full sweep marks discovery done; keep that flag out of every other test.
    monkeypatch.setattr(discovery, "_DISCOVERED_ONCE", asyncio.Event())
    await discovery._run_discovery_inner(None)


# ── terminal_path ────────────────────────────────────────────────────────────


def test_before_any_sweep_it_is_this_process_path(monkeypatch, tmp_path):
    monkeypatch.setenv("PATH", str(tmp_path / "process"))

    assert discovery.terminal_path() == str(tmp_path / "process")


async def test_a_sweep_adds_what_the_terminal_has_after_this_process_path(monkeypatch, tmp_path):
    process, shared, terminal = tmp_path / "process", tmp_path / "shared", tmp_path / "terminal"
    monkeypatch.setenv("PATH", _path(process, shared))

    await _sweep(monkeypatch, {"path": _path(terminal, shared), "executables": {}})

    # This process's entries keep their order and win a tie; the terminal only ADDS.
    assert discovery.terminal_path() == _path(process, shared, terminal)


async def test_a_fallen_back_sweep_never_replaces_a_real_capture(monkeypatch, tmp_path):
    process, terminal = tmp_path / "process", tmp_path / "terminal"
    monkeypatch.setenv("PATH", str(process))
    monkeypatch.setattr(discovery, "_TERMINAL_PATH", str(terminal))

    await _sweep(monkeypatch, {"path": str(process), "executables": {}, "fallback": True})

    assert discovery.terminal_path() == _path(process, terminal)


def test_one_dir_spelled_two_ways_is_added_once(monkeypatch, tmp_path):
    tools = tmp_path / "tools"
    monkeypatch.setattr(discovery, "_TERMINAL_PATH", str(tools) + os.sep)

    assert discovery.terminal_path(str(tools)) == str(tools)


@pytest.mark.skipif(not WINDOWS, reason="only Windows paths are case-insensitive")
def test_a_windows_dir_differing_only_in_case_is_added_once(monkeypatch, tmp_path):
    tools = str(tmp_path / "Tools")
    monkeypatch.setattr(discovery, "_TERMINAL_PATH", tools.lower())

    assert discovery.terminal_path(tools) == tools


# ── run_shell ────────────────────────────────────────────────────────────────


async def test_run_shell_finds_a_tool_only_the_terminal_path_has(monkeypatch, tmp_path):
    tool = _tool(tmp_path / "manager", "mytool")
    monkeypatch.setenv("PATH", _path(*_system_dirs()))
    monkeypatch.setattr(discovery, "_TERMINAL_PATH", str(tool.parent))

    result = await run_shell("mytool", timeout_seconds=10, workdir=tmp_path)

    assert result.returncode == 0
    assert result.stdout.strip() == "found"


async def test_a_tool_this_process_already_resolves_is_not_shadowed(monkeypatch, tmp_path):
    own = _tool(tmp_path / "own", "mytool")
    other = _tool(tmp_path / "terminal", "mytool")
    monkeypatch.setenv("PATH", _path(own.parent, *_system_dirs()))
    monkeypatch.setattr(discovery, "_TERMINAL_PATH", str(other.parent))

    result = await run_shell(_where("mytool"), timeout_seconds=10, workdir=tmp_path)

    assert _same(result.stdout.strip(), own)


async def test_a_caller_path_still_wins(monkeypatch, tmp_path):
    tool = _tool(tmp_path / "manager", "mytool")
    monkeypatch.setattr(discovery, "_TERMINAL_PATH", str(tool.parent))

    result = await run_shell(
        _where("mytool"),
        timeout_seconds=10,
        workdir=tmp_path,
        extra_env={"PATH": _path(*_system_dirs())},
    )

    assert result.stdout.strip() == "missing"


# ── One `node` everywhere ────────────────────────────────────────────────────
# What the wizard's check found installed is the binary the in-app terminal and
# a worker then run. Three PATHs built three ways would let a check say "Node.js
# is installed" and the terminal answer "node: command not found".


async def _node_seen_by_every_consumer(monkeypatch, tmp_path) -> list:
    from flow_sdk.builtin.agentic_process.cli_drivers import cli_worker_base_driver as driver
    from flow_sdk.compute.providers.desktop.provider import _build_interactive_pty_env

    harness = tmp_path / "harness-bin"
    harness.mkdir(exist_ok=True)
    monkeypatch.setattr(driver, "worker_bin_folder", lambda _worker_type: str(harness))

    check = await run_shell(_where("node"), timeout_seconds=10, workdir=tmp_path)
    terminal = _build_interactive_pty_env("session")["PATH"]
    worker = driver.build_worker_spawn_env("claude", {})["PATH"]
    return [
        check.stdout.strip(),
        shutil.which("node", path=terminal),
        shutil.which("node", path=worker),
    ]


async def test_a_node_only_the_terminal_knows_is_the_same_node_everywhere(monkeypatch, tmp_path):
    node = _tool(tmp_path / ".nvm" / "versions" / "node" / "v24.13.1" / "bin", "node")
    monkeypatch.setenv("PATH", _path(*_system_dirs()))
    monkeypatch.setattr(discovery, "_TERMINAL_PATH", _path(node.parent, *_system_dirs()))

    seen = await _node_seen_by_every_consumer(monkeypatch, tmp_path)

    assert all(_same(found, node) for found in seen), seen


async def test_a_node_already_on_path_stays_the_one_everywhere(monkeypatch, tmp_path):
    own = _tool(tmp_path / "own" / "bin", "node")
    other = _tool(tmp_path / ".nvm" / "versions" / "node" / "v24.13.1" / "bin", "node")
    monkeypatch.setenv("PATH", _path(own.parent, *_system_dirs()))
    monkeypatch.setattr(discovery, "_TERMINAL_PATH", _path(other.parent, *_system_dirs()))

    seen = await _node_seen_by_every_consumer(monkeypatch, tmp_path)

    assert all(_same(found, own) for found in seen), seen
