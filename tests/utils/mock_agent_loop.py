"""A deployment's loop process on the mock worker — for tests that run a REAL deployment process.

A subprocess cannot be monkeypatched from the test, so the swap happens here, in the process
itself, before the stock loop starts: ``get_driver`` answers the mock worker (transcripts under
``MOCK_TRANSCRIPTS``), and everything else is ``python -m flow_sdk.builtin.agent_loop`` unchanged.
A test points a deployment at this file with ``agent.run_locally(snippet=<this path>)``.
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # the repo root, for `tests.utils`

from tests.utils.mock_worker import MockDriver  # noqa: E402

import flow_sdk.builtin.agentic_process.agentic_process as agentic_process  # noqa: E402

_worker = MockDriver(Path(os.environ["MOCK_TRANSCRIPTS"]))
agentic_process.get_driver = lambda _t: _worker

from flow_sdk.builtin.agent_loop import main  # noqa: E402

if __name__ == "__main__":
    main()
