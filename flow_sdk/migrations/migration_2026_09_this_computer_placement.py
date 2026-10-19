"""Boot lift: deployments lose ``kind`` and ``slot`` — this computer becomes the local node's placement.

Before 0.2.18x a Deployment stored WHAT it placed as a ``kind`` (``runtime.agent``, ``runtime.web``,
``compute.this_computer``…) and an agent could have several local deployments told apart by ``slot``.
Now what a placement places is its PARENT, and an agent has one deployment per provider and environment.
Stored rows still carry the old keys (the model ignores them); what this pass fixes is what those keys
MEANT:

* **This computer.** The ``compute.this_computer`` row had no parent; it is now the local ComputeNode's
  placement (parent = ``compute_node-<local id>``). The machine's project-less web placement had that
  same parent already — the two become ONE row: its endpoints move to the this-computer row (which keeps
  its credential binding), and the web row goes.
* **Slots.** An agent's extra local deployments (slot ``"2"``, ``"3"``, …) are deleted, their endpoints
  with them; the default one (no slot) stays. If only slotted ones exist, the oldest is kept.

Old rows are READ raw (the dropped keys are only there); every write goes through the entity API. Runs at
boot once per instance (a stamp in the instance config), before anything reads this computer.

    uv run -m flow_sdk.migrations.migration_2026_09_this_computer_placement --dry-run
    uv run -m flow_sdk.migrations.migration_2026_09_this_computer_placement --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("migrate.this_computer_placement")

DONE_KEY = "migration_2026_09_this_computer_placement"
THIS_COMPUTER = "compute.this_computer"


@dataclass
class Report:
    dry_run: bool = True
    moved: list[str] = field(default_factory=list)
    failed: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        verb = "would" if self.dry_run else "did"
        if not (self.moved or self.failed):
            return ["this computer placement: nothing to lift."]
        out = [f"this computer placement: {verb} lift {len(self.moved)} row(s)"]
        out += [f"this computer placement:   {line}" for line in self.moved]
        if self.failed:
            out.append("this computer placement: NOT lifted: " + ", ".join(self.failed))
        return out


async def _stored_deployments() -> list[dict[str, Any]]:
    """Every stored deployment's JSON as written — read through the app's own engine (the dropped
    ``kind``/``slot`` keys exist only there; the model ignores them)."""
    from sqlalchemy import text

    from flow_sdk.db.drivers.db_driver import get_db_driver

    driver = get_db_driver()
    if getattr(driver, "engine", None) is None:
        await driver.open()
    async with driver.engine.connect() as conn:
        result = await conn.execute(text("SELECT id, data FROM entities WHERE type = 'deployment'"))
        rows = result.fetchall()
    out = []
    for eid, blob in rows:
        try:
            data = json.loads(blob) if isinstance(blob, str) else (blob or {})
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(data, dict):
            out.append({"id": str(eid), **data})
    return out


async def _legacy_rows() -> list[dict[str, Any]]:
    """Every stored deployment's id, parent, created date and the dropped ``kind``/``slot`` keys."""
    return [
        {
            "id": data["id"],
            "kind": str(data.get("kind") or ""),
            "slot": str(data.get("slot") or ""),
            "parent": str(data.get("parent_type_id") or ""),
            "provider": str((data.get("target") or {}).get("provider") or ""),
            "environment": str(data.get("environment") or ""),
            "created": str(data.get("created_date") or ""),
        }
        for data in await _stored_deployments()
    ]


async def _move_endpoints(source_typeid: str, target) -> int:
    from flow_sdk.builtin.service_endpoint import ServiceEndpoint

    moved = 0
    for endpoint in await ServiceEndpoint.of_deployment(source_typeid):
        endpoint.parent_type_id = str(target.typeid)
        await endpoint.save()
        await target.attach_child(endpoint)
        moved += 1
    return moved


async def lift(*, dry_run: bool = True, force: bool = False) -> Report:
    from flow_sdk.builtin.deployment import Deployment, _local_node_typeid
    from flow_sdk.cli import app_config

    report = Report(dry_run=dry_run)
    if app_config.get_config(DONE_KEY) and not force:
        return report
    rows = await _legacy_rows()
    local = _local_node_typeid()

    # 1. This computer: parent it to the local node; fold the machine's web placement into it.
    legacy = sorted((r for r in rows if r["kind"] == THIS_COMPUTER), key=lambda r: r["created"])
    machine_web = [r for r in rows if r["parent"] == local and r["provider"] == "local" and r["kind"] != THIS_COMPUTER]
    if legacy:
        keep, *extra = legacy
        report.moved.append(f"this computer {keep['id']} → parent {local}")
        report.moved += [f"duplicate this-computer {r['id']} → folded" for r in extra]
        report.moved += [f"machine web placement {r['id']} → folded into this computer" for r in machine_web]
        if not dry_run:
            try:
                row = await Deployment.get_by_id(keep["id"])
                row.parent_type_id = local
                await row.save()
                for r in [*extra, *machine_web]:
                    other = await Deployment.get_by_id(r["id"])
                    if other is None:
                        continue
                    await _move_endpoints(str(other.typeid), row)
                    if row.secrets is None and other.secrets is not None:
                        row.secrets = other.secrets
                        await row.save()
                    await other.delete()
            except Exception as exc:  # noqa: BLE001 — never stops boot
                report.failed.append(f"this computer: {type(exc).__name__}: {exc}")

    # 2. Slots: one local deployment per agent (per provider and environment).
    groups: dict[tuple, list[dict]] = {}
    for r in rows:
        if r["parent"].startswith("agent-"):
            groups.setdefault((r["parent"], r["provider"], r["environment"]), []).append(r)
    for (parent, provider, _env), members in groups.items():
        if len(members) < 2:
            continue
        members.sort(key=lambda r: (r["slot"] != "", r["created"]))
        keep, *extra = members
        for r in extra:
            report.moved.append(f"{parent} {provider} slot {r['slot'] or '(default)'} {r['id']} → deleted (kept {keep['id']})")
            if dry_run:
                continue
            try:
                other = await Deployment.get_by_id(r["id"])
                if other is not None:
                    other.serving = False
                    await other.delete()
            except Exception as exc:  # noqa: BLE001
                report.failed.append(f"{r['id']}: {type(exc).__name__}")

    if not dry_run and not report.failed:
        app_config.set_config(DONE_KEY, True)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Make this computer the local node's placement; drop slots.")
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
