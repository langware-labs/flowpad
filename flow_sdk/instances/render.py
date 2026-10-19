"""Rendering for ``status``/``list``.

Three formats from one report, so a human, an agent and a script can never be
told different things about the same machine.

The glyph split is the point of the whole exercise. The launcher this replaces
printed ``[UP]`` whenever *something* listened on a recorded port, so four stale
registries all claimed to be up while a single unrelated vite was the only live
process. Here ``●`` means "ownership-verified as this instance's process" and
``◐`` means "listening, but we could not attribute it" — a distinction that
makes that lie unrepresentable.

Default format is ``rich`` on a tty and ``plain`` when piped, so a script or an
agent capturing stdout gets stable, escape-free text without passing a flag.
The **text is not a contract**, though: callers that need a value use ``--json``,
``port`` or ``is-up``.
"""

from __future__ import annotations

import json
import sys

from .model import InstanceKind, InstanceState, RoleStatus, StatusReport

LIVE = "●"        # live + ownership-verified
UNVERIFIED = "◐"  # listening, owner unverifiable (e.g. AccessDenied)
DEAD = "✗"        # recorded pid is not alive
NA = "—"          # role not applicable to this kind

_STATE_STYLE = {
    InstanceState.RUNNING: "green",
    InstanceState.DEGRADED: "yellow",
    InstanceState.ORPHANED: "red",
    InstanceState.STALE: "dim",
    InstanceState.UNKNOWN: "dim",
}

LEGEND = (
    f"{LIVE} live + ownership-verified   "
    f"{UNVERIFIED} listening, owner unverifiable   "
    f"{DEAD} recorded pid dead   "
    f"{NA} not applicable to this kind"
)


def resolve_format(fmt: str | None) -> str:
    if fmt:
        return fmt
    if sys.stdout.isatty():
        return "plain" if _no_color() else "rich"
    return "plain"


def _no_color() -> bool:
    import os

    return bool(os.environ.get("NO_COLOR") or os.environ.get("FLOW_NO_COLOR"))


def to_json(report: StatusReport) -> str:
    return json.dumps(report.to_json(), indent=2)


def render(report: StatusReport, fmt: str | None = None, *, legend: bool = False) -> str:
    chosen = resolve_format(fmt)
    if chosen == "json":
        return to_json(report)
    if chosen == "rich":
        return _render_rich(report, legend=legend)
    return _render_plain(report, legend=legend)


# ── cell formatting ──────────────────────────────────────────────────────────
def _role_cell(rs: RoleStatus) -> str:
    if not rs.applicable:
        return NA
    port = f":{rs.port}" if rs.port else ""
    pid = f"pid {rs.pid}" if rs.pid else ""
    if rs.alive and rs.owned:
        glyph, suffix = LIVE, ""
    elif rs.alive:
        glyph, suffix = UNVERIFIED, "(unowned)"
    elif rs.pid:
        glyph, suffix = DEAD, ""
    else:
        glyph, pid, suffix = NA, "", ""
    return " ".join(filter(None, (glyph, port, pid, suffix)))


def format_age(seconds: float | None) -> str:
    """Shared by the tables and by `ctl reap`'s listing — two formatters
    meant the same orphan printed two different ages."""
    if seconds is None:
        return ""
    s = int(seconds)
    if s < 3600:
        return f"{s // 60}m"
    if s < 86400:
        return f"{s // 3600}h{(s % 3600) // 60:02d}m"
    return f"{s // 86400}d{(s % 86400) // 3600:02d}h"


def _notes(inst) -> str:
    """Every note for a row, not just the first.

    `warnings[0]` dropped the rest, and the append order put an
    alive-but-unowned role ahead of a stolen-port warning — so the one pairing
    that matters most (the dev-2/tmpl-3 collision) hid its conflict behind the
    other. Both renderers wrap, so there is no reason to truncate.
    """
    notes = list(inst.warnings)
    if not inst.launcher_owned and inst.state is InstanceState.RUNNING:
        notes.insert(0, "self-managed (no launcher.json)")
    if inst.kind is InstanceKind.HUB_UI and inst.hub_url:
        notes.append(f"hub {inst.hub_url}")
    return "; ".join(notes)


def _group_caption(name: str, members: list) -> str:
    kinds = sorted({str(m.kind) for m in members})
    up = sum(1 for m in members if m.state is InstanceState.RUNNING)
    return f"group {name} · {' + '.join(kinds)} · {up}/{len(members)} up"


def _footers(report: StatusReport) -> list[str]:
    out = []
    if report.hidden:
        out.append(
            f"{report.hidden} stale/never-allocated instance(s) hidden "
            "— use --all to show them, or 'reset' to clean them up"
        )
    if report.orphans:
        out.append(
            f"⚠ {len(report.orphans)} orphan process(es) with no registry "
            "— flow instance ctl reap --dry-run"
        )
    if report.conflicts:
        ports = ", ".join(str(c.port) for c in report.conflicts)
        out.append(f"⚠ {len(report.conflicts)} port conflict(s): {ports}")
    if report.ports_degraded:
        out.append(
            "⚠ socket attribution unavailable — port-derived checks are "
            "reporting-only and every port-gated kill will refuse"
        )
    return out


