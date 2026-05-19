"""CLI: ``python -m flow_sdk.transcript_analyzer.pricing.report <jsonl>``.

Loads a transcript via ``AgentTranscript`` (worker auto-inferred from path
hints), groups usage entries by (model, io, cache, cache_tier, reasoning,
tool) and prints a table with token counts + USD cost. Total at the bottom.
"""

from __future__ import annotations

import sys
from collections import defaultdict
from pathlib import Path

from ..transcript import AgentTranscript
from . import pricing_for


def _infer_worker(path: Path) -> str:
    """Best-effort worker inference from path. Default to "claude"."""
    s = str(path).lower()
    if "/codex/" in s or "rollout-" in path.name:
        return "codex"
    return "claude"


def report(jsonl: Path | str) -> str:
    path = Path(jsonl)
    worker = _infer_worker(path)
    t = AgentTranscript(worker, path)
    by_dim: dict[tuple, dict] = defaultdict(lambda: {"count": 0, "cost": 0.0})
    grand_total = 0.0
    for e in t.usage:
        key = (e.model, e.io, e.cache, e.cache_tier, e.reasoning, e.tool, e.unit)
        rate = pricing_for(e.model, worker)
        c = rate.cost_of(e)
        by_dim[key]["count"] += e.count
        by_dim[key]["cost"] += c
        grand_total += c

    lines: list[str] = []
    lines.append(f"# Transcript cost report — {path.name}")
    lines.append(f"# worker={worker} entries={len(t.entries)} usage_entries={len(t.usage)}")
    lines.append("")
    header = f"{'model':32s}  {'io':>6s}  {'cache':>5s}  {'tier':>4s}  {'tool':>14s}  {'count':>12s}  {'$':>9s}"
    lines.append(header)
    lines.append("-" * len(header))
    for key in sorted(by_dim):
        model, io, cache, tier, reasoning, tool, unit = key
        agg = by_dim[key]
        lines.append(
            f"{(model or '?'):32s}  {io:>6s}  {cache:>5s}  {tier:>4s}  "
            f"{(tool or '-'):>14s}  {agg['count']:>12,}  ${agg['cost']:>8.4f}"
        )
    lines.append("-" * len(header))
    lines.append(f"{'TOTAL':>87s}  ${grand_total:.4f}")
    return "\n".join(lines)


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: python -m flow_sdk.transcript_analyzer.pricing.report <jsonl>", file=sys.stderr)
        return 2
    print(report(argv[0]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
