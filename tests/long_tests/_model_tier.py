"""Small-model tier selection for the live worker tests.

The long tests run on the cheapest model so they stay fast and inexpensive —
the prompts are trivial. Claude and Codex map the ``sm`` tier to a real model
(haiku / gpt-5.4-mini), so they're asked for it explicitly.

Copilot is the exception and must stay UNSET. ``COPILOT_MODEL_TIERS`` still
carries Codex's names (``gpt-5.4-mini`` / ``gpt-5.4``), which the Copilot CLI
rejects outright::

    [WARNING] Model 'gpt-5.4-mini' from CLI argument is not available.
    [ERROR]   Model "gpt-5.4" from --model flag is not available.

Passing a model Copilot can't resolve degrades (sm) or hard-fails (md) the turn.
Copilot's own auto mode already resolves simple prompts to ``claude-haiku-4.5``
— its small tier — so leaving the model unset is both correct and already cheap.
"""

from __future__ import annotations

from flow_sdk.builtin.agentic_process.model_tiers import ModelTier
from flow_sdk.flowpad_types.enums import WorkerType


def small_model_for(worker: object) -> str | None:
    """The ``sm`` tier for *worker*, or ``None`` when the model must stay unset.

    Accepts a ``WorkerType`` or a driver short-id (``"claude"`` / ``"codex"`` /
    ``"copilot"`` / ``"claude_code"``) so every call site can use it as-is.
    """
    key = worker.value if isinstance(worker, WorkerType) else str(worker)
    if key == WorkerType.COPILOT.value:
        return None
    return ModelTier.SM.value
