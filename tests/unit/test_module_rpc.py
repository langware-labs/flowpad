"""The module contract, driven against real processes.

A mock cannot tell you whether the request actually reached the child, whether a
non-zero exit was classified, or whether stderr survived — those are properties
of spawning, so every test here spawns.
"""
from __future__ import annotations

import json
import stat
from pathlib import Path

import pytest

from flow_sdk.utils.command_executor import _LocalCommandExecutor
from flow_sdk.utils.module_rpc import ModuleFailure, call_module

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _module(tmp_path: Path, body: str) -> str:
    """A real executable module. Returns its path."""
    p = tmp_path / "fetch.py"
    p.write_text("#!/usr/bin/env python3\nimport json,sys\n" + body, encoding="utf-8")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


async def test_request_reaches_the_module_and_response_comes_back(tmp_path):
    script = _module(tmp_path, "req=json.load(open(sys.argv[3]))\nprint(json.dumps({'echo': req['hello'], 'verb': sys.argv[1]}))\n")

    result = await call_module(
        _LocalCommandExecutor(), script=script, verb="delta",
        request={"hello": "world"}, workdir=str(tmp_path / "run"),
    )

    assert result.data == {"echo": "world", "verb": "delta"}


async def test_exit_3_is_config_and_exit_4_is_transient(tmp_path):
    for code, kind in ((3, "config"), (4, "transient"), (9, "transient")):
        script = _module(tmp_path, f"sys.stderr.write('boom')\nsys.exit({code})\n")
        with pytest.raises(ModuleFailure) as caught:
            await call_module(
                _LocalCommandExecutor(), script=script, verb="fetch",
                request={}, workdir=str(tmp_path / "run"),
            )
        assert caught.value.kind == kind, f"exit {code}"
        assert "boom" in caught.value.logs, "stderr was dropped"


async def test_zero_exit_with_junk_stdout_is_config_not_transient(tmp_path):
    """It ran to completion and broke the contract. Retrying cannot fix that."""
    script = _module(tmp_path, "print('not json')\n")

    with pytest.raises(ModuleFailure) as caught:
        await call_module(
            _LocalCommandExecutor(), script=script, verb="scopes",
            request={}, workdir=str(tmp_path / "run"),
        )

    assert caught.value.kind == "config"
