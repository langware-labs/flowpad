"""Drive the ten compute ops INSIDE the container and print one JSON line per case.

Runs in the container because that is the only place these goals mean anything:
a real empty package index, a real PATH that does not include ``~/.local/bin``, a
real port to bind. It uses the PURE runner over the op folders on disk — no
index, no entity, no HTTP — so a failure here is the block's, not the indexer's.
The agent rung still spawns a real worker through the backend running beside it.

    python3 tests/long_tests/compute_op_driver.py [name ...]

Each case prints ``{"case": …, "ok": …, "exit_code": …, "detail": …, "seconds": …}`` and the
script exits 0 whatever the verdicts say: the HOST test decides what "correct"
means per case, because for one of them the correct answer is failure.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, "/app")

from flow_sdk.core.compute_op import run_op  # noqa: E402
from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec  # noqa: E402

OPS = Path(__file__).resolve().parent / "compute_ops"


def load(name: str) -> ComputeOpSpec:
    folder = OPS / name
    body = json.loads((folder / "compute_op.json").read_text())
    body.pop("type", None)
    return ComputeOpSpec.model_validate({**body, "setup": (folder / "setup.md").read_text()})


def cold_apt_index() -> None:
    """Empty the package index, the way a freshly pulled image ships.

    Reproducing the machine, not faking the result: `ripgrep-on-path` is about a
    cheap rung that fails on an empty index, and an earlier case in the same
    container may have warmed it.
    """
    subprocess.run("rm -rf /var/lib/apt/lists/*", shell=True, check=False, capture_output=True)


def seed_origin() -> None:
    """A repository for ``repo-cloned`` to clone, plus what ``deps-installed`` installs.

    Seeded unconditionally before any case: ``repo-cloned`` is usually reached as
    a DEPENDENCY of ``deps-installed``, never by name, so keying this off the
    requested case left the clone with nothing to clone from.
    """
    work = Path("/work")
    work.mkdir(exist_ok=True)
    origin = work / "origin.git"
    if origin.is_dir():
        return
    seed = work / "_seed"
    seed.mkdir(exist_ok=True)
    (seed / "requirements.txt").write_text("tabulate\n")
    (seed / "README.md").write_text("The demo repo.\n")
    run = lambda *a: subprocess.run(a, cwd=seed, check=True, capture_output=True)
    run("git", "init", "--quiet", "--initial-branch", "main")
    run("git", "config", "user.email", "rig@local.test")
    run("git", "config", "user.name", "rig")
    run("git", "add", "-A")
    run("git", "commit", "--quiet", "-m", "seed")
    subprocess.run(["git", "clone", "--quiet", "--bare", str(seed), str(origin)], check=True, capture_output=True)


async def main(names: list[str]) -> None:
    seed_origin()
    for name in names:
        if name == "ripgrep-on-path":
            cold_apt_index()
        started = time.monotonic()
        try:
            verdict = await run_op(
                load(name), trusted=True, platform="linux",
                workdir=Path("/work"),
            )
            row = {"case": name, "ok": verdict.ok, "exit_code": int(verdict.exit_code),
                   "detail": verdict.detail, "pending": list(verdict.pending),
                   "value": verdict.value}
        except Exception as error:  # a raise is a result too — the host asserts on it
            row = {"case": name, "ok": False, "error": f"{type(error).__name__}: {error}"}
        row["seconds"] = round(time.monotonic() - started, 1)
        print("CASE " + json.dumps(row), flush=True)


async def wizard(names: list[str]) -> None:
    """Run the named ops as ONE wizard, and report what the sequence did.

    The point is composition: a step calls an op, the op's answer is the step's,
    a bound value reaches the next step, and the whole thing reports into one
    Activity tree rather than one per call.
    """
    from flow_sdk.activity import Activity
    from flow_sdk.core.wizard.runner import Resolved, run_wizard
    from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

    seed_origin()

    async def resolve_op(name: str):
        return Resolved(load(name), True) if (OPS / name).is_dir() else None

    spec = WizardSpec.model_validate({
        "name": "rig", "description": "the ops, sequenced",
        "steps": [
            {"id": name, "label": name, "kind": "compute", "ref": name, "on_fail": "continue"}
            for name in names
        ],
    })
    started = time.monotonic()
    address = "wizard/rig"
    result = await run_wizard(
        spec, subject_entity="rig", activity_path=address, trusted=True,
        workdir=Path("/work"), platform="linux", resolve_op=resolve_op,
    )
    tree = Activity.get(address, subject_entity="rig")
    node = tree.spec() if tree is not None else None
    print("WIZARD " + json.dumps({
        "status": result.status,
        "steps": [{"id": o.step_id, "status": o.status} for o in result.outcomes],
        # ONE tree: a child per step, under one root, with the counters summed.
        "children": [c.name for c in (node.children if node else [])],
        "total": getattr(node, "total", None),
        "seconds": round(time.monotonic() - started, 1),
    }), flush=True)


if __name__ == "__main__":
    argv = sys.argv[1:]
    if argv and argv[0] == "--wizard":
        asyncio.run(wizard(argv[1:]))
    else:
        asyncio.run(main(argv or sorted(p.name for p in OPS.iterdir() if p.is_dir())))


