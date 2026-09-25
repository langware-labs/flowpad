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
DEMO: dict = json.loads(MANIFEST_PATH.read_text())
KEY_PATTERN = DEMO["vars"]["DEMO_API_KEY"]["pattern"]
ENDPOINT = "https://demo.example.test/api"


async def follow_setup(turn) -> str:
    """Run the setup's pipe into the store command the prompt names — recorded as the one Bash call
    a real harness would make."""
    store = re.search(r"piping `VAR=VALUE` lines into:\n\n    (.+)\n", turn.prompt).group(1)
    produce = re.search(r"Produce both and store them in one pipe: `(.+) \| flow credentials set", turn.prompt).group(1)
    command = f"{produce} | {store}"
    shell = await asyncio.create_subprocess_shell(command, cwd=turn.process.workdir,
                                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    said = (await shell.communicate())[0].decode()
    turn._tool("Bash", {"command": command}, said)
    return "Stored the demo-service values." if shell.returncode == 0 else f"The store failed: {said}"
