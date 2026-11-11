"""Portable small-model tier selection for the live worker tests.

The long tests persist the same ``sm`` intent for every worker. Claude and Codex
resolve it to a concrete model; native Copilot resolves it to vendor auto and
omits ``--model``. The tests therefore exercise the production tier seam instead
of carrying a Copilot-only workaround.

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


def small_model_for(_worker: object) -> str:
    """Return the portable ``sm`` tier for any worker.

    Accepts a ``WorkerType`` or a driver short-id (``"claude"`` / ``"codex"`` /
    ``"copilot"`` / ``"claude_code"``) so every call site can use it as-is.
    """
    return ModelTier.SM.value
