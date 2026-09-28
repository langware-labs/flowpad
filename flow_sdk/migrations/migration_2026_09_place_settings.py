"""Boot lift: a data source's per-machine settings move out of ``data_source.json`` into its credential.

A value that differs by where a source runs — where a container answers, how a provider reaches this
instance — is a credential variable the driver maps in its manifest's ``auth.vars``, resolved per
deployment; ``data_source.json`` travels with the repo and carries only what is true everywhere. A driver
that moves a config field into ``auth.vars`` (a per-machine URL, in 0.2.178) leaves rows
still holding the old key. For each such row this pass:

* declares the variables on the driver's credential as the row's project sees it (a declared credential
  gains only what it lacks; an undeclared one comes from its shipped template);
* writes the stored value where the row reads (the deployment that answers it, else this computer) —
  never over a value already stored there;
* strips the keys from ``data_source.json``.

Driven by the manifests (an ``auth.vars`` key the stored config still carries): no driver is named here.
Runs at boot once per instance (the rows live in the database; a stamp in the instance config): a row
cloned in later carries ANOTHER machine's value, which must not become this one's — that file's keys are
dead weight the driver's ``Config`` ignores. Names only are reported.

    uv run -m flow_sdk.migrations.migration_2026_09_place_settings --dry-run
    uv run -m flow_sdk.migrations.migration_2026_09_place_settings --apply
"""

from __future__ import annotations

import argparse
import asyncio
import logging
import sys
from dataclasses import dataclass, field

logger = logging.getLogger("migrate.place_settings")


@dataclass
class Report:
    dry_run: bool = True
    #: ``"<source name>: KEY → VAR"`` for every setting moved into the credential.
    moved: list[str] = field(default_factory=list)
    #: ``"<source name>: VAR"`` for a value this computer already held (the stored one is kept).
    kept: list[str] = field(default_factory=list)
    #: ``"<source name>: why"`` for a row that could not be lifted (it keeps its keys).
    failed: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        verb = "would move" if self.dry_run else "moved"
        if not (self.moved or self.kept or self.failed):
            return ["place settings: no data source carries a per-machine setting in its config."]
        out = [f"place settings: {verb} {len(self.moved)} setting(s) from data_source.json into credentials"]
        out += [f"place settings:   {line}" for line in self.moved]
        if self.kept:
            out.append("place settings: already stored here, kept: " + ", ".join(self.kept))
        if self.failed:
            out.append("place settings: NOT lifted (the row keeps its keys): " + ", ".join(self.failed))
        return out


#: This instance's config key recording that the lift ran: a row cloned in afterwards carries ANOTHER
#: machine's value, which must not become this one's.
DONE_KEY = "migration_2026_09_place_settings"


async def lift(*, dry_run: bool = True, force: bool = False) -> Report:
    from flow_sdk.builtin.credential_resolver import placement_for_source, resolve_project_secrets
    from flow_sdk.builtin.credential_service import declare_vars, set_credential_values
    from flow_sdk.builtin.data_source import DataSource
    from flow_sdk.cli import app_config
    from flow_sdk.ingest.credentials import owner_project
    from flow_sdk.ingest.driver_runtime import DRIVERS

    report = Report(dry_run=dry_run)
    if app_config.get_config(DONE_KEY) and not force:
        return report
    # Only drivers that map credential variables can have moved a config field into them.
    mapping = {provider: driver.manifest.auth for provider, driver in DRIVERS.items()
               if driver.manifest is not None and driver.manifest.auth is not None
               and driver.manifest.auth.credential and driver.manifest.auth.vars}
    rows = [row for provider in mapping for row in await DataSource.get_all({"provider": provider}) or []]
    for row in rows:
        auth = mapping[str(row.provider)]
        config = dict(row.config or {})
        carried = {key: str(config[key]).strip() for key in auth.vars if str(config.get(key) or "").strip()}
        if not carried:
            continue
        name = str(row.name or row.id)
        variables = {key: auth.vars[key] for key in carried}
        if dry_run:
            report.moved += [f"{name}: {key} → {var}" for key, var in variables.items()]
            continue
        try:
            project = await owner_project(row)
            credential = await declare_vars(auth.credential, list(variables.values()), project)
            # Where this row reads: the deployment that answers it, else this computer.
            placement = await placement_for_source(row)
            held = await resolve_project_secrets(project, only=variables.values(), placement=placement)
            new = {var: carried[key] for key, var in variables.items() if var not in held}
            if new:
                await set_credential_values(str(credential.typeid), new, placement.deployment_id or None)
            row.config = {k: v for k, v in config.items() if k not in carried}
            await row.save()
        except Exception as exc:  # noqa: BLE001 — one row's failure keeps its keys and never stops boot
            report.failed.append(f"{name}: {type(exc).__name__}")
            continue
        report.moved += [f"{name}: {key} → {var}" for key, var in variables.items() if var in new]
        report.kept += [f"{name}: {var}" for var in variables.values() if var in held]
    if not dry_run and not report.failed:
        app_config.set_config(DONE_KEY, True)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Move per-machine data source settings into credentials.")
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument("--dry-run", action="store_true", help="Report only (the default).")
    parser.add_argument("--force", action="store_true", help="Run even if this instance already ran it.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)
    report = asyncio.run(lift(dry_run=not args.apply, force=args.force))
    logger.info("%s", "DRY-RUN" if report.dry_run else "APPLY")
    for line in report.lines():
        logger.info("%s", line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
