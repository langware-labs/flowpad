"""Portable small-model tier selection for the live worker tests.

The long tests persist the same ``sm`` intent for every worker. Claude and Codex
resolve it to a concrete model; native Copilot resolves it to vendor auto and
omits ``--model``. The tests therefore exercise the production tier seam instead
of carrying a Copilot-only workaround.
"""

from __future__ import annotations

from flow_sdk.builtin.agentic_process.model_tiers import ModelTier


def small_model_for(_worker: object) -> str:
    """Return the portable ``sm`` tier for any worker.

    Accepts a ``WorkerType`` or a driver short-id (``"claude"`` / ``"codex"`` /
    ``"copilot"`` / ``"claude_code"``) so every call site can use it as-is.
    """
    return ModelTier.SM.value
