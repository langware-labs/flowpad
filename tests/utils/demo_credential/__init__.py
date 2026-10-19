"""``demo-service`` — a credential whose values need no outside account, and the agent that fills it.

One fixture for every tier that drives the declare → ``flow project setup`` → status path: the
manifest is ``credential.json`` beside this file (the TS tier reads it too), and :func:`follow_setup`
is the mock worker's turn (``MOCK_BEHAVIOR=tests.utils.demo_credential:follow_setup``). It does what a
model does when a setup question is handed to it (AI Assist): reads which value the question asks for,
produces that one value the way the credential's ``setup`` says, and pipes it into the
``flow ask answer <id> --stdin`` command its prompt names — so a test pins the I/O between the pieces,
not a model's reading.

The project folder needs a ``service.url`` holding :data:`ENDPOINT`.
"""
from __future__ import annotations

import asyncio
import json
import re
import subprocess
from pathlib import Path

MANIFEST_PATH = Path(__file__).with_name("credential.json")
KEY_PATTERN = json.loads(MANIFEST_PATH.read_text())["vars"]["DEMO_API_KEY"]["pattern"]
ENDPOINT = "https://demo.example.test/api"
#: One value per question, produced inside the pipe the way the manifest's ``setup`` says — keyed by
#: the variable's label, which the question carries ("Demo service: API key").
PRODUCE = {
    "API key": "printf 'demo_%s' \"$(openssl rand -hex 16)\"",
    "Endpoint": "tr -d '\\n' < service.url",
}
#: The answer command the assist prompt names: the one indented line ending in ``--stdin``.
ANSWER = re.compile(r"^ +(\S.* ask answer \S+ --stdin)$", re.M)
#: The question handed over: ``A person is being asked: <title>: <label>``.
ASKED = re.compile(r"^A person is being asked: (.+)$", re.M)


async def follow_setup(turn) -> str:
    """Answer the question handed over with its one value, piped into the answer command — recorded
    as the one Bash call a real harness would make."""
    answer = ANSWER.search(turn.prompt)
    assert answer, f"the assist prompt names no `ask answer ... --stdin` command:\n{turn.prompt}"
    assert "service.url" in turn.prompt, "the prompt carries the credential's own setup"
    asked = ASKED.search(turn.prompt)
    assert asked, f"the assist prompt names no question:\n{turn.prompt}"
    label = next((name for name in PRODUCE if asked.group(1).rstrip().endswith(name)), None)
    assert label, f"no value is produced for the question {asked.group(1)!r}"
    command = f"{PRODUCE[label]} | {answer.group(1)}"
    shell = await asyncio.create_subprocess_shell(command, cwd=turn.process.workdir,
                                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    said = (await shell.communicate())[0].decode()
    turn._tool("Bash", {"command": command}, said)
    return f"Answered: {label}." if shell.returncode == 0 else f"The answer failed: {said}"
