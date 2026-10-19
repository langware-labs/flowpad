"""`flow tag ...` CLI subgroup.

Subject-scoped context for agents: ``flow tag <name> get`` pulls everything
bound to a dot-taxonomy tag — docs whose frontmatter lists it, source files
carrying a ``tag`` capsule, wiki mentions — assembled server-side by
``POST /api/v1/tags/context`` (see flow_sdk/server/routes/tags.py).

``flow tag create <name>`` blesses a name: the OPTIONAL Tag entity carrying a
title/description (flow_sdk/builtin/tag.py). Bindings never need it — docs and
capsules bind to anonymous names — so this only adds documentation, display,
and wiki-mention resolution.

Modes (LLMIndex summary tiers):
    line  — one line per bound doc / code site (the orientation pass)
    block — a ≤60-word summary per doc (the working set)
    full  — whole doc bodies (size-capped; only when load-bearing)

Output is human-readable text — it is written to be pasted into an agent's
context window, not parsed. Exit codes: 0 ok; 2 invalid args; 5 server error.
"""

from __future__ import annotations

import os
from typing import Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
)
from flow_sdk.cli.commands._common import (
    fail as _fail,
)
from flow_sdk.cli.commands._common import (
    post_graph_json as _post_graph_json,
)

tag_app = typer.Typer(
    name="tag",
    help="Subject-scoped context: docs + code sites bound to a dot-taxonomy tag.",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_CONNECTION_ERROR = 5


def _render(data: dict) -> str:
    lines: list[str] = []
    tag = data.get("tag") or {}
    mode = data.get("mode")
    name = tag.get("name", "")
    if tag.get("blessed"):
        title = tag.get("title") or name
        lines.append(f"# Tag: {name} — {title}")
        if tag.get("description"):
            lines.append(tag["description"])
    else:
        lines.append(f"# Tag: {name} (anonymous — no blessed entity)")
    for ancestor in tag.get("ancestors") or []:
        desc = ancestor.get("description") or ancestor.get("title") or ""
        lines.append(f"  under {ancestor['name']}: {desc}")

    docs = data.get("docs") or []
    lines.append("")
    lines.append(f"## Docs ({len(docs)})")
    for doc in docs:
        ref = doc.get("asset_ref") or doc.get("id")
        lines.append(f"- {doc.get('title') or ref} [{', '.join(doc.get('tags') or [])}]")
        lines.append(f"  {ref}")
        if mode == "line":
            lines.append(f"  {doc.get('line', '')}")
        if mode in ("block", "full") and doc.get("block"):
            lines.append(f"  {doc['block']}")
        if mode == "full" and doc.get("body") is not None:
            lines.append("")
            lines.append(f"--- BEGIN {ref} ---")
            lines.append(doc["body"].rstrip())
            suffix = " (TRUNCATED)" if doc.get("truncated") else ""
            lines.append(f"--- END {ref}{suffix} ---")

    code = data.get("code") or []
    lines.append("")
    lines.append(f"## Code sites ({len(code)})")
    for site in code:
        lines.append(f"- {site['path']}:{site['line']}")
        for tname, one_liner in (site.get("tags") or {}).items():
            lines.append(f"    {tname}: {one_liner}")

    mentions = data.get("mentions") or []
    if mentions:
        lines.append("")
        lines.append(f"## Mentions ({len(mentions)})")
        for m in mentions:
            lines.append(f"- {m['src_type']}-{m['src_id']} (line {m['line']})")
    return "\n".join(lines)


@tag_app.command(
    "get",
    help="Pull the context bundle for a tag. NAME is a dot-taxonomy tag (e.g. flow.runs).",
)
def tag_get(
    name: Annotated[str, typer.Argument(help="Tag name, e.g. flow.runs")],
    mode: Annotated[str, typer.Option("--mode", "-m", help="line | block | full")] = "line",
    root: Annotated[
        Optional[str],
        typer.Option("--root", help="Root to scan for code tag-capsules (default: cwd)."),
    ] = None,
) -> None:
    if not name or not name.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_TAG", "Empty tag name")
    if mode not in ("line", "block", "full"):
        _fail(EXIT_INVALID_ARG, "INVALID_MODE", f"mode must be line|block|full, got {mode!r}")
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/tags/context"

    def _on_error(status_code: int, rbody: dict) -> None:
        message = str(rbody.get("message") or f"HTTP {status_code}")
        if status_code == 400:
            _fail(EXIT_INVALID_ARG, "INVALID_ARG", message)
        _fail(EXIT_CONNECTION_ERROR, "SERVER_ERROR", message)

    data = _post_graph_json(
        url,
        # Absolutize client-side: the scan runs server-side against the SERVER's cwd.
        {"name": name.strip(), "mode": mode, "root": os.path.abspath(os.path.expanduser(root or "."))},
        timeout=30,
        on_error=_on_error,
    )
    typer.echo(_render(data))


@tag_app.command(
    "create",
    help="Bless a tag — create its Tag entity. NAME is a dot-taxonomy tag (e.g. breadcrumb.test.foo.rules).",
)
def tag_create(
    name: Annotated[str, typer.Argument(help="Tag name, e.g. breadcrumb.test.foo.rules")],
    title: Annotated[Optional[str], typer.Option("--title", help="UX display label")] = None,
    description: Annotated[
        Optional[str],
        typer.Option("--description", "-d", help="What things under this tag mean"),
    ] = None,
) -> None:
    """Idempotent by construction: ``id = uuid5("tag:<name>")``, so re-running
    the same name upserts the same row instead of creating a second one.

    Creation under a system-owned first segment (``flow``, ``entity``,
    ``agent``, …) is refused by entity save-validation — the server answers 4xx
    and that surfaces here as INVALID_TAG, not a crash.
    """
    if not name or not name.strip():
        _fail(EXIT_INVALID_ARG, "INVALID_TAG", "Empty tag name")
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/tag"
    payload: dict = {"name": name.strip()}
    if title:
        payload["title"] = title
    if description:
        payload["description"] = description

    def _on_error(status_code: int, rbody: dict) -> None:
        message = str(rbody.get("message") or f"HTTP {status_code}")
        if 400 <= status_code < 500:
            _fail(EXIT_INVALID_ARG, "INVALID_TAG", message)
        _fail(EXIT_CONNECTION_ERROR, "SERVER_ERROR", message)

    data = _post_graph_json(url, payload, on_error=_on_error)
    typer.echo(f"tag-{data.get('id')}  {data.get('name')}")
