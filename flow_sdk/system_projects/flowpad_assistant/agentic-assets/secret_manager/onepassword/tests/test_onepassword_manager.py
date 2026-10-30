"""The ``onepassword`` manager's commands, against a fake ``op`` on PATH.

Pinned: ``check`` reads the vault (``op vault get``) and its exit code is the answer; ``grant`` hands ``op`` the
vault and the email as separate arguments (a value is never shell syntax); a missing ``op`` is
"not ready", not a crash.
"""
from __future__ import annotations

import os
import stat
from pathlib import Path

import pytest

from flow_sdk.secrets import SecretStoreError
from flow_sdk.secrets.managers import cli_command, get_manager, list_managers, run_check, run_grant

pytestmark = [pytest.mark.timeout(10)]  # do not increase timeout without approval

VAULT = {"manager": "onepassword", "config": {"vault": "GTM Studio"}}


@pytest.fixture
def fake_op(tmp_path, monkeypatch):
    """An ``op`` that records its argv (one per line) and exits with ``$FAKE_OP_EXIT``."""
    log = tmp_path / "argv"
    script = tmp_path / "bin" / "op"
    script.parent.mkdir()
    script.write_text(f'#!/bin/sh\nfor a in "$@"; do echo "$a"; done > "{log}"\necho "op: $FAKE_OP_ERR" >&2\nexit ${{FAKE_OP_EXIT:-0}}\n')
    script.chmod(script.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setenv("PATH", f"{script.parent}{os.pathsep}{os.environ.get('PATH', '')}")
    monkeypatch.setenv("FAKE_OP_ERR", "")
    return log


def test_the_manager_is_listed_with_its_commands_per_os():
    assert "onepassword" in [m.name for m in list_managers()]
    spec = get_manager("onepassword")
    assert [f.name for f in spec.config_fields if f.required] == ["vault"]
    assert cli_command("onepassword", "install", "darwin") == "brew install 1password-cli"
    assert cli_command("onepassword", "install", "win32") == "winget install AgileBits.1Password.CLI"
    assert "apt-get install -y 1password-cli" in cli_command("onepassword", "install", "linux")
    assert cli_command("onepassword", "login", "linux") == "op signin"
    assert cli_command("onepassword", "check", vault="team") == "op vault get team --format json"
    assert cli_command("onepassword", "grant", vault="V", email="b@x.io") == (
        "op vault user grant --vault V --user b@x.io --permissions allow_viewing")


@pytest.mark.asyncio
async def test_check_is_the_exit_code(fake_op, monkeypatch):
    assert await run_check(VAULT) is True
    assert fake_op.read_text().split("\n")[:5] == ["vault", "get", "GTM Studio", "--format", "json"]
    monkeypatch.setenv("FAKE_OP_EXIT", "1")
    assert await run_check(VAULT) is False


@pytest.mark.asyncio
async def test_check_without_op_is_not_ready(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", str(tmp_path))
    assert await run_check(VAULT) is False


@pytest.mark.asyncio
async def test_grant_passes_vault_and_email_as_single_arguments(fake_op):
    await run_grant(VAULT, "bob@acme.com; rm -rf ~")
    assert fake_op.read_text().splitlines() == [
        "vault", "user", "grant", "--vault", "GTM Studio", "--user", "bob@acme.com; rm -rf ~", "--permissions", "allow_viewing",
    ]


@pytest.mark.asyncio
async def test_a_refused_grant_raises_with_the_tools_reason(fake_op, monkeypatch):
    monkeypatch.setenv("FAKE_OP_EXIT", "1")
    monkeypatch.setenv("FAKE_OP_ERR", "you are not a manager of this vault")
    with pytest.raises(SecretStoreError, match="not a manager of this vault"):
        await run_grant(VAULT, "bob@acme.com")
