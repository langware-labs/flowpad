"""The generic eval runner: resolve a dataset's eval, run it on every example, record and report."""

from __future__ import annotations

import asyncio
import hashlib
import inspect
import json
import logging
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from flow_sdk.datasets.score import golds, matches
from flow_sdk.schema.data_spec.eval_spec import EvalRun, EvalSpec, ExampleEval, Verdict

logger = logging.getLogger(__name__)

EVAL_FILE = "eval.json"
RUNS_DIR = "evals"


class EvalError(RuntimeError):
    """The eval could not run at all (none found, unreadable, failed to import)."""


# ── finding an eval ──────────────────────────────────────────────────────────


def _evals_under(root: Path) -> list[tuple[Path, EvalSpec]]:
    out = []
    for doc in sorted((root / "agentic-assets" / "eval").glob(f"*/{EVAL_FILE}")):
        try:
            out.append((doc.parent, EvalSpec.model_validate_json(doc.read_text(encoding="utf-8"))))
        except ValueError as exc:
            raise EvalError(f"{doc} is invalid: {exc}") from exc
    return out


def find_evals(dataset_folder: Path, spec: str) -> list[tuple[Path, EvalSpec]]:
    """The evals for a dataset: its own nested ones, else the shipped ones declaring its spec."""
    from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415

    nested = [(f, e) for f, e in _evals_under(Path(dataset_folder)) if e.dataset_kind in (spec, "*")]
    if nested:
        return nested
    return [(f, e) for f, e in _evals_under(flowpad_assistant_project_root()) if e.dataset_kind == spec]


def _digest(folder: Path) -> str:
    """The eval's identity: its code (the module loader's own hash) plus its ``eval.json``."""
    from flow_sdk.ingest.driver_registry import content_hash  # noqa: PLC0415

    return hashlib.sha256((content_hash(folder) + (folder / EVAL_FILE).read_text()).encode()).hexdigest()[:12]


def _load(folder: Path, spec: EvalSpec, digest: str) -> Any:
    from flow_sdk.ingest.driver_registry import DriverLoadError, load_module  # noqa: PLC0415

    try:
        module = load_module(folder, Path(spec.entry).stem, digest=digest)
    except DriverLoadError as exc:
        raise EvalError(str(exc)) from exc
    if not callable(getattr(module, "evaluate_example", None)):
        raise EvalError(f"{folder / spec.entry} defines no evaluate_example(row)")
    return module


# ── judging ──────────────────────────────────────────────────────────────────


def verdict_of(prediction: Any, row: Any, *, abstained: bool = False) -> Verdict:
    """The standard judgement: abstained when the eval says so, else correct when the prediction
    matches any of the row's golds (``flow_sdk.datasets.score.matches``), else wrong."""
    if abstained:
        return Verdict.ABSTAINED
    return Verdict.CORRECT if any(matches(prediction, g) for g in golds(row)) else Verdict.WRONG


def _at(value: Any, path: str) -> str:
    for part in path.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    return "—" if value in (None, "") else str(value)


def _title(row: Any) -> str:
    inp = row.input.model_dump(mode="json") if hasattr(row.input, "model_dump") else row.input
    if isinstance(inp, dict):
        for key in ("utterance", "text", "question", "prompt", "title"):
            if isinstance(inp.get(key), str):
                return inp[key]
    return json.dumps(inp, default=str)[:120]


def _counts(results: list[ExampleEval]) -> dict[str, int]:
    return {v.value: sum(1 for r in results if r.verdict == v) for v in Verdict}


async def _maybe(value: Any) -> Any:
    return await value if inspect.isawaitable(value) else value


async def _metrics(module: Any, results: list[ExampleEval]) -> dict[str, Optional[float]]:
    judged = [r for r in results if r.verdict != Verdict.ERROR]
    out: dict[str, Optional[float]] = {
        "accuracy": round(sum(r.verdict == Verdict.CORRECT for r in judged) / len(judged), 4) if judged else None
    }
    if callable(getattr(module, "aggregate", None)):
        try:
            out.update(await _maybe(module.aggregate(results)))
        except Exception as exc:  # noqa: BLE001 -- an author's aggregate never sinks the run
            logger.warning("eval aggregate() failed on %d examples: %s", len(results), exc)
    return out


# ── the run ──────────────────────────────────────────────────────────────────


