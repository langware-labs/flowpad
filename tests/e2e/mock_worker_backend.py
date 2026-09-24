"""A real backend whose agent turns run on ``MockDriver`` — for browser validation with no model.

The same backend ``scripts/instance_ctl.sh`` starts (``flow_sdk.server.run``), with one test seam
applied first: every agentic process gets ``tests/utils/mock_worker.py``'s ``MockDriver``, which runs
a real headless turn and answers ``Mock reply: <prompt>``. Nothing in the product knows about it.

Replace an instance's backend with it (the launcher's env file carries the ports and identity)::

    scripts/instance_ctl.sh launch <name> --keep-env      # then stop just its backend
    set -a; source .env.<name>.local; set +a
    uv run python tests/e2e/mock_worker_backend.py

``flow_sdk.server.run`` serves the app object in-process when reload is off — which the launcher's
env sets (``MINIHUB_RELOAD=False``) — so the patch below is the one every turn sees.
"""
from __future__ import annotations

import sys
import tempfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

import flow_sdk.builtin.agentic_process.agentic_process as agentic_process  # noqa: E402
from flow_sdk.server import run  # noqa: E402
from tests.utils.mock_worker import MockDriver  # noqa: E402


def main() -> None:
    driver = MockDriver(Path(tempfile.mkdtemp(prefix="flowpad-mock-worker-")))
    agentic_process.get_driver = lambda _worker_type: driver
    print(f"[mock-worker] every agent turn answers from MockDriver ({driver.transcript_root})", flush=True)
    run.main()


if __name__ == "__main__":
    main()
