"""`flow` imports only the command it runs.

Every command module used to be imported at startup, so each `flow X` paid for every command's
dependency tree -- ~1,060 modules, 0.5s here and 10.7s on a Windows VM -- before `X` started.
"""

from __future__ import annotations

import subprocess
import sys

import pytest
import typer
import typer.main

pytestmark = pytest.mark.timeout(60)  # do not increase timeout without approval

#: The server stack: none of it belongs on the path of a CLI that has not been asked to run anything.
HEAVY = ("fastapi", "sqlalchemy", "flow_sdk.core.entity", "flow_sdk.cli.commands.llm_cmd", "requests")


def test_importing_the_cli_loads_no_command_module_and_no_server_stack():
    code = "import sys, flow_sdk.cli.flow_cli as m; print(' '.join(sorted(sys.modules)))"
    loaded = set(subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=True).stdout.split())

    from flow_sdk.cli.flow_cli import LAZY_COMMANDS

    eager = sorted({module for module, _attr, _settings in LAZY_COMMANDS.values()} & loaded)
    assert not eager, f"command modules imported at startup: {eager}"
    heavy = sorted(name for name in loaded if name.startswith(HEAVY))
    assert not heavy, f"server-stack modules imported at startup: {heavy[:5]}"


def test_every_lazy_command_resolves_under_its_own_name():
    from flow_sdk.cli.flow_cli import LAZY_COMMANDS, app

    group = typer.main.get_command(app)
    for name in LAZY_COMMANDS:
        command = group.get_command(None, name)
        assert command is not None and command.name == name, name


def test_no_module_command_shadows_a_lazy_one():
    """A command defined in flow_cli itself would be found first and the lazy one never loaded --
    the way a dead `status` hid `flow status --check`."""
    from flow_sdk.cli.flow_cli import LAZY_COMMANDS, app

    own = {cmd.name or cmd.callback.__name__.replace("_", "-") for cmd in app.registered_commands}
    own |= {group.name for group in app.registered_groups}
    assert not own & set(LAZY_COMMANDS)


def test_a_lazy_group_keeps_its_callback_options():
    from typer.testing import CliRunner

    from flow_sdk.cli.flow_cli import app

    result = CliRunner().invoke(app, ["status", "--help"])
    assert result.exit_code == 0 and "--check" in result.output
