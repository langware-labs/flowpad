"""Legacy ``$/MTok`` pricing shim for cost aggregation.

The canonical pricing source is :mod:`flow_sdk.transcript_analyzer.pricing`
(per-worker, per-model tables with cache-tier disaggregation). This module
exposes the flat ``{"input", "output"}`` shape the cost aggregation expects,
delegating to that source. Relocated from the deleted
``system_profile/utils.py``.
"""

from __future__ import annotations

# Cache write/read multipliers for the legacy ``calculate_session_cost`` shape.
CACHE_WRITE_MULTIPLIER = 1.25
CACHE_READ_MULTIPLIER = 0.10


def get_model_pricing(model: str) -> dict:
    """Return ``{"input": $/MTok, "output": $/MTok}`` for a model."""
    from flow_sdk.transcript_analyzer.pricing import legacy_input_output_rates

    in_rate, out_rate = legacy_input_output_rates(model)
    return {"input": in_rate, "output": out_rate}
