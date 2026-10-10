"""A finished command is released once its caller drops it.

Compute providers are process-lifetime singletons, so any command they keep a
reference to lives for the life of the backend. Every git call the UI makes
(~5 per page load) goes through ``run_command``; these tests pin the rule that
the provider holds nothing once the command is done and the caller has let go
of the returned ``CLICommand`` — its output lists, its two queues, and (for a
background command on the local provider) the task that waited for it.

Liveness is asserted through weakrefs rather than a provider attribute so the
tests stay valid whether a registry is absent or merely emptied.
"""
from __future__ import annotations

import asyncio
import gc
import weakref

import pytest

from flow_sdk.compute.providers.compute_provider import ComputeProvider
from flow_sdk.compute.providers.e2b import provider as e2b_module
from tests.unit.conftest import node, py_command  # noqa: F401


async def _run_foreground_and_drop(run) -> list[weakref.ref]:
    refs = []
    for i in range(3):
        cmd = await run(py_command(f"print({i})"))
        assert cmd.exit_code == 0 and cmd.all_stdout.strip() == str(i), cmd
        refs.append(weakref.ref(cmd))
        del cmd
    gc.collect()
    return refs


@pytest.mark.asyncio
async def test_local_foreground_commands_are_released(node):  # noqa: F811
    provider, node_id = node

    refs = await _run_foreground_and_drop(
        lambda c: provider.run_command(node_id, c, background=False)
    )

    assert [r() for r in refs] == [None, None, None]


@pytest.mark.asyncio
async def test_local_background_commands_are_released(node):  # noqa: F811
    provider, node_id = node
    refs = []
    waiters = []
    for i in range(3):
        cmd = await provider.run_command(node_id, py_command(f"print({i})"), background=True)
        # the task that waits on the process; it must leave _commands_tasks on its own
        waiters.extend(provider._commands_tasks[node_id])
        lines = [ln async for ln in cmd.stdout_stream()]
        assert lines == [f"{i}\n"], lines
        await cmd.wait()
        refs.append(weakref.ref(cmd))
        del cmd
    await asyncio.gather(*waiters)
    gc.collect()

    assert [r() for r in refs] == [None, None, None]
    assert sum(len(v) for v in provider._commands_tasks.values()) == 0
    assert sum(len(v) for v in provider._stream_tasks.values()) == 0


# --------------------------------------------------------------------- e2b --
# The e2b SDK is a boundary, not the component under test: a fake sandbox runs
# the command locally and drives the provider's own callbacks the way the SDK
# does (on_stdout/on_stderr, a process with .exit_code and .wait()).


class _Proc:
    def __init__(self, exit_code: int):
        self.exit_code = exit_code

    async def wait(self):
        return self


class _Commands:
    async def run(self, cmd, on_stdout=None, on_stderr=None, timeout=None, background=False, cwd=None):
        p = await asyncio.create_subprocess_shell(
            cmd, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, cwd=cwd
        )
        out, err = await p.communicate()
        if out and on_stdout:
            on_stdout(out.decode())
        if err and on_stderr:
            on_stderr(err.decode())
        return _Proc(p.returncode or 0)


class _FakeSandbox:
    sandbox_id = "fake"

    def __init__(self):
        self.commands = _Commands()


@pytest.fixture
def e2b_provider():
    provider = object.__new__(e2b_module.E2BComputeProvider)  # skip the SDK-installed check
    ComputeProvider.__init__(provider)
    provider._sandboxes, provider._pty_processes, provider._keepalive_tasks = {}, {}, {}
    sandbox = _FakeSandbox()

    async def _boot(_node_id):
        return sandbox

    provider._get_or_boot_sandbox = _boot
    return provider


@pytest.mark.asyncio
async def test_e2b_foreground_commands_are_released(e2b_provider):
    refs = await _run_foreground_and_drop(
        lambda c: e2b_provider.run_command("fake", c, background=False)
    )

    assert [r() for r in refs] == [None, None, None]


@pytest.mark.asyncio
async def test_e2b_background_commands_are_released(e2b_provider):
    refs = []
    for i in range(3):
        cmd = await e2b_provider.run_command("fake", py_command(f"print({i})"), background=True)
        await cmd.wait()
        assert cmd.exit_code == 0 and cmd.all_stdout.strip() == str(i), cmd
        refs.append(weakref.ref(cmd))
        del cmd
    # handle_output has set the event; one more turn lets the task return and drop its closure
    await asyncio.sleep(0)
    gc.collect()

    assert [r() for r in refs] == [None, None, None]