async def run(
    dataset: Any,
    *,
    eval_name: Optional[str] = None,
    kinds: Optional[list[str]] = None,
    limit: Optional[int] = None,
    concurrency: int = 4,
    out_dir: Optional[Path] = None,
) -> tuple[EvalRun, Path]:
    """Run ``dataset``'s eval over its examples; write ``evals/<run_id>/`` and return the run and
    its folder. ``dataset`` is a ``Dataset`` or a dataset folder; ``out_dir`` replaces the
    dataset's own ``evals/`` (a test, a read-only dataset)."""
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415
    from flow_sdk.evals.report import render  # noqa: PLC0415

    ds = Dataset.at(Path(dataset)) if isinstance(dataset, (str, Path)) else dataset
    folder = Path(ds.asset_ref)
    spec = ds.spec if isinstance(ds.spec, str) else ""
    found = find_evals(folder, spec)
    if eval_name:
        found = [(f, e) for f, e in found if e.name == eval_name]
    if not found:
        raise EvalError(f"no eval for {folder} (spec {spec!r}{', name ' + repr(eval_name) if eval_name else ''})")
    eval_folder, eval_spec = found[0]
    digest = _digest(eval_folder)
    module = _load(eval_folder, eval_spec, digest)

    roles = set(kinds or eval_spec.kinds)
    in_roles = [r for r in ds.read_rows() if r.kind.value in roles]
    # Only labelled examples can be judged; the rest are counted, not run.
    labelled = [r for r in in_roles if golds(r)]
    rows, unlabelled = labelled[: limit or None], len(in_roles) - len(labelled)
    started = datetime.now(timezone.utc)
    gate = asyncio.Semaphore(max(1, concurrency))

    async def one(row: Any) -> ExampleEval:
        async with gate:
            t0 = time.perf_counter()
            try:
                result = await _maybe(module.evaluate_example(row))
                if not isinstance(result, ExampleEval):
                    result = ExampleEval.model_validate(result)
            except Exception as exc:  # noqa: BLE001 -- one bad example is a verdict, not a crash
                result = ExampleEval(verdict=Verdict.ERROR, error=f"{type(exc).__name__}: {exc}")
            # Slice paths read the row (``data.group``) and the eval's own labels (``labels.feasible``).
            dumped = {**row.model_dump(mode="json"), "labels": result.labels} if eval_spec.slices else {}
            return result.model_copy(
                update={
                    "example_id": row.id,
                    "golds": [g.model_dump(mode="json") if hasattr(g, "model_dump") else g for g in golds(row)],
                    "latency_ms": round((time.perf_counter() - t0) * 1000, 1),
                    "slice": {p: _at(dumped, p) for p in eval_spec.slices},
                    "title": result.title or _title(row),
                }
            )

    # ``versions()`` may ask the hub (which endpoint) -- fetch it while the examples run.
    versions_task = asyncio.ensure_future(
        _maybe(module.versions()) if callable(getattr(module, "versions", None)) else _maybe({})
    )
    results = await asyncio.gather(*(one(r) for r in rows))
    slices: dict[str, Any] = {}
    for path in eval_spec.slices:
        groups: dict[str, list[ExampleEval]] = defaultdict(list)
        for r in results:
            groups[r.slice[path]].append(r)
        slices[path] = {
            value: {"examples": len(part), **_counts(part), **(await _metrics(module, part))}
            for value, part in sorted(groups.items())
        }
    versions = await versions_task
    run_id = f"{started.strftime('%Y-%m-%dT%H-%M-%S')}-{eval_spec.name}"
    record = EvalRun(
        run_id=run_id,
        dataset_id=str(ds.id or ""),
        dataset_title=str(getattr(ds, "title", "") or folder.name),
        dataset_spec=spec,
        eval_name=eval_spec.name,
        eval_digest=digest,
        versions={k: str(v) for k, v in (versions or {}).items()},
        started_at=started.isoformat(timespec="seconds"),
        finished_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
        examples=len(results),
        counts={**_counts(results), "unlabelled": unlabelled},
        metrics=await _metrics(module, results),
        slices=slices,
    )
    out = (Path(out_dir) if out_dir else folder / RUNS_DIR) / run_id
    out.mkdir(parents=True, exist_ok=True)
    (out / "run.json").write_text(record.model_dump_json(indent=2) + "\n")
    (out / "examples.jsonl").write_text("".join(r.model_dump_json() + "\n" for r in results))
    (out / "report.html").write_text(render(record, results, eval_spec))
    ignore = folder / ".gitignore"
    if not out_dir and f"{RUNS_DIR}/" not in (ignore.read_text() if ignore.exists() else ""):
        with ignore.open("a") as fh:
            fh.write(f"{RUNS_DIR}/\n")
    return record, out


__all__ = ["EvalError", "find_evals", "run", "verdict_of"]
