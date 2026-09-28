"""Boot lift: where a credential's values live moves off the credential and onto deployments.

Before 0.2.178 a ``credential.json`` said where its values live: ``value_store`` (``env`` / ``vault``) and
per-environment ``environments[E]: {value_store, required}``. That is a Deployment's now
(``DeploymentSecretsSpec``). ``CredentialSpec`` drops the two keys on read, so an un-lifted file still
loads; this pass moves them — the same store for the same variable, so every stored value keeps resolving:

* ``value_store: vault`` → this computer keeps each of the credential's variables in the vault (an
  exception on its binding). An ``lm_provider`` credential is skipped: its entry is fixed.
* ``environments[E].value_store`` → every deployment whose ``environment`` is ``E`` keeps those
  variables there; ``environments[E].required`` → that deployment requires them. A deployment that
  inherited this computer's binding gets a copy first. An ``E`` no deployment names is reported — the
  values stay where they are, and resolve again once a deployment names ``E`` and is given the store.
* the two keys are stripped from the file.

Two credentials putting one variable in different stores is reported; the first wins. Runs at boot
(it needs the deployments, which live in the database); idempotent — a stripped file is not read again.

    uv run -m flow_sdk.migrations.migration_2026_09_credential_stores --dry-run
    uv run -m flow_sdk.migrations.migration_2026_09_credential_stores --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from flow_sdk.builtin.deployment import Deployment

logger = logging.getLogger("migrate.credential_stores")


@dataclass
class Report:
    dry_run: bool = True
    #: ``"<deployment name>: VAR → store"`` for every variable given a store.
    lifted: list[str] = field(default_factory=list)
    #: files the keys were stripped from
    stripped: list[str] = field(default_factory=list)
    #: environments a credential overrides that no deployment names
    orphans: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.stripped) and not self.dry_run

    def lines(self) -> list[str]:
        verb = "would move" if self.dry_run else "moved"
        out = [f"credentials: {verb} where values live onto deployments for {len(self.stripped)} file(s)"
               if self.stripped else "credentials: no credential says where its values live."]
        out += [f"credentials:   {line}" for line in self.lifted]
        if self.orphans:
            out.append("credentials: no deployment is in these environments; their values stay put: "
                       + ", ".join(self.orphans))
        if self.conflicts:
            out.append(f"credentials: CONFLICT, first store kept: {', '.join(self.conflicts)}")
        return out


@dataclass
class _Plan:
    """What one deployment's binding gets: ``{VAR: store}`` and extra required variables."""

    row: "Deployment"
    wanted: dict = field(default_factory=dict)
    required: set = field(default_factory=set)


def credential_files(roots: list[Path]) -> list[Path]:
    """Every declared ``credential.json`` under ``roots`` — never the shipped tree (its templates carry no store)."""
    from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR
    from flow_sdk.ingest.driver_registry import SHIPPED_ROOT

    shipped = SHIPPED_ROOT.resolve().parent
    seen: dict[str, Path] = {}
    for root in roots:
        base = Path(root) / AGENTIC_ASSETS_DIR
        if base.resolve() == shipped:
            continue
        for path in sorted((base / "credential").glob("*/credential.json")):
            seen.setdefault(str(path.resolve()), path)
    return list(seen.values())


async def lift(*, dry_run: bool = True, roots: list[Path] | None = None) -> Report:
    from flow_sdk.builtin.deployment import Deployment
    from flow_sdk.capsules.atomic import atomic_write
    from flow_sdk.migrations._roots import instance_roots
    from flow_sdk.schema.data_spec.credential_spec import LEGACY_STORE_KEYS
    from flow_sdk.schema.data_spec.deployment_secrets_spec import STORE_WORDS

    report = Report(dry_run=dry_run)
    here = await Deployment.this_computer(save=not dry_run)
    by_environment: dict[str, list[Deployment]] = {}
    for row in await Deployment.others():
        by_environment.setdefault(row.environment, []).append(row)
    plans: dict[str, _Plan] = {}
    placed: dict[tuple[str, str], str] = {}

    def plan_for(row: Deployment) -> "_Plan":
        return plans.setdefault(str(row.id), _Plan(row))

    def keep(row: Deployment, names: list[str], store_word: str) -> None:
        ref = STORE_WORDS.get(store_word)
        if ref is None:
            return
        wanted = plan_for(row).wanted
        for name in names:
            before = placed.setdefault((str(row.id), name), ref.type)
            if before != ref.type:
                report.conflicts.append(f"{row.name}: {name} ({before} vs {ref.type})")
                continue
            wanted[name] = ref

    for path in credential_files(roots if roots is not None else instance_roots()):
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(raw, dict) or not any(key in raw for key in LEGACY_STORE_KEYS):
            continue
        names = list(raw.get("vars") or {})
        if not raw.get("lm_provider"):
            keep(here, names, str(raw.get("value_store") or "env"))
            for environment, override in (raw.get("environments") or {}).items():
                override = override or {}
                rows = by_environment.get(environment, [])
                if not rows:
                    report.orphans.append(f"{environment} ({path.parent.name})")
                for row in rows:
                    if override.get("value_store"):
                        keep(row, names, str(override["value_store"]))
                    if override.get("required") is not None:
                        plan_for(row).required.update(override["required"])
        report.stripped.append(str(path))
        if not dry_run:
            stripped = {k: v for k, v in raw.items() if k not in LEGACY_STORE_KEYS}
            atomic_write(path, (json.dumps(stripped, indent=2, ensure_ascii=False) + "\n").encode("utf-8"),
                         new_mode=path.stat().st_mode & 0o777)

    # This computer first: a deployment that copies its binding copies the lifted one.
    for plan in sorted(plans.values(), key=lambda plan: not plan.row.is_this_computer):
        row, wanted, required = plan.row, plan.wanted, plan.required
        binding = await row.secrets_binding()
        for name, ref in wanted.items():
            if binding.store_of(name).key != ref.key:
                binding = binding.with_store([name], ref)
                report.lifted.append(f"{row.name}: {name} → {ref.type}")
        if required - set(binding.require):
            binding = binding.model_copy(update={"require": sorted(set(binding.require) | required)})
            report.lifted.append(f"{row.name}: requires {', '.join(sorted(required))}")
        if not dry_run and binding != row.secrets:
            row.secrets = binding
            await row.save()
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Move where credential values live onto deployments.")
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument("--dry-run", action="store_true", help="Report only (the default).")
    parser.add_argument("--root", action="append", default=None, help="Walk only this root (repeatable).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)
    report = asyncio.run(lift(dry_run=not args.apply, roots=[Path(r) for r in args.root] if args.root else None))
    logger.info("%s", "DRY-RUN" if report.dry_run else "APPLY")
    for line in report.lines():
        logger.info("%s", line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
