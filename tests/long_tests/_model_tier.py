"""Portable small-model tier selection for the live worker tests.

Only Claude's CLI has native size aliases (``haiku``/``sonnet``/``opus``). Every
other worker on its own device login resolves a size through
``Capability.model_map['device']``, and an unmapped size is refused at spawn
(``model_tiers.resolve_model_tier``, since 51d4d97f1) rather than silently
replaced by the vendor default. So a size is named only for Claude; the other
workers omit the model and their vendor chooses, which is what an unconfigured
box does in production. An endpoint-funded worker resolves either way.

TIER POLICY (why some tests override ``sm``)
--------------------------------------------
``sm`` is the right default: cheapest, fastest, and enough for the many tests
that only need a worker to answer at all. It is NOT enough for a test whose
SUBJECT is the model following a skill protocol or choosing a tool unprompted —
those are reasoning behaviours, and a model too small to exhibit the behaviour
under test turns a product test into a coin flip that looks like a product bug.

So: pin per test, to the smallest tier that RELIABLY exhibits the behaviour, and
prove the choice by measurement rather than taste — run it both ways and record
the pass rate and wall-clock at the call site. Two measured cases today, both
overriding to ``md``:

  * ``test_docs_browse_skill``   ambient (un-nudged) skill discovery
  * ``test_markdown_index``      end-to-end markdown_index skill protocol

A bigger tier is never a flake mask. Retries stay 0 everywhere; if a test only
passes sometimes at ``md``, that is a real finding, not a reason to reach for
``lg``. Equally, do not tax a mechanical test (one that is TOLD what to do) with
a bigger tier — pin those to ``sm`` explicitly so the intent is visible.
"""

from __future__ import annotations

from flow_sdk.builtin.agentic_process.model_tiers import ModelTier


_NATIVE_SIZE_WORKERS = frozenset({"claude", "claude_code", "claude-code"})


def model_for(worker: object, tier: ModelTier | str) -> str | None:
    """``tier`` for a worker whose CLI knows sizes natively (Claude), else ``None`` (omit: vendor choice).

    Accepts a ``WorkerType`` or a driver short-id (``"claude"`` / ``"codex"`` /
    ``"copilot"`` / ``"claude_code"``) so every call site can use it as-is.
    """
    name = str(getattr(worker, "value", worker)).lower()
    return (tier.value if isinstance(tier, ModelTier) else str(tier)) if name in _NATIVE_SIZE_WORKERS else None


def small_model_for(worker: object) -> str | None:
    """The portable ``sm`` tier where the worker can honour it (see ``model_for``)."""
    return model_for(worker, ModelTier.SM)
