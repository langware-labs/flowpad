"""One-shot backfill: declare the persona of processes written before the field.

``AgenticProcess.process_persona_path`` names the embedded sub-agent that IS
the process's identity. Before it existed the renderer *inferred* the identity
instead — it emitted the "you are this agent" directive when, and only when,
EXACTLY ONE sub-agent was embedded. Every process persisted under that rule
therefore carries no declaration, and on the next prompt its ``CLAUDE.md`` is
re-rendered by the new code as a flat ``# Embedded agent specs`` catalogue with
no identity at all.

That is a live regression for exactly one shape of row: a chat, wizard,
help-desk or automation process with a SINGLE embedded agent, which the old
rule promoted and the new one no longer knows about. Those sessions are
long-lived — a user reopens a vibe chat from weeks ago — and the frontend only
embeds at process CREATION (``EntityExecutionPanel``'s ``onProcessCreated``:
"Not called when an existing process is picked up"), so nothing re-declares it.

The rule here is the OLD rule, applied once and written down:

    a process with no declared persona and EXACTLY ONE materialized
    ``.claude/agents/*.md`` → that agent is the persona.

Deliberately nothing else. A row with two or more embedded agents got no
persona under the old rule either (that is the bug this migration's own PR
fixes), so promoting one now would invent an identity the process never had —
the same "hand it to whichever agent is there" mistake, just moved into a
migration. Those rows correctly stay persona-less.

Idempotent: only rows whose ``process_persona_path`` is unset are considered,
so a migrated instance reports zeros. Rows with no assets dir, no
``.claude/agents`` folder, or an empty one are skipped untouched.

Usage (dry-run is the default; ``--apply`` writes):

    uv run -m flow_sdk.migrations.migration_2026_09_process_persona_backfill
    uv run -m flow_sdk.migrations.migration_2026_09_process_persona_backfill --apply

NOT yet wired to a recipe, deliberately. A recipe must live under the next
UNRELEASED version directory or no install ever finds it
(``tests/unit/test_migration_recipes_ship_with_their_version.py``), and that
directory is opened by ``scripts/deploy_to_github.sh`` at bump time -- its
README says "do not hand-author it". The tree's only slot, ``0.2.163``, is the
RUNNING version and therefore already spent. So the release that ships this
should add the one-line recipe into the slot its own bump opens, the way
``0.2.156/scripts/migrate.py`` calls ``migration_2026_09_identity_live_forms``.
Until then this runs by hand, as ``migration_2026_09_owner_backfill`` and the
other recipe-less modules here do.
"""

from __future__ import annotations

import argparse
import asyncio
import logging
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class BackfillReport:
    """What the pass found, per process."""

    declared: dict[str, str] = field(default_factory=dict)
    """process id → the persona path it was given."""

    already_declared: int = 0
    """Rows that already carry a declaration — the idempotent no-op."""

    ambiguous: list[str] = field(default_factory=list)
    """Ids with 2+ embedded agents: no persona under the old rule, so none now."""

    no_agents: int = 0
    """Rows with no materialized `.claude/agents/*.md` — nothing to declare."""

    @property
    def changed(self) -> bool:
        return bool(self.declared)


async def migrate(dry_run: bool = True) -> BackfillReport:
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

    report = BackfillReport()
    for process in await AgenticProcess.get_all():
        if process.process_persona_path:
            report.already_declared += 1
            continue

        # `_process_assets_path` is a pure path derivation; read the directory
        # rather than `ensure_embedded_assets`, which would CREATE one for every
        # process a migration merely looked at.
        assets_dir = process._process_assets_path()  # noqa: SLF001 — migration reads the record layout
        if not assets_dir.is_dir():
            report.no_agents += 1
            continue

        agents_dir = assets_dir / ".claude" / "agents"
        found = sorted(agents_dir.glob("*.md")) if agents_dir.is_dir() else []
        if not found:
            report.no_agents += 1
            continue
        if len(found) > 1:
            report.ambiguous.append(str(process.id))
            continue

        rel = (Path(".claude") / "agents" / found[0].name).as_posix()
        report.declared[str(process.id)] = rel
        if not dry_run:
            process.process_persona_path = rel
            await process.save(notify=False)

    return report


async def _main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="write (default is a dry run)")
    args = parser.parse_args()

    report = await migrate(dry_run=not args.apply)
    verb = "would declare" if not args.apply else "declared"
    print(  # noqa: T201 — migration output is user-facing
        f"persona backfill: {verb} {len(report.declared)} process(es); "
        f"{report.already_declared} already declared, "
        f"{len(report.ambiguous)} left persona-less (2+ embedded agents), "
        f"{report.no_agents} with no embedded agent."
    )
    for pid, rel in sorted(report.declared.items()):
        print(f"  {pid} → {rel}")  # noqa: T201
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
