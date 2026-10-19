"""Per-worker pricing for transcript usage entries.

Public API::

    from flow_sdk.transcript_analyzer.pricing import pricing_for, ModelPricing

    table = pricing_for("claude-sonnet-4-6")          # auto-detects worker by model name
    cost = table.cost(transcript.usage)                # sum across entries

Each worker module (``pricing.claude``, ``pricing.codex``) owns its own
price table; this top-level module dispatches by model name and exposes
the legacy ``(input, output)`` 2-field shape for callers that haven't
migrated to per-dim entries.
"""

from __future__ import annotations

from flow_sdk.flowpad_types.vendors import VENDORS

from .base import ItemPrice, ModelPricing
from .claude import CLAUDE_PRICING
from .claude import pricing_for as _claude_pricing_for
from .codex import CODEX_PRICING
from .codex import pricing_for as _codex_pricing_for
from .opencode import OPENCODE_PRICING
from .opencode import pricing_for as _opencode_pricing_for

_TABLES = {"claude": _claude_pricing_for, "codex": _codex_pricing_for, "opencode": _opencode_pricing_for}
# (vendor key, model prefixes, table) for every vendor WITH a table — copilot has
# none and falls to the claude default like any unknown model.
_DISPATCH = tuple((v.key, v.model_prefixes, _TABLES[v.key]) for v in VENDORS if v.key in _TABLES)

__all__ = [
    "ItemPrice",
    "ModelPricing",
    "CLAUDE_PRICING",
    "CODEX_PRICING",
    "OPENCODE_PRICING",
    "pricing_for",
    "legacy_input_output_rates",
    "total_cost_usd",
]


def total_cost_usd(worker: str, jsonl_path) -> float:
    """Sum the USD cost of every usage entry in a transcript JSONL.

    Wraps ``AgentTranscriptFile`` + ``pricing_for`` so callers that just want a
    bottom-line dollar figure don't have to walk the usage list themselves.
    Returns 0.0 for an empty / unreadable transcript (does not raise) — the
    caller decides whether to treat 0 as "not yet billed" vs "free".
    """
    from pathlib import Path

    from ..transcript import AgentTranscriptFile

    path = Path(jsonl_path)
    if not path.is_file():
        return 0.0
    try:
        t = AgentTranscriptFile(worker, path)
    except Exception:
        return 0.0
    total = 0.0
    for e in t.usage:
        rate = pricing_for(e.model, worker)
        total += rate.cost_of(e)
    return total


def pricing_for(model: str | None, worker: str | None = None) -> ModelPricing:
    """Resolve a price table for a model.

    Worker hint short-circuits the dispatch; otherwise we match on the model
    prefixes ``VENDORS`` declares (claude/gpt/openrouter). Falls back to the
    Claude table — also the documented answer for copilot, which has no table
    of its own — so cost reporting degrades gracefully on unknown models.
    """
    for key, prefixes, table in _DISPATCH:
        if worker == key or (model and model.startswith(prefixes)):
            return table(model)
    return _claude_pricing_for(model)


def legacy_input_output_rates(model: str | None) -> tuple[float, float]:
    """Back-compat shim for callers that only consume ``(input, output)`` $/MTok.

    Returns the bare-input (``cache=none``) and ``output`` rates as
    $/1M tokens — matching the legacy ``MODEL_PRICING[model] = {"input": .., "output": ..}``
    contract consumed by ``flow_sdk/builtin/faas/analytics/_pricing.py``.
    """
    from .base import ItemPrice

    table = pricing_for(model)
    in_rate = 0.0
    out_rate = 0.0
    for rule in table.items:
        dims = dict(rule.dims)
        if dims == {"io": "input", "cache": "none"} and in_rate == 0.0:
            in_rate = rule.per_unit_usd * 1_000_000
        elif dims == {"io": "output"} and out_rate == 0.0:
            out_rate = rule.per_unit_usd * 1_000_000
    return in_rate, out_rate
