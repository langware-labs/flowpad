"""``python -m flow_sdk.evals <dataset>[:kinds] [<dataset>[:kinds] ...] [--eval NAME] [--limit N] [--compare-last] [--quiet-examples]``

Each dataset (``:eval``, ``:test`` or ``:eval,test`` picks the example roles) is run and gets one
scoreboard row. ``--compare-last`` pairs each run with the last one over the same roles and lists what
it fixed and broke; ``scoreboard.md`` is written next to each run.
"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from flow_sdk.evals.runner import run


def _target(arg: str) -> tuple[Path, list[str] | None]:
    """``<folder>[:kinds]`` -- a ``:`` inside the folder's own path is not a kinds suffix."""
    path, sep, kinds = arg.rpartition(":")
    if not sep or "/" in kinds:
        path, kinds = arg, ""
    return Path(path).expanduser(), (kinds.split(",") if kinds else None)


def _cell(value) -> str:
    if value is None:
        return "—"
    return str(value) if isinstance(value, int) and not isinstance(value, bool) else f"{value:.3f}"


def _delta(value) -> str:
    return "" if not value else f" ({'+' if value > 0 else ''}{value:.3f})"


def _header(columns: list[str]) -> str:
    return "| set | n | errors | " + " | ".join(columns) + " |\n|" + "---|" * (len(columns) + 3)


async def _one(folder: Path, kinds, args) -> tuple[list[str], str, str]:
    """``(the eval's metric names, its scoreboard row, the run's details)``."""
    from flow_sdk.evals.compare import compare, previous  # noqa: PLC0415
    from flow_sdk.evals.store import load  # noqa: PLC0415

    record, out = await run(folder, eval_name=args.eval_name, kinds=kinds, limit=args.limit)
    columns = list(record.metrics)  # the eval's own metrics, in the order it reports them
    before = previous(folder, record) if args.compare_last else None
    diff = compare(load(folder, before.run_id), load(folder, record.run_id)) if before else None
    cells = [f"{_cell(record.metrics.get(c))}{_delta(diff.deltas.get(c)) if diff else ''}" for c in columns]
    row = f"| {record.dataset_title} [{','.join(record.kinds)}] | {record.examples} | {record.counts.get('error', 0)} | " + " | ".join(cells) + " |"
    detail = [f"run {record.run_id} · {' · '.join(f'{k} {v}' for k, v in record.versions.items())}"]
    if diff:
        unjudged = f", {diff.unjudged} not judged: an error on one side" if diff.unjudged else ""
        detail.append(f"vs {before.run_id}: {len(diff.fixed)} fixed, {len(diff.broken)} broken, {diff.still_wrong} still wrong ({diff.paired} paired{unjudged})")
        # A held-out set is scored, never read row by row: counts only.
        if not args.quiet_examples and "test" not in record.kinds:
            detail += [f"  + {e.title}" for e in diff.fixed] + [f"  - {e.title}" for e in diff.broken]
    (out / "scoreboard.md").write_text(f"{_header(columns)}\n{row}\n\n" + "\n".join(detail) + "\n")
    return columns, row, "\n".join(detail)


async def _all(args) -> list[tuple[list[str], str, str]]:
    out = []
    for arg in args.datasets:
        folder, kinds = _target(arg)
        out.append(await _one(folder, kinds or (args.kinds.split(",") if args.kinds else None), args))
    return out


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m flow_sdk.evals")
    ap.add_argument("datasets", nargs="+", help="dataset folders, each optionally :kinds (e.g. medium:test)")
    ap.add_argument("--eval", dest="eval_name")
    ap.add_argument("--kinds", help="example roles for every dataset without its own :kinds")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--compare-last", action="store_true", help="pair each run with the last one over the same roles")
    ap.add_argument("--quiet-examples", action="store_true", help="counts only, no fixed/broken titles (always so for kinds that include test)")
    results = asyncio.run(_all(ap.parse_args()))
    print(_header(results[0][0]))  # noqa: T201
    print("\n".join(row for _, row, _ in results))  # noqa: T201
    print("\n" + "\n\n".join(detail for _, _, detail in results))  # noqa: T201


if __name__ == "__main__":
    main()
