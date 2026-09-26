"""``demo-service`` — a credential whose values need no outside account, and the agent that fills it.

One fixture for every tier that drives the declare → ``flow project setup`` → status path: the
manifest is ``secret_pack.json`` beside this file (the TS tier reads it too), and :func:`follow_setup`
is the mock worker's turn (``MOCK_BEHAVIOR=tests.utils.demo_credential:follow_setup``). It does what a
model following the credential's ``setup`` does — takes the store command from its prompt and pipes
the setup's values into it — so a test pins the I/O between the pieces, not a model's reading.

The project folder needs a ``service.url`` holding :data:`ENDPOINT`.
"""
from __future__ import annotations

import asyncio
import json
import re
import subprocess
from pathlib import Path

MANIFEST_PATH = Path(__file__).with_name("secret_pack.json")
KEY_PATTERN = json.loads(MANIFEST_PATH.read_text())["vars"]["DEMO_API_KEY"]["pattern"]
ENDPOINT = "https://demo.example.test/api"
#: The values, produced inside the pipe the way the manifest's ``setup`` says.
PRODUCE = "{ printf 'DEMO_API_KEY=demo_%s\\n' \"$(openssl rand -hex 16)\"; printf 'DEMO_ENDPOINT=%s\\n' \"$(cat service.url)\"; }"
#: The store command the AI rung's prompt names: the one indented line ending in ``--stdin``.
STORE = re.compile(r"^ +(\S.* credentials set demo-service .*--stdin)$", re.M)


async def follow_setup(turn) -> str:
    """Pipe the values into the store command the prompt names — recorded as the one Bash call a
    real harness would make."""
    store = STORE.search(turn.prompt)
    assert store, f"the AI rung's prompt names no `--stdin` store command:\n{turn.prompt}"
    assert PRODUCE in turn.prompt, "the prompt carries the credential's own setup"
    command = f"{PRODUCE} | {store.group(1)}"
    shell = await asyncio.create_subprocess_shell(command, cwd=turn.process.workdir,
                                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    said = (await shell.communicate())[0].decode()
    turn._tool("Bash", {"command": command}, said)
    return "Stored the demo-service values." if shell.returncode == 0 else f"The store failed: {said}"
