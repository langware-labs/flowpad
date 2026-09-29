"""Manual check: does Flowpad find the tools your terminal finds — everywhere?

Run it with the stripped PATH a Dock/Finder/Start-Menu launch gives the backend:

    macOS/Linux:  env -i HOME="$HOME" SHELL="$SHELL" USER="$USER" PATH=/usr/bin:/bin \
                      ~/.local/bin/uv run python scripts/verify_terminal_path.py [tool ...]
    Windows:      uv run python scripts/verify_terminal_path.py [tool ...]

Tools default to `node claude`. It runs the REAL env probe (what the capability
sweep runs at startup), then asks the three consumers where each tool is: the
wizard's check (`run_shell`), the in-app terminal's env and a worker's env. For
every tool your terminal has, all three must print the same path.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from flow_sdk.builtin.agentic_process.cli_drivers import cli_worker_base_driver as driver
from flow_sdk.compute.providers.desktop.provider import _build_interactive_pty_env
from flow_sdk.core.capabilities import discovery
from flow_sdk.core.compute.exec import run_shell

MISSING = "NOT FOUND"


def _where(tool: str) -> str:
    if sys.platform == "win32":
        return f"$c = Get-Command {tool} -ErrorAction SilentlyContinue; if ($c) {{ $c.Source }} else {{ '{MISSING}' }}"
    return f"command -v {tool} || echo '{MISSING}'"


async def main(tools: list[str]) -> int:
    print(f"backend PATH (as launched): {os.environ.get('PATH', '')}\n")

    # The same child process the startup sweep spawns.
    probe = json.loads(
        subprocess.run(
            [sys.executable, "-m", "flow_sdk.core.capabilities.env_probe", *tools],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
    )
    discovery._TERMINAL_PATH = probe["path"]

    failed = False
    with tempfile.TemporaryDirectory() as tmp:
        harness = Path(tmp) / "harness-bin"
        harness.mkdir()
        driver.worker_bin_folder = lambda _worker_type: str(harness)  # no real harness needed
        terminal_env = _build_interactive_pty_env("verify")["PATH"]
        worker_env = driver.build_worker_spawn_env("claude", {})["PATH"]

        for tool in tools:
            in_terminal = probe["executables"].get(tool)
            check = (await run_shell(_where(tool), timeout_seconds=10, workdir=Path(tmp))).stdout.strip()
            seen = {
                "your terminal": in_terminal or MISSING,
                "wizard check (run_shell)": check or MISSING,
                "in-app terminal": shutil.which(tool, path=terminal_env) or MISSING,
                "worker": shutil.which(tool, path=worker_env) or MISSING,
            }
            same = in_terminal is None or len({os.path.normcase(p) for p in seen.values()}) == 1
            failed |= not same
            print(f"── {tool}: {'PASS' if same else 'FAIL'}")
            for who, where in seen.items():
                print(f"   {who:26} {where}")

    print("\nFAIL — a tool your terminal has is missing or different somewhere" if failed else "\nPASS")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:] or ["node", "claude"])))
