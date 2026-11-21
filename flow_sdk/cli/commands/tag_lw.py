"""The statement-doc subcommands of `flow tag` -- lw (langware), a project's statement docs.

A tag names an lw block in a doc (statements, requirements, test_debug); these commands read and write those blocks
and walk the dependency tree their tags make. They run in-process on the project that contains the
current directory (its ``docs`` folder; ``--root`` to point elsewhere) and need no server.

    flow tag tree <tag>               # the dependency tree under a tag
    flow tag check                    # validate every block and every dependency
    flow tag blocks                   # every doc that holds blocks, with its tags
    flow tag show <tag>               # a block (or a doc's blocks), what it depends on, what depends on it
    flow tag put --doc <path> --kind statements --tag <tag> --json '{"statements": [{"text": "..."}]}'
    flow tag drop --doc <path> --tag <tag>

Exit codes: 0 done; 1 a problem was found or the write was refused; 2 bad arguments. See ``docs/lw.md``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import List, Optional

import typer
from typing_extensions import Annotated

_Root = Annotated[Optional[Path], typer.Option("--root", help="The docs folder to read (default: the project's docs).")]
_Packages = Annotated[
    Optional[List[str]],
    typer.Option("--package", help="Where another project lives, as <namespace>=<path>, for --<namespace>-- dependencies."),
]


def _load(root: Optional[Path], packages: Optional[List[str]] = None):
    from flow_sdk.lw.collection import docs_root, load  # noqa: PLC0415

    known = {}
    for entry in packages or []:
        name, _, where = entry.partition("=")
        if not name or not where:
            typer.echo(f"--package takes <namespace>=<path>, got '{entry}'")
            raise typer.Exit(2)
        known[name] = Path(where)
    return load(root or docs_root(Path.cwd()), packages=known)


def list_docs(root: _Root = None) -> None:
    """Every doc that holds blocks, with its tags."""
    from flow_sdk.lw.collection import short  # noqa: PLC0415

    collection = _load(root)
    for path in sorted(collection.doc_deps):
        typer.echo(short(path))
        for block in (b for b in collection.blocks if b.path == path):
            deps = f"  depends on: {', '.join(block.depends_on)}" if block.depends_on else ""
            typer.echo(f"  {block.kind:<12} {block.tag or '(invalid)'}  ({len(block.items)}){deps}")
    typer.echo(f"{len(collection.doc_deps)} docs, {len(collection.blocks)} blocks")


def check_docs(root: _Root = None, package: _Packages = None) -> None:
    """Validate every block and every dependency."""
    from flow_sdk.lw.collection import check  # noqa: PLC0415

    collection = _load(root, package)
    problems = check(collection)
    for problem in problems:
        typer.echo(str(problem))
    typer.echo(f"{'FAIL' if problems else 'OK'}: {len(collection.blocks)} blocks, {len(problems)} problems")
    raise typer.Exit(1 if problems else 0)


def show_tree(tag: str, root: _Root = None) -> None:
    """The dependency tree under a tag."""
    from flow_sdk.lw.collection import short, tree  # noqa: PLC0415

    rows = tree(_load(root), tag)
    if not rows:
        typer.echo(f"no block or doc has the tag '{tag}'")
        raise typer.Exit(1)
    for depth, name, block, repeated in rows:
        where = f"  {block.kind} ({len(block.items)})  {short(block.path)}:{block.line}" if block else ""
        typer.echo(f"{'  ' * depth}{name}{where}{'  (its dependencies are listed above)' if repeated else ''}")


def show(tag: str, root: _Root = None) -> None:
    """A block (or every block of a doc), then what it depends on, then what depends on it."""
    from flow_sdk.lw.blocks import render_block  # noqa: PLC0415
    from flow_sdk.lw.collection import related, short  # noqa: PLC0415

    collection = _load(root)
    by_tag = collection.by_tag()
    own = [by_tag[tag]] if tag in by_tag else [b for b in collection.blocks if b.spec and collection.doc_tags.get(tag) == b.path]
    if not own and tag in collection.doc_tags:
        typer.echo(f"{short(collection.doc_tags[tag])} has the tag '{tag}' and holds no blocks yet")
        return
    if not own:
        typer.echo(f"no block or doc has the tag '{tag}'")
        raise typer.Exit(1)
    shown = {b.tag for b in own}
    sections = [("", own)]
    for label, dependents in (("it depends on: ", False), ("depends on it: ", True)):
        extra: list = []
        for block in own:
            extra += [b for b in related(collection, block.tag, dependents)[1:] if b.tag not in shown and b not in extra]
        sections.append((label, extra))
    for label, blocks in sections:
        for block in blocks:
            typer.echo(f"# {label}{short(block.path)}:{block.line}")
            typer.echo(render_block(block.spec) + "\n")


def put_block(
    doc: Annotated[Path, typer.Option("--doc", help="The doc to write into.")],
    kind: Annotated[str, typer.Option("--kind", help="statements, requirements or test_debug.")],
    tag: Annotated[str, typer.Option("--tag", help="The block's tag.")],
    body: Annotated[str, typer.Option("--json", help='The whole block: {"depends_on": [...], "<kind>": [{"text": ...}]}')],
    root: _Root = None,
) -> None:
    """Write one block: replace the block with this tag, or add it at the end of the doc."""
    from flow_sdk.lw.collection import put, short  # noqa: PLC0415
    from flow_sdk.schema.data_spec.lw_spec import BLOCK_KINDS  # noqa: PLC0415

    if kind not in BLOCK_KINDS:
        typer.echo(f"--kind is one of: {', '.join(BLOCK_KINDS)}")
        raise typer.Exit(2)
    try:
        data = json.loads(body)
    except json.JSONDecodeError as exc:
        typer.echo(f"--json is not valid JSON: {exc}")
        raise typer.Exit(2) from exc
    if not isinstance(data, dict):
        typer.echo("--json must be an object")
        raise typer.Exit(2)
    problems = put(doc, kind, tag, data, root)
    for problem in problems:
        typer.echo(str(problem))
    typer.echo("REFUSED: nothing written" if problems else f"OK: wrote {kind} block '{tag}' in {short(doc)}")
    raise typer.Exit(1 if problems else 0)


def remove_block(
    doc: Annotated[Path, typer.Option("--doc", help="The doc to remove from.")],
    tag: Annotated[str, typer.Option("--tag", help="The block's tag.")],
    root: _Root = None,
) -> None:
    """Delete one block. Refused while another block depends on it."""
    from flow_sdk.lw.collection import remove, short  # noqa: PLC0415

    problems = remove(doc, tag, root)
    for problem in problems:
        typer.echo(str(problem))
    typer.echo("REFUSED: nothing removed" if problems else f"OK: removed block '{tag}' from {short(doc)}")
    raise typer.Exit(1 if problems else 0)


#: name under ``flow tag`` -> the command.
COMMANDS = {
    "tree": show_tree,
    "check": check_docs,
    "blocks": list_docs,
    "show": show,
    "put": put_block,
    "drop": remove_block,
}


def register(app: typer.Typer) -> None:
    """Add the statement-doc subcommands to ``flow tag``."""
    for name, command in COMMANDS.items():
        app.command(name)(command)