# ── shared table shape ───────────────────────────────────────────────────────
#: Single column list. Both renderers used to hardcode it, so adding a column
#: meant editing three places and the two tables could disagree on order.
COLUMNS = ("instance", "kind", "state", "backend", "frontend", "age", "notes")


def _sections(report: StatusReport) -> list[tuple[str | None, list]]:
    """Multi-member groups get a captioned section; singletons share one table."""
    sections: list[tuple[str | None, list]] = [
        (_group_caption(name, members), members)
        for name, members in report.groups().items()
    ]
    loners = report.ungrouped()
    if loners:
        sections.append((None, loners))
    return sections


def _row(inst) -> tuple[str, ...]:
    return (
        inst.name, str(inst.kind), str(inst.state),
        _role_cell(inst.backend), _role_cell(inst.frontend),
        format_age(inst.age_s), _notes(inst),
    )


def _header_bits(report: StatusReport) -> str:
    groups = len(report.groups())
    bits = [f"flow_home={report.flow_home}"]
    if groups:
        bits.append(f"{groups} group(s)")
    bits.append(f"{len(report.instances)} instance(s)")
    bits.append(f"{report.up} up")
    return " · ".join(bits)


def _header(report: StatusReport) -> str:
    return "Flowpad instances · " + _header_bits(report)


def _render_plain(report: StatusReport, *, legend: bool) -> str:
    cols = COLUMNS
    sections = _sections(report)
    all_rows = [_row(i) for _, members in sections for i in members]
    widths = [
        max([len(cols[i])] + [len(r[i]) for r in all_rows])
        for i in range(len(cols))
    ]

    def line(vals) -> str:
        return "  ".join(v.ljust(widths[i]) for i, v in enumerate(vals)).rstrip()

    out = [_header(report), ""]
    if not all_rows:
        out.append("(no live instances)")
        out.append("")
    for caption, members in sections:
        if caption:
            out.append(f"  {caption}")
        out.append("  " + line(cols))
        out.append("  " + "-" * len(line(cols)))
        for inst in members:
            out.append("  " + line(_row(inst)))
        out.append("")

    for orphan in report.orphans:
        out.append(
            f"  orphan pid {orphan.pid} instance={orphan.instance} "
            f"role={orphan.role or '?'} port={orphan.port or '-'} "
            f"age={format_age(orphan.age_s)}"
        )
    if report.orphans:
        out.append("")
    for c in report.conflicts:
        out.append(
            f"  conflict port {c.port}: leased to {c.leased_to}, "
            f"held by {c.held_by or 'unattributable'} pids={list(c.pids)}"
        )
    if report.conflicts:
        out.append("")
    out.extend(_footers(report))
    if legend:
        out += ["", LEGEND]
    return "\n".join(out).rstrip() + "\n"


# ── rich ─────────────────────────────────────────────────────────────────────
def _render_rich(report: StatusReport, *, legend: bool) -> str:
    from rich.console import Console
    from rich.table import Table

    console = Console(record=True, width=_console_width(), soft_wrap=False)
    console.print(f"[bold]Flowpad instances[/bold]  [dim]{_header_bits(report)}[/dim]")

    if not report.instances:
        console.print("[dim](no live instances)[/dim]")

    for caption, members in _sections(report):
        table = Table(
            title=f"[bold]{caption}[/bold]" if caption else None,
            title_justify="left",
            header_style="bold",
            expand=False,
            pad_edge=False,
        )
        for col in COLUMNS:
            table.add_column(col, overflow="fold")
        for inst in members:
            cells = list(_row(inst))
            cells[2] = f"[{_STATE_STYLE.get(inst.state, '')}]{inst.state}[/]"
            table.add_row(*cells)
        console.print(table)

    if report.orphans:
        table = Table(
            title="[bold red]orphan processes (no registry)[/bold red]",
            title_justify="left", header_style="bold", expand=False, pad_edge=False,
        )
        for col in ("pid", "instance", "role", "port", "age", "command"):
            table.add_column(col, overflow="ellipsis", no_wrap=(col == "command"))
        for o in report.orphans:
            table.add_row(
                str(o.pid), o.instance, str(o.role or "?"),
                str(o.port or "-"), format_age(o.age_s), o.cmd,
            )
        console.print(table)

    if report.conflicts:
        table = Table(
            title="[bold red]port conflicts[/bold red]",
            title_justify="left", header_style="bold", expand=False, pad_edge=False,
        )
        for col in ("port", "leased to", "held by", "pids"):
            table.add_column(col)
        for c in report.conflicts:
            table.add_row(
                str(c.port), c.leased_to,
                c.held_by or "[dim]unattributable[/dim]",
                ", ".join(str(p) for p in c.pids),
            )
        console.print(table)

    for note in _footers(report):
        console.print(f"[yellow]{note}[/yellow]")
    if legend:
        console.print(f"[dim]{LEGEND}[/dim]")

    return console.export_text(styles=False)


def _console_width() -> int:
    import shutil

    return max(100, shutil.get_terminal_size((120, 24)).columns)
