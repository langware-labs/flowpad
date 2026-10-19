"""One-shot migration: a credential is a ``credential`` again, and resolved values are ``ResolvedSecrets``.

0.2.178 names the one concept once: the entity ``SecretPack`` (type ``secret_pack``, folder
``agentic-assets/secret_pack/<name>/secret_pack.json``) is ``Credential`` (type ``credential``,
``agentic-assets/credential/<name>/credential.json``), and the values a data source is handed,
``flow_sdk.sources.Credentials``, are ``ResolvedSecrets``. The shipped templates moved with the change; a
credential a person or an agent declared in a project or the home folder, and a data driver authored
against the old import, did not. This pass moves and rewrites them, per root the instance indexes:

* ``<root>/agentic-assets/secret_pack/<name>/`` → ``<root>/agentic-assets/credential/<name>/`` (its identity
  capsule travels with the folder), ``secret_pack.json`` → ``credential.json``. A ``credential/<name>`` already
  there is a CONFLICT: reported, nothing overwritten. An emptied ``secret_pack/`` is removed.
* a ``credential/<name>/credential.json`` this pass did not move (a leftover from before 0.2.170, when the
  folder had this name) that no longer parses as a ``CredentialSpec`` is reported — it would not load.
* an authored driver's ``source.py`` importing ``Credentials`` from ``flow_sdk.sources`` has the name rewritten.

The shipped tree is never touched. Idempotent: a moved folder is no longer under ``secret_pack/``, and a
rewritten driver imports ``ResolvedSecrets``.

Usage (dry-run is the default; ``--apply`` writes):

    uv run -m flow_sdk.migrations.migration_2026_09_credential_noun --dry-run
    uv run -m flow_sdk.migrations.migration_2026_09_credential_noun --apply
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger("migrate.credential_noun")

OLD_FAMILY, NEW_FAMILY = "secret_pack", "credential"
OLD_MAIN, NEW_MAIN = "secret_pack.json", "credential.json"
_IMPORT = re.compile(r"^\s*from flow_sdk\.sources(?:\.credentials)? import [^\n]*\bCredentials\b", re.M)


@dataclass
class Report:
    dry_run: bool = True
    moved: list[str] = field(default_factory=list)
    conflicts: list[str] = field(default_factory=list)
    unreadable: list[str] = field(default_factory=list)
    drivers_rewritten: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(self.moved or self.drivers_rewritten) and not self.dry_run

    def lines(self) -> list[str]:
        verb = "would move" if self.dry_run else "moved"
        out = [f"credentials: {verb} {len(self.moved)} folder(s) secret_pack/ → credential/: {', '.join(self.moved)}"
               if self.moved else "credentials: no secret_pack/ folder left to move."]
        if self.conflicts:
            out.append(f"credentials: CONFLICT, left as is (credential/<name> already exists): {', '.join(self.conflicts)}")
        if self.unreadable:
            out.append(f"credentials: will not load (not a current credential.json): {', '.join(self.unreadable)}")
        if self.drivers_rewritten:
            verb = "would rewrite" if self.dry_run else "rewrote"
            out.append(f"data drivers: {verb} Credentials → ResolvedSecrets in: {', '.join(self.drivers_rewritten)}")
        return out


def _assets(root: Path) -> Path:
    from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR

    return Path(root) / AGENTIC_ASSETS_DIR


def _move_folders(root: Path, report: Report) -> set[str]:
    """Move every ``secret_pack/<name>`` under ``root``; the names now under ``credential/`` this pass placed."""
    old, new = _assets(root) / OLD_FAMILY, _assets(root) / NEW_FAMILY
    placed: set[str] = set()
    if not old.is_dir():
        return placed
    for folder in sorted(p for p in old.iterdir() if p.is_dir() and (p / OLD_MAIN).is_file()):
        target = new / folder.name
        if target.exists():
            report.conflicts.append(str(folder))
            continue
        report.moved.append(str(folder))
        placed.add(folder.name)
        if report.dry_run:
            continue
        new.mkdir(parents=True, exist_ok=True)
        shutil.move(str(folder), str(target))
        (target / OLD_MAIN).rename(target / NEW_MAIN)
    if not report.dry_run and not any(old.iterdir()):
        old.rmdir()
    return placed


def _check_leftovers(root: Path, placed: set[str], report: Report) -> None:
    from flow_sdk.schema.data_spec.credential_spec import CredentialSpec

    new = _assets(root) / NEW_FAMILY
    if not new.is_dir():
        return
    for main in sorted(new.glob(f"*/{NEW_MAIN}")):
        if main.parent.name in placed:
            continue
        try:
            CredentialSpec.model_validate(json.loads(main.read_text(encoding="utf-8")))
        except Exception:  # noqa: BLE001 — any reason it will not load is the finding
            report.unreadable.append(str(main.parent))


def _rewrite_drivers(root: Path, shipped: Path, report: Report) -> None:
    from flow_sdk.migrations.migration_2026_09_source_families import driver_files

    for path in driver_files(root, shipped):
        text = path.read_text(encoding="utf-8")
        if not _IMPORT.search(text):
            continue
        report.drivers_rewritten.append(str(path))
        if not report.dry_run:
            path.write_text(re.sub(r"\bCredentials\b", "ResolvedSecrets", text), encoding="utf-8")


def migrate(*, dry_run: bool = True, roots: list[Path] | None = None) -> Report:
    """Move declared credentials to ``credential/`` and rewrite authored drivers, under ``roots`` (the instance's when None)."""
    from flow_sdk.ingest.driver_registry import SHIPPED_ROOT
    from flow_sdk.migrations._roots import instance_roots

    report = Report(dry_run=dry_run)
    shipped = SHIPPED_ROOT.resolve()
    shipped_assets = shipped.parent
    seen: set[str] = set()
    for root in roots if roots is not None else instance_roots():
        key = str(_assets(Path(root)).resolve())
        if key in seen or Path(key) == shipped_assets:
            continue
        seen.add(key)
        placed = _move_folders(Path(root), report)
        _check_leftovers(Path(root), placed, report)
        _rewrite_drivers(Path(root), shipped, report)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Move secret_pack/ folders to credential/; rewrite Credentials imports.")
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument("--dry-run", action="store_true", help="Report only (the default).")
    parser.add_argument("--root", action="append", default=None, help="Walk only this root (repeatable).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)
    report = migrate(dry_run=not args.apply, roots=[Path(r) for r in args.root] if args.root else None)
    logger.info("%s", "DRY-RUN" if report.dry_run else "APPLY")
    for line in report.lines():
        logger.info("%s", line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
