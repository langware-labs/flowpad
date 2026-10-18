"""`flow icons check` -- does an icon tag resolve, and are the icon packs here valid?

Runs in-process against the same registry the backend serves: the built-in
packs, the shipped assistant project's packs, and every ``icon_pack`` asset in
the scopes above ``--path`` (default: the current directory). No server needed.

    flow icons check                         # validate the packs this directory can see
    flow icons check acme-vendors.sonos     # ... and these tags must resolve exactly

Exit codes: 0 everything resolves and every pack is clean; 1 otherwise.
"""

from __future__ import annotations

from pathlib import Path
from typing import List, Optional

import typer
from typing_extensions import Annotated

icons_app = typer.Typer(
    name="icons",
    help="Check icon tags and icon pack assets.",
    add_completion=False,
    no_args_is_help=True,
)


@icons_app.command("check")
def check(
    tags: Annotated[Optional[List[str]], typer.Argument(help="Icon tags that must resolve exactly.")] = None,
    path: Annotated[Path, typer.Option("--path", help="Where to look for icon pack assets (scopes above it).")] = Path("."),
) -> None:
    from flow_sdk.icons.registry import asset_pack_folders, check_tags, icons  # noqa: PLC0415

    icons.add_near(path.resolve())
    failed = False
    for parent in (path.resolve(), *path.resolve().parents):
        for folder in asset_pack_folders(parent):
            problems = icons.problems(folder)
            pack = icons.asset_pack(folder)
            kind = pack.spec.kind if pack is not None and pack.spec is not None else folder.name
            typer.echo(f"{'FAIL' if problems else 'ok  '} pack {kind} ({folder})")
            for problem in problems:
                typer.echo(f"       {problem}")
            failed = failed or bool(problems)
    for tag, problem in check_tags(tags or []).items():
        typer.echo(f"{'FAIL' if problem else 'ok  '} {tag}" + (f": {problem}" if problem else ""))
        failed = failed or bool(problem)
    raise typer.Exit(1 if failed else 0)
