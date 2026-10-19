"""Git-share matrix fixtures + the per-phase timing report.

Every case records its phase timings (seed / pack / unpack / install / assert,
ms). At session end the report is written to ``$GIT_SHARE_TIMING_REPORT`` (or
``<pytest tmp base>/git_share_timing.json``) and the slowest cases are printed.
A case over the 1s unit ceiling is reported as a FAILURE of the budget, never
fixed by raising a cap.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

import pytest

import flow_sdk.models.entities  # noqa: F401  (full registry: pack/unpack resolve real classes)
from tests.unit.git_share._world import FAMILIES, World

CASE_BUDGET_MS = 1000.0
_REPORT: list[dict] = []


@pytest.fixture(autouse=True)
def _isolated(tmp_records_root, tmp_path, monkeypatch):
    workspace = tmp_path / "receiver" / "workspace"
    monkeypatch.setattr("flow_sdk.config.agent_workspace_root", lambda: workspace)
    return tmp_records_root


@pytest.fixture
def make_world(tmp_path, request):
    worlds: list[World] = []

    def _make(family: str) -> World:
        w = World(root=tmp_path, family=FAMILIES[family])
        t0 = time.perf_counter()
        w.seed()
        w.timings["seed"] = (time.perf_counter() - t0) * 1000
        worlds.append(w)
        return w

    t_start = time.perf_counter()
    yield _make
    total = (time.perf_counter() - t_start) * 1000
    for w in worlds:
        _REPORT.append(
            {
                "case": request.node.nodeid.split("::", 1)[-1],
                "total_ms": round(total, 1),
                **{k: round(v, 1) for k, v in w.timings.items()},
            }
        )


def pytest_sessionfinish(session, exitstatus):
    if not _REPORT:
        return
    out = os.environ.get("GIT_SHARE_TIMING_REPORT")
    path = Path(out) if out else Path(session.config._tmp_path_factory.getbasetemp()) / "git_share_timing.json"
    rows = sorted(_REPORT, key=lambda r: -r["total_ms"])
    over = [r for r in rows if r["total_ms"] > CASE_BUDGET_MS]
    path.write_text(json.dumps({"budget_ms": CASE_BUDGET_MS, "over_budget": len(over), "cases": rows}, indent=2))
    tr = session.config.pluginmanager.get_plugin("terminalreporter")
    if tr is None:
        return
    tr.write_sep("-", f"git-share timing: {len(rows)} cases, {len(over)} over {CASE_BUDGET_MS:.0f}ms -> {path}")
    for r in rows[:8]:
        phases = " ".join(f"{k}={v}" for k, v in r.items() if k not in ("case", "total_ms"))
        tr.write_line(f"  {r['total_ms']:>7.1f}ms  {r['case']}  [{phases}]")
