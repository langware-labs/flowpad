"""The control shells a Windows machine runs the hub's commands in.

A few PowerShell hosts are started once and each runs commands one after another
(a PowerShell per command took 30-50 s to start on a Defender-scanned VM, longer
than the hub's probe waits). These run the REAL host: PowerShell exists only on
Windows, so the PowerShell half is Windows-only; the script builder is checked
everywhere.
"""

import asyncio
import sys

import pytest

from flow_sdk.compute.user_machine.control_shell import ControlShells, command_script

windows_only = pytest.mark.skipif(sys.platform != "win32", reason="PowerShell control shells are Windows-only")


def test_a_command_script_sets_its_env_and_restores_it():
    script = command_script("flow start service", "C:\\Users\\it's", {"FLOWPAD_HUB_URL": "http://h'1"})
    assert "SetLocation([WildcardPattern]::Escape('C:\\Users\\it''s'))" in script
    assert "[Environment]::SetEnvironmentVariable('FLOWPAD_HUB_URL', 'http://h''1')" in script
    assert script.startswith("try {") and "} finally {" in script


def test_a_command_with_no_env_is_just_the_command_in_its_directory():
    assert (
        command_script("whoami", "C:\\w") == "$null = $ExecutionContext.SessionState.Path.SetLocation("
        "[WildcardPattern]::Escape('C:\\w'))\nwhoami\n"
    )


async def _run(shells, cmd, cwd, env=None):
    shell = await shells.acquire()
    out, err, code = "", "", None
    try:
        async for o in shell.run(command_script(cmd, cwd, env)):
            out += o.stdout or ""
            err += o.stderr or ""
            code = o.exit_code if o.exit_code is not None else code
    finally:
        shells.release(shell)
    return out, err, code


@windows_only
@pytest.mark.long  # PowerShell starts take seconds on a scanned machine
async def test_control_shells_run_commands_back_to_back_with_their_own_exit_codes(tmp_path):
    import shutil

    shells = ControlShells(shutil.which("powershell"), env=dict(__import__("os").environ), cwd=str(tmp_path))
    try:
        out, _, code = await _run(shells, "& cmd.exe /c 'echo hi'", str(tmp_path))
        assert (out.strip(), code) == ("hi", 0)
        _, _, code = await _run(shells, "& cmd.exe /c 'exit 7'", str(tmp_path))
        assert code == 7
        _, err, code = await _run(shells, "throw 'boom'", str(tmp_path))
        assert code == 1 and "boom" in err
        out, _, _ = await _run(shells, "$env:FLOW_CS_PROBE", str(tmp_path), {"FLOW_CS_PROBE": "שלום"})
        assert out.strip() == "שלום"
        out, _, _ = await _run(shells, "[string]$env:FLOW_CS_PROBE", str(tmp_path))
        assert out.strip() == ""  # restored: one command's env never reaches the next
        out, _, _ = await _run(shells, "$PWD.Path", str(tmp_path))
        assert __import__("os").path.samefile(out.strip(), tmp_path)  # PowerShell reports the long name
    finally:
        await shells.close()


@windows_only
@pytest.mark.long
async def test_a_cancelled_command_takes_its_shell_and_child_with_it(tmp_path):
    import shutil

    shells = ControlShells(shutil.which("powershell"), env=dict(__import__("os").environ), cwd=str(tmp_path))
    try:
        shell = await shells.acquire()
        gen = shell.run(command_script("& ping.exe -n 30 127.0.0.1", str(tmp_path)))
        await asyncio.wait_for(gen.__anext__(), 30)
        shells.discard(shell)
        await asyncio.wait_for(shell.process.wait(), 10)
        out, _, code = await _run(shells, "'still serving'", str(tmp_path))
        assert (out.strip(), code) == ("still serving", 0)
    finally:
        await shells.close()
