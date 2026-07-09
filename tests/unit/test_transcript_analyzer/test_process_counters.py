"""Exact-integer folding of ``ProcessCounters`` across every worker.

These are the laser-accurate anchor: each assertion is a hardcoded integer
computed from a checked-in fixture, so a drift in the reducer or any parser's
usage emission fails loudly. Live parity (streamed report == transcript
re-parse) lives in ``tests/long_tests/test_process_status_report_stream.py``.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.transcript_analyzer.counters import ProcessCounters
from flow_sdk.transcript_analyzer.transcript import AgentTranscriptFile


def test_claude_tokens_and_counts_exact(claude_multi_block_jsonl: Path) -> None:
    # 3 distinct message.id snapshots after keep-last dedup (6 usage lines →
    # 3 survivors). Claude's four token dims are disjoint, so per-bucket sums
    # are exact with no overlap.
    c = ProcessCounters.from_transcript(AgentTranscriptFile("claude", claude_multi_block_jsonl))
    assert c.input_tokens == 8
    assert c.output_tokens == 4331
    assert c.cache_read_tokens == 215526
    assert c.cache_write_tokens == 3941
    assert c.total_tokens == 8 + 4331 + 215526 + 3941
    assert c.assistant_messages == 3
    assert c.tool_calls == 1


def test_claude_exit_plan_mode_message_and_tool_counts_exact(claude_jsonl: Path) -> None:
    # ExitPlanMode is a ToolUseEntry subclass → counted in tool_calls, never
    # double-counted alongside a catch-all TOOL_USE for the same block.
    c = ProcessCounters.from_transcript(AgentTranscriptFile("claude", claude_jsonl))
    assert c.input_tokens == 6
    assert c.output_tokens == 264
    assert c.cache_read_tokens == 38790
    assert c.cache_write_tokens == 24708
    assert c.assistant_messages == 1
    assert c.tool_calls == 2


def test_codex_bills_cumulative_increments_exact(tmp_path: Path) -> None:
    # Codex input INCLUDES cached; billing follows the cumulative-counter
    # increment (t2 total − t1 total), not the per-turn block. Uncached input
    # = total_input − cached; reasoning is never billed separately.
    import json

    def token_count(ts, *, in_t, cached, out_t, tot_in, tot_cached, tot_out):
        return {
            "timestamp": ts, "type": "event_msg",
            "payload": {"type": "token_count", "info": {
                "last_token_usage": {
                    "input_tokens": in_t, "cached_input_tokens": cached,
                    "output_tokens": out_t, "reasoning_output_tokens": out_t // 2,
                },
                "total_token_usage": {
                    "input_tokens": tot_in, "cached_input_tokens": tot_cached,
                    "output_tokens": tot_out,
                },
            }},
        }

    lines = [
        {"timestamp": "t0", "type": "session_meta", "payload": {"id": "s1"}},
        token_count("t1", in_t=1000, cached=800, out_t=50, tot_in=1000, tot_cached=800, tot_out=50),
        token_count("t2", in_t=2000, cached=1900, out_t=70, tot_in=3000, tot_cached=2700, tot_out=120),
    ]
    path = tmp_path / "rollout.jsonl"
    path.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")

    c = ProcessCounters.from_transcript(AgentTranscriptFile("codex", path))
    assert c.input_tokens == 300      # 3000 total − 2700 cached
    assert c.cache_read_tokens == 2700
    assert c.output_tokens == 120
    assert c.cache_write_tokens == 0  # codex has no cache-write dim


def test_copilot_output_only_exact(copilot_stream_jsonl: Path, copilot_tool_failure_jsonl: Path) -> None:
    # Copilot transcripts carry only ``outputTokens`` per assistant message;
    # input/cache/reasoning are absent, so they must fold to exactly 0.
    c1 = ProcessCounters.from_transcript(AgentTranscriptFile("copilot", copilot_stream_jsonl))
    assert c1.output_tokens == 89
    assert (c1.input_tokens, c1.cache_read_tokens, c1.cache_write_tokens) == (0, 0, 0)

    c2 = ProcessCounters.from_transcript(AgentTranscriptFile("copilot", copilot_tool_failure_jsonl))
    assert c2.output_tokens == 179   # 143 + 36 across two assistant messages
