"""One-shot migration: an authored data driver's class extends its source FAMILY.

A driver's ``Source`` class now extends ``ObjectSource`` (files), ``RecordSource`` (records) or
``MessageSource`` (messages), and ``load_driver`` refuses a class that extends ``Source`` or
``CollectionSource`` alone, or still sets the retired ``reflects`` flag. The shipped drivers were
rewritten with the change; a driver a person or an agent authored in a project was not, and would stop
loading on upgrade. This pass rewrites it.

Per ``<root>/agentic-assets/data_driver/<name>/source.py`` (every root the instance indexes — home, cwd,
the system project, every project mount), for the ONE class extending ``Source`` / ``CollectionSource``
with no family yet:

* ``reflects = True`` in its body → ``ObjectSource`` (the line is removed);
* it defines ``send`` and ``reply``, or extends ``EmailAddressing`` → ``MessageSource``;
* anything else → ``RecordSource``.

``Source`` in the base list is replaced by the family; ``CollectionSource`` keeps its place with the family
put first. One import is added. The result must compile before it is written, and a file this pass cannot
read safely (no class, two, a syntax error) is reported and left. Idempotent: a converted file has a family.

Usage (dry-run is the default; ``--apply`` writes):

    uv run -m flow_sdk.migrations.migration_2026_09_source_families --dry-run
    uv run -m flow_sdk.migrations.migration_2026_09_source_families --apply
"""

from __future__ import annotations

import argparse
import ast
import logging
import re
import sys
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger("migrate.source_families")

FAMILIES = ("ObjectSource", "RecordSource", "MessageSource")
_BARE = ("Source", "CollectionSource")
_MESSAGE_MIXINS = ("EmailAddressing", "VoiceChannel")


@dataclass
class Report:
    scanned: int = 0
    dry_run: bool = True
    #: family -> drivers converted (in a dry run: what ``--apply`` would convert)
    converted: Counter = field(default_factory=Counter)
    #: "reason" -> driver paths left as they are
    unconverted: dict[str, list[str]] = field(default_factory=dict)

    @property
    def changed(self) -> bool:
        return bool(self.converted) and not self.dry_run


def _name(node: ast.expr) -> str:
    return node.attr if isinstance(node, ast.Attribute) else node.id if isinstance(node, ast.Name) else ""


def family_for(cls: ast.ClassDef) -> str:
    """The family this class's body says it is."""
    for stmt in cls.body:
        if isinstance(stmt, (ast.Assign, ast.AnnAssign)):
            targets = stmt.targets if isinstance(stmt, ast.Assign) else [stmt.target]
            if any(_name(t) == "reflects" for t in targets) and isinstance(stmt.value, ast.Constant) and stmt.value.value is True:
                return "ObjectSource"
    methods = {s.name for s in cls.body if isinstance(s, (ast.FunctionDef, ast.AsyncFunctionDef))}
    if {"send", "reply"} <= methods or any(_name(b) in _MESSAGE_MIXINS for b in cls.bases):
        return "MessageSource"
    return "RecordSource"


def convert_text(text: str) -> tuple[str, str]:
    """``(new text, family)`` — or ``(text, "")`` when the file already declares a family.

    Raises ``ValueError`` naming why a file cannot be converted safely."""
    tree = ast.parse(text)
    bare = [
        node for node in tree.body
        if isinstance(node, ast.ClassDef) and any(_name(b) in _BARE for b in node.bases)
        and not any(_name(b) in FAMILIES for b in node.bases)
    ]
    if not bare:
        return text, ""
    if len(bare) != 1:
        raise ValueError(f"{len(bare)} classes extend Source without a family")
    cls = bare[0]
    family = family_for(cls)
    lines = text.splitlines(keepends=True)

    # The class line: `Source` becomes the family; `CollectionSource` keeps its place behind it.
    header = lines[cls.lineno - 1]
    match = re.match(r"^(\s*class\s+\w+\s*\()([^)]*)(\).*)$", header, re.S)
    if match is None:
        raise ValueError("the class statement spans lines")
    bases = [b.strip() for b in match.group(2).split(",") if b.strip()]
    if "Source" in bases:
        bases[bases.index("Source")] = family
    else:
        bases.insert(0, family)
    lines[cls.lineno - 1] = f"{match.group(1)}{', '.join(bases)}{match.group(3)}"

    # The retired flag goes: the family says it now.
    for stmt in cls.body:
        if isinstance(stmt, ast.Assign) and any(_name(t) == "reflects" for t in stmt.targets):
            for n in range(stmt.lineno - 1, stmt.end_lineno):
                lines[n] = ""

    # One import, after the last `from flow_sdk.sources…` import (else after the last import at the top).
    imports = [n for n in tree.body if isinstance(n, (ast.Import, ast.ImportFrom))]
    anchor = max((n for n in imports if isinstance(n, ast.ImportFrom) and (n.module or "").startswith("flow_sdk.sources")),
                  key=lambda n: n.end_lineno, default=None) or (imports[-1] if imports else None)
    at = anchor.end_lineno if anchor is not None else 0
    lines.insert(at, f"from flow_sdk.sources.families import {family}\n")

    new = "".join(lines)
    compile(new, "source.py", "exec")
    return new, family


def driver_files(root: Path) -> list[Path]:
    """Every authored driver's ``source.py`` directly under ``root``'s asset folder (never the shipped tree)."""
    from flow_sdk.ingest.driver_registry import SHIPPED_ROOT

    base = Path(root) / "agentic-assets" / "data_driver"
    if not base.is_dir() or base.resolve() == SHIPPED_ROOT.resolve():
        return []
    return sorted(p for p in base.glob("*/source.py") if p.is_file())


def migrate(*, dry_run: bool = True, roots: list[Path] | None = None) -> Report:
    """Give every authored driver under ``roots`` (the instance's when None) its family."""
    from flow_sdk.migrations.migration_2026_09_entity_json_mains import _default_roots

    report = Report(dry_run=dry_run)
    seen: set[str] = set()
    for root in roots if roots is not None else _default_roots():
        for path in driver_files(Path(root)):
            key = str(path.resolve())
            if key in seen:
                continue
            seen.add(key)
            report.scanned += 1
            try:
                text = path.read_text(encoding="utf-8")
                new, family = convert_text(text)
            except (OSError, SyntaxError, ValueError) as exc:
                report.unconverted.setdefault(f"{type(exc).__name__}: {exc}", []).append(key)
                continue
            if not family:
                continue
            report.converted[family] += 1
            if not dry_run:
                path.write_text(new, encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Give authored data drivers their source family.")
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    parser.add_argument("--dry-run", action="store_true", help="Report only (the default).")
    parser.add_argument("--root", action="append", default=None, help="Walk only this root (repeatable).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)
    report = migrate(dry_run=not args.apply, roots=[Path(r) for r in args.root] if args.root else None)
    logger.info("%s: scanned %d authored driver(s); %s: %s", "DRY-RUN" if report.dry_run else "APPLY", report.scanned,
                "convertible" if report.dry_run else "converted", dict(report.converted))
    for reason, paths in report.unconverted.items():
        logger.info("left as is (%s): %s", reason, paths)
    return 0


if __name__ == "__main__":
    sys.exit(main())
