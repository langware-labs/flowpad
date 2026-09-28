"""Boot lift: a credential's guide leaves ``credential.json`` for ``setup.md`` beside it.

``CredentialSpec.setup`` became the file ``setup.md`` — markdown a person follows in the setup dialog and on
the credential page, and an agent follows too. The shipped templates moved in the same change; an
authored credential (user or project scope) still carries ``"setup"`` inline. The reader accepts that form,
and the next in-app save writes the file anyway — this pass makes every file converge without a save:

* ``setup.md`` written from the inline value (never over a ``setup.md`` already there);
* ``"setup"`` removed from ``credential.json``, the rest of the document untouched.

Runs at boot once per instance (a stamp in the instance config); a row that cannot be moved keeps its file.
Names only are reported.

    uv run -m flow_sdk.migrations.migration_2026_09_credential_setup_md --dry-run
    uv run -m flow_sdk.migrations.migration_2026_09_credential_setup_md --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

DONE_KEY = "migration_2026_09_credential_setup_md"
MAIN, GUIDE = "credential.json", "setup.md"


@dataclass
class Report:
    dry_run: bool = True
    #: The credentials whose guide moved into ``setup.md``.
    moved: list[str] = field(default_factory=list)
    #: ``"<name>: why"`` for one that could not be moved (it keeps its file).
    failed: list[str] = field(default_factory=list)

    def lines(self) -> list[str]:
        verb = "would move" if self.dry_run else "moved"
        return [f"credential guide {verb}: {name} → {GUIDE}" for name in self.moved] + [
            f"credential guide NOT moved: {line}" for line in self.failed
        ]


def move_one(folder: Path, *, dry_run: bool) -> bool:
    """Move ``folder``'s inline guide into ``setup.md``. True when there was one to move."""
    from flow_sdk.instances.atomic import write_json_atomic  # noqa: PLC0415
    from flow_sdk.assets.frontmatter import _atomic_write_text  # noqa: PLC0415

    main = folder / MAIN
    document = json.loads(main.read_text(encoding="utf-8"))
    inline = document.get("setup")
    if not isinstance(inline, str):
        return False
    if dry_run:
        return True
    guide = folder / GUIDE
    if not guide.is_file() and inline.strip():
        _atomic_write_text(guide, inline.strip() + "\n")
    document.pop("setup")
    write_json_atomic(main, document)
    return True


async def lift(*, dry_run: bool = True, force: bool = False) -> Report:
    from flow_sdk.builtin.credential import Credential  # noqa: PLC0415
    from flow_sdk.cli import app_config  # noqa: PLC0415
    from flow_sdk.schema.data_spec.credential_contract import SCOPE_SYSTEM  # noqa: PLC0415

    report = Report(dry_run=dry_run)
    if app_config.get_config(DONE_KEY) and not force:
        return report
    for row in await Credential.get_all({}) or []:
        if row.scope == SCOPE_SYSTEM or not row.asset_ref:
            continue  # the shipped templates moved with the change; a row with no folder has no file
        folder = Path(row.asset_ref)
        try:
            if (folder / MAIN).is_file() and move_one(folder, dry_run=dry_run):
                report.moved.append(str(row.name))
        except Exception as exc:  # noqa: BLE001 — one credential's failure keeps its file and never stops boot
            report.failed.append(f"{row.name}: {type(exc).__name__}")
    if not dry_run and not report.failed:
        app_config.set_config(DONE_KEY, True)
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Move each credential's inline guide into setup.md.")
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
