"""``python -m flow_sdk.evals <dataset folder> [--eval NAME] [--kinds eval,train] [--limit N]``"""

from __future__ import annotations

import argparse
import asyncio
from pathlib import Path

from flow_sdk.evals.runner import run


def main() -> None:
    ap = argparse.ArgumentParser(prog="python -m flow_sdk.evals")
    ap.add_argument("dataset", type=Path, help="the dataset folder (holds dataset.json)")
    ap.add_argument("--eval", dest="eval_name")
    ap.add_argument("--kinds", help="comma-separated example roles (default: the eval's own)")
    ap.add_argument("--limit", type=int)
    a = ap.parse_args()
    kinds = a.kinds.split(",") if a.kinds else None
    record, folder = asyncio.run(run(a.dataset, eval_name=a.eval_name, kinds=kinds, limit=a.limit))
    print(f"{record.dataset_title} · {record.eval_name}: {record.examples} examples {record.counts}")  # noqa: T201
    print("metrics:", record.metrics)  # noqa: T201
    print(f"report: {folder / 'report.html'}")  # noqa: T201


if __name__ == "__main__":
    main()
