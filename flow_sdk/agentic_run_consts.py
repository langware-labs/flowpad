"""Shared constants for driving a headless AgenticProcess from the CLI.

The migration runner and the `flow diagnose` / `flow migrate` commands all spawn a
headless worker, wait for it to start, then stream its transcript. These values
parametrize that shared loop so the call sites don't each carry magic numbers.
The shared "wait for start" step itself lives in ``flow_sdk.agentic_warmup``.

Kept in a dependency-free leaf module (NOT under the heavy
``flow_sdk.builtin.agentic_process`` package) so importing the constants doesn't
drag the agentic-process machinery into `flow` CLI startup.
"""
from __future__ import annotations

# Poll cadence while waiting for the worker to write its first transcript line.
AGENT_WARMUP_INTERVAL_S: float = 0.1

# Default transcript stream budget for a CLI-driven agent run. Overrides the
# lower engine default (``AgenticProcess.stream_transcript`` defaults to 300s)
# because a full CLI task can legitimately run much longer.
DEFAULT_TRANSCRIPT_TIMEOUT_S: float = 1800.0
