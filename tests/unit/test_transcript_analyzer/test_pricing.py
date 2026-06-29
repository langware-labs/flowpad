"""Pricing benchmark — assert per-transcript cost matches verified manual numbers.

The 6 fixtures under ``resources/transcripts/cost/`` are real Sonnet 4.6
session jsonls from the workflow-learning demo runs. Their expected USD
totals were computed by hand from raw ``message.usage`` blocks against
the published Anthropic rates (Jan 2026):

    bare input        $3/MTok
    bare output      $15/MTok
    cache read       $0.30/MTok
    cache write 5m   $3.75/MTok
    cache write 1h   $6.00/MTok

The parser splits each Claude ``usage`` payload into per-dim ``UsageEntry``
records; the pricing table dot-products them. Tolerance is $0.001 — any
real price-table change will surface as a delta with both actual and
expected, which is the point of pinning these values.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.transcript_analyzer import AgentTranscriptFile, EntryKind, UsageEntry

_RESOURCES = Path(__file__).parent.parent / "resources" / "transcripts" / "cost"


# (fixture_name, expected_usd) — verified per-message totals.
# Each turn's `usage` block appears once per tool_use block in the JSONL but
# Claude bills per-message, so the parser dedupes by `message.id`. The numbers
# below reflect deduped sums against Sonnet-4 rates (Jan 2026).
COST_BENCHMARKS = [
    ("chat_run1.jsonl", 0.1781),
    ("chat_run2.jsonl", 0.2004),
    ("nav_run1.jsonl",  0.2004),
    ("nav_run2.jsonl",  0.2130),
    ("term_run1.jsonl", 0.2218),
    ("term_run2.jsonl", 0.2177),
]


@pytest.mark.parametrize("filename,expected_usd", COST_BENCHMARKS)
def test_transcript_cost_matches_manual_calc(filename: str, expected_usd: float):
    path = _RESOURCES / filename
    assert path.exists(), f"fixture missing: {path}"
    t = AgentTranscriptFile("claude", path)
    actual = t.cost()
    assert actual == pytest.approx(expected_usd, abs=0.001), (
        f"{filename}: cost {actual:.4f} != expected {expected_usd:.4f}"
    )


def test_usage_property_filters_to_per_dim_entries():
    """``transcript.usage`` only yields ``UsageEntry`` instances, never aggregates."""
    t = AgentTranscriptFile("claude", _RESOURCES / "chat_run1.jsonl")
    usage = t.usage
    assert len(usage) > 0
    assert all(isinstance(e, UsageEntry) for e in usage)
    assert all(e.kind is EntryKind.TOKEN_USAGE for e in usage)


def test_per_dim_split_includes_cache_and_io_axes():
    """Each Claude turn with cache_creation_1h emits ≥3 entries (input + output + cache_read + cache_write_1h)."""
    t = AgentTranscriptFile("claude", _RESOURCES / "nav_run1.jsonl")
    dims_seen = {(e.io, e.cache, e.cache_tier) for e in t.usage}
    # Real Sonnet 4.6 transcript should exercise the bare-input / output /
    # cache_read / cache_write_1h rows in the price table.
    assert ("input", "none", "none") in dims_seen, dims_seen
    assert ("output", "none", "none") in dims_seen, dims_seen
    assert ("input", "read", "none") in dims_seen, dims_seen
    assert ("input", "write", "1h") in dims_seen, dims_seen


def test_usage_in_span_filters_by_timestamp():
    """``usage_in_span`` returns only entries whose timestamp falls in [enter, done]."""
    t = AgentTranscriptFile("claude", _RESOURCES / "nav_run1.jsonl")
    usage = t.usage
    assert len(usage) >= 2
    # Pick a window from the middle of the usage timeline.
    sorted_by_ts = sorted([e for e in usage if e.timestamp], key=lambda e: e.timestamp)
    mid_idx = len(sorted_by_ts) // 2
    enter = sorted_by_ts[mid_idx - 1].timestamp
    done = sorted_by_ts[mid_idx].timestamp
    in_span = t.usage_in_span(enter, done)
    assert all(enter <= e.timestamp <= done for e in in_span)
    assert len(in_span) >= 2  # at least the two boundary entries


def test_cost_in_span_is_subset_of_total_cost():
    """Spanning the full transcript via ``cost_in_span`` matches ``cost()``."""
    t = AgentTranscriptFile("claude", _RESOURCES / "term_run2.jsonl")
    usage = [e for e in t.usage if e.timestamp]
    if not usage:
        pytest.skip("transcript has no timestamped usage entries")
    first_ts = min(e.timestamp for e in usage)
    last_ts = max(e.timestamp for e in usage)
    full = t.cost()
    span = t.cost_in_span(first_ts, last_ts)
    assert span == pytest.approx(full, abs=0.0001)


def test_pricing_table_for_unknown_model_falls_back_to_default():
    """Resolving an unknown model returns the Sonnet-4 default — keeps reports working."""
    from flow_sdk.transcript_analyzer.pricing import pricing_for

    table = pricing_for("claude-future-model-xyz")
    # Should be a real ModelPricing, not None.
    assert table is not None
    assert len(table.items) > 0


def test_legacy_input_output_rates_matches_published_sonnet_4():
    """The legacy shim returns ($/MTok) for callers that haven't migrated."""
    from flow_sdk.transcript_analyzer.pricing import legacy_input_output_rates

    in_rate, out_rate = legacy_input_output_rates("claude-sonnet-4-6")
    assert in_rate == pytest.approx(3.00)
    assert out_rate == pytest.approx(15.00)
