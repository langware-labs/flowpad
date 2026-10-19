"""The ``flow`` CLI on the mock worker — for tests that run a REAL ``flow`` command that launches an agent.

``flow project setup`` launches its AI rung inside its own process, and a subprocess cannot be
monkeypatched from the test, so the swap happens here, before the stock CLI starts: ``get_driver``
answers the mock worker, and everything else is ``python -m flow_sdk.cli.flow_cli`` unchanged.

* ``MOCK_TRANSCRIPTS`` — where each agent turn's transcript is written (``<process id>.jsonl``);
* ``MOCK_BEHAVIOR`` — ``module:function``, the turn's :data:`~tests.utils.mock_worker.Behavior`.

Run it as ``python tests/utils/mock_flow_cli.py <flow args>``.
"""
import importlib
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # the repo root, for `tests.utils`

import flow_sdk.builtin.agentic_process.agentic_process as agentic_process  # noqa: E402
from tests.utils.mock_worker import MockDriver  # noqa: E402

_module, _, _name = os.environ["MOCK_BEHAVIOR"].partition(":")
_worker = MockDriver(Path(os.environ["MOCK_TRANSCRIPTS"]), behavior=getattr(importlib.import_module(_module), _name))
agentic_process.get_driver = lambda _t: _worker

from flow_sdk.cli.flow_cli import app  # noqa: E402

if __name__ == "__main__":
    app(prog_name="flow")
