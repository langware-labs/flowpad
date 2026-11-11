"""The CLI and Python SDK channels of the connections matrices, each run in its own process."""

from __future__ import annotations

import json
import subprocess
import sys
from typing import Mapping

#: Connect (optionally), require, probe the provider and resolve a token — the SDK a
#: caller would write. The token itself never reaches stdout, only its digest.
_SDK_PROBE = """
import asyncio, hashlib, json, sys
from flow_sdk.connections import get_connection, require

async def main(provider, connect):
    if connect:
        await (await get_connection(provider)).connect()
    held = await require(provider)
    probe = await held.test()
    token = await held.token()
    print(json.dumps({"connected": held.connected, "ok": probe.ok, "identity": probe.identity,
                      "code": probe.code, "token_sha256": hashlib.sha256((token or "").encode()).hexdigest() if token else None}))

asyncio.run(main(sys.argv[1], sys.argv[2] == "1"))
"""

#: The hub login: required and tested like a provider, but it has no token to hand out.
_ACCOUNT_PROBE = """
import asyncio, json
from flow_sdk.connections import require
from flow_sdk.schema.data_spec.connection_spec import FLOWPAD_ACCOUNT_PROVIDER

async def main():
    held = await require(FLOWPAD_ACCOUNT_PROVIDER)
    probe = await held.test()
    print(json.dumps({"connected": held.connected, "ok": probe.ok, "identity": probe.identity, "code": probe.code}))

asyncio.run(main())
"""


def last_json(stdout: str) -> dict:
    return json.loads(stdout.strip().splitlines()[-1])


def connections_cli(env: Mapping[str, str], *args: str) -> subprocess.CompletedProcess:
    """``flow connections <args>`` in a fresh process."""
    return subprocess.run(
        [sys.executable, "-m", "flow_sdk.cli.flow_cli", "connections", *args],
        capture_output=True,
        text=True,
        env=dict(env),
    )


def sdk_probe(env: Mapping[str, str], provider: str, *, connect: bool = False) -> subprocess.CompletedProcess:
    """The SDK probe for ``provider`` in a fresh process; its result is ``last_json(stdout)``."""
    return subprocess.run(
        [sys.executable, "-c", _SDK_PROBE, provider, "1" if connect else "0"],
        capture_output=True,
        text=True,
        env=dict(env),
    )


def account_probe(env: Mapping[str, str]) -> subprocess.CompletedProcess:
    """The SDK probe for this instance's hub login, in a fresh process."""
    return subprocess.run([sys.executable, "-c", _ACCOUNT_PROBE], capture_output=True, text=True, env=dict(env))
