"""Boot lift: a deployment places a PROJECT, with one optional main agent.

Before, an agent's placement was parented by the agent (``parent_type_id = agent-<id>``) and its launch
overrides lived in agent.json ``places``. Now every agent/web placement is parented by its project and
names its agent in ``main_agent_id``; overrides live on the row (``main_agent_overrides``). This pass:

* **Agent rows.** ``parent_type_id`` → the agent's project (same id), ``main_agent_id`` → the old parent,
  ``identity`` kept, ``source_ref`` ← ``source_revision``, the agent.json ``places`` entry naming the row
  copied into ``main_agent_overrides``. An agent with no project is left as it is and reported.
* **One local deployment per project.** A project's per-agent local rows and its local web row merge into
  one: the (serving, else oldest) agent row is kept, the others' endpoints move onto it and they go.

Old rows are READ raw (the agent parent and agent.json ``places`` are only there); every write goes
through the entity API. Runs at boot once per instance (a stamp in the instance config).

    uv run -m flow_sdk.migrations.migration_2026_11_project_deployments --dry-run
    uv run -m flow_sdk.migrations.migration_2026_11_project_deployments --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from flow_sdk.migrations.migration_2026_09_this_computer_placement import _move_endpoints, _stored_deployments

logger = logging.getLogger("migrate.project_deployments")

DONE_KEY = "migration_2026_11_project_deployments"


@dataclass
class Report:
    dry_run: bool = True
    moved: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        verb = "would" if self.dry_run else "did"
        if not (self.moved or self.failed):
            return ["project deployments: nothing to lift."]
        out = [f"project deployments: {verb} lift {len(self.moved)} row(s)"]
        out += [f"project deployments:   {line}" for line in self.moved]
        if self.failed:
            out.append("project deployments: NOT lifted: " + ", ".join(self.failed))
        return out


def _place_overrides(agent: Any, deployment_id: str) -> dict[str, Any]:
    """The overrides agent.json ``places`` held for ``deployment_id`` (the file still carries the key;
    the model no longer reads it)."""
    from flow_sdk.builtin.agent_schedule import ScheduleError, agent_folder
    from flow_sdk.schema.data_spec.agent_spec import PLACE_OVERRIDABLE_FIELDS

    try:
        document = json.loads((Path(agent_folder(agent)) / "agent.json").read_text(encoding="utf-8"))
    except (ScheduleError, OSError, ValueError):
        return {}
    for place in document.get("places") or [] if isinstance(document, dict) else []:
        if isinstance(place, dict) and str(place.get("deployment_id") or "") == deployment_id:
            return {k: place[k] for k in PLACE_OVERRIDABLE_FIELDS if place.get(k) is not None}
    return {}


async def lift(*, dry_run: bool = True, force: bool = False) -> Report:
    from flow_sdk.builtin.agent import Agent
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.cli import app_config

    report = Report(dry_run=dry_run)
    if app_config.get_config(DONE_KEY) and not force:
        return report
    raw = await _stored_deployments()

    # 1. Agent rows → project rows, same id.
    lifted: list[dict[str, Any]] = []
    agents_by_parent: dict[str, Any] = {}  # an agent with several rows is read once
    for data in raw:
        parent = str(data.get("parent_type_id") or "")
        if not parent.startswith("agent-"):
            continue
        if parent not in agents_by_parent:
            agents_by_parent[parent] = await Agent.get_by_id(parent.removeprefix("agent-"))
        agent = agents_by_parent[parent]
        project_id = str(getattr(agent, "project_id", None) or data.get("project_id") or "")
        if not project_id:
            report.failed.append(f"{data['id']}: agent {parent} has no project")
            continue
        project = f"project-{project_id}"
        provider = str((data.get("target") or {}).get("provider") or "")
        report.moved.append(f"{data['id']} {parent} → {project} (main agent)")
        lifted.append({"id": data["id"], "project": project, "provider": provider, "created": data.get("created_date")})
        if dry_run:
            continue
        try:
            row = await Deployment.get_by_id(data["id"])
            row.parent_type_id = project
            row.project_id = project_id
            row.main_agent_id = parent
            row.identity = str(data.get("identity") or "agent")
            row.source_ref = row.source_ref or row.source_revision
            if agent is not None and not row.main_agent_overrides:
                row.main_agent_overrides = _place_overrides(agent, str(row.id))
            await row.save()
        except Exception as exc:  # noqa: BLE001 — never stops boot
            report.failed.append(f"{data['id']}: {type(exc).__name__}: {exc}")

    # 2. One local deployment per project: the agent rows and the web row merge.
    by_project: dict[str, list[dict[str, Any]]] = {}
    for entry in lifted:
        if entry["provider"] == "local":
            by_project.setdefault(entry["project"], []).append(entry)
    for data in raw:
        parent = str(data.get("parent_type_id") or "")
        if parent.startswith("project-") and (data.get("target") or {}).get("provider") == "local":
            by_project.setdefault(parent, []).append({"id": data["id"], "web": True, "serving": False})
    serving = {str(d["id"]) for d in raw if d.get("serving")}
    for project, members in by_project.items():
        agents = [m for m in members if not m.get("web")]
        if len(members) < 2 or not agents:
            continue
        agents.sort(key=lambda m: (str(m["id"]) not in serving, str(m.get("created") or "")))
        keep = agents[0]
        for other in (m for m in members if m is not keep):
            report.moved.append(f"{other['id']} → merged into local {keep['id']} of {project}")
            if dry_run:
                continue
            try:
                target = await Deployment.get_by_id(keep["id"])
                gone = await Deployment.get_by_id(other["id"])
                if target is None or gone is None:
                    continue
                await _move_endpoints(str(gone.typeid), target)
                if target.secrets is None and gone.secrets is not None:
                    target.secrets = gone.secrets
                    await target.save()
                gone.serving = False
                await gone.delete()
            except Exception as exc:  # noqa: BLE001
                report.failed.append(f"{other['id']}: {type(exc).__name__}")

    if not dry_run and not report.failed:
        app_config.set_config(DONE_KEY, True)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Re-parent agent deployments to their project.")
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument("--dry-run", action="store_true", help="Report only (the default).")
    parser.add_argument("--force", action="store_true", help="Run even if this instance already ran it.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)
    report = asyncio.run(lift(dry_run=not args.apply, force=args.force))
    logger.info("%s", "DRY-RUN" if report.dry_run else "APPLY")
    for line in report.lines():
        logger.info("%s", line)
    return 1 if report.failed else 0


if __name__ == "__main__":
    sys.exit(main())
