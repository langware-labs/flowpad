"""The ``tag`` subgraph projection — taxonomy + bound assets, derived live.

Nothing is stored: hierarchy comes from dot-paths (``grammar.tag_tree``),
bindings come from their carriers (doc frontmatter / skill frontmatter / code
capsules — ``tags/bindings.py``), observation comes from the bus. Blessed
tags render as entity nodes; anonymous/implied tags and code files render
as ghosts.

Node addressing (the wire's edge-endpoint constraint — see
``flow_sdk/subgraph/payload.py``): EVERY tag node is ``{type:"tag",
id:<canonical name>}`` → node key ``tag-<name>``, so a tag name in a URL
maps to its node key with zero lookups, blessed or not. The blessed entity's
uuid rides in ``properties.entity_id`` for consumers that need the row.

Registered as subgraph projection ``"tag"`` at import (see
``server/routes/subgraph.py`` lazy loader).
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Optional

from flow_sdk.subgraph import register_projection
from flow_sdk.subgraph.payload import edge, node, node_key, payload
from flow_sdk.tags.grammar import is_valid_tag, tag_is_within, tag_tree


async def build_tag_graph(
    root: Optional[str] = None,
    *,
    code_root: "str | Path | None" = None,
    tree_only: bool = False,
    mentions: bool = False,
) -> dict[str, Any]:
    """Derive the tag GraphPayload. ``root`` scopes to a subtree (plus the
    ancestor chain down to it, so the zoomed view keeps its lineage)."""
    from flow_sdk.tags import event_bus  # noqa: PLC0415
    from flow_sdk.tags.bindings import all_entity_bindings, scan_code_capsules  # noqa: PLC0415

    include_assets = not tree_only

    # ── collect the full name universe first, then emit ────────────────────
    # One entity scan feeds all three carriers (see all_entity_bindings).
    entity_bindings = await all_entity_bindings(
        root if include_assets else None,
        include_assets=include_assets,
    )
    blessed = {row["name"]: row for row in entity_bindings["tags"] if is_valid_tag(row["name"])}

    observed = {name: stat for name, stat in event_bus.observed_tags().items() if is_valid_tag(name)}

    doc_bindings = entity_bindings["docs"] if include_assets else []
    skill_bindings = entity_bindings["skills"] if include_assets else []
    code_bindings: list[dict[str, Any]] = []
    if include_assets and code_root:
        code_dir = Path(code_root).expanduser()
        if code_dir.is_dir():
            code_bindings = scan_code_capsules(code_dir, root)

    names = {name for name in (*blessed, *observed) if root is None or tag_is_within(name, root)}
    for binding in (*doc_bindings, *skill_bindings, *code_bindings):
        names.update(binding["tags"])
    if root is not None and is_valid_tag(root):
        names.add(root)

    # tag_tree emits every ancestor prefix as a child, so its child values
    # ARE the closed name set — implied intermediates included.
    tree = tag_tree(sorted(names))
    all_names = {child for children in tree.values() for child in children}
    ordered_names = sorted(all_names)

    # ── nodes ───────────────────────────────────────────────────────────────
    nodes: list[dict[str, Any]] = []
    for name in ordered_names:
        row = blessed.get(name)
        stat = observed.get(name)
        properties: dict[str, Any] = {"name": name, "blessed": row is not None}
        if stat:
            properties["observed_count"] = stat.get("count")
        if row is not None:
            properties.update(
                {
                    "entity_id": row["id"],
                    "title": row["title"],
                    "description": row["description"],
                    "system": row["system"],
                }
            )
        nodes.append(
            node(
                "tag",
                name,
                label=name,
                is_ghost=row is None,
                properties=properties,
            )
        )

    # ── edges: hierarchy ────────────────────────────────────────────────────
    edges: list[dict[str, Any]] = []
    for parent, children in sorted(tree.items()):
        if not parent:
            continue
        for child in children:
            edges.append(edge("tag", parent, "tag", child, kind="child", topology="hierarchy"))

    # ── edges: bindings (association) ───────────────────────────────────────
    if include_assets:
        for doc in doc_bindings:
            nodes.append(
                node(
                    "markdown",
                    doc["id"],
                    label=doc["title"] or doc["id"],
                    properties={"asset_ref": doc["asset_ref"], "tags": doc["tags"]},
                )
            )
            for tag_name in doc["tags"]:
                edges.append(edge("markdown", doc["id"], "tag", tag_name, kind="bound", topology="association"))
        for skill in skill_bindings:
            nodes.append(
                node(
                    "skill",
                    skill["id"],
                    label=skill["name"] or skill["id"],
                    properties={"tags": skill["tags"]},
                )
            )
            for tag_name in skill["tags"]:
                edges.append(edge("skill", skill["id"], "tag", tag_name, kind="bound", topology="association"))
        # One ghost node per FILE, not per capsule block: `tag` is repeatable,
        # so a test module reports one site per annotated test and those must
        # coalesce or the payload carries duplicate `file-<path>` keys.
        by_path: dict[str, dict[str, Any]] = {}
        for site in code_bindings:
            carrier = by_path.setdefault(site["path"], {"lines": [], "tags": {}})
            carrier["lines"].append(site["line"])
            carrier["tags"].update(site["tags"])
        for path_key, carrier in sorted(by_path.items()):
            nodes.append(
                node(
                    "file",
                    path_key,
                    label=path_key,
                    is_ghost=True,
                    properties={
                        "path": path_key,
                        "lines": sorted(carrier["lines"]),
                        "tags": carrier["tags"],
                    },
                )
            )
            for tag_name in carrier["tags"]:
                edges.append(edge("file", path_key, "tag", tag_name, kind="bound", topology="association"))

    # ── edges: wiki mentions (weak, blessed only, best-effort) ──────────────
    if mentions and not tree_only:
        from flow_sdk.tags.bindings import tag_mentions  # noqa: PLC0415

        node_keys = {node_key(n["type"], n["id"]) for n in nodes}
        for name, row in sorted(blessed.items()):
            if name not in all_names:
                continue
            for link in await tag_mentions(row["id"]):
                if node_key(link.src_type, link.src_id) in node_keys:
                    edges.append(edge(link.src_type, link.src_id, "tag", name, kind="mentions", topology="association"))

    return payload(
        "tag",
        nodes,
        edges,
        root=node_key("tag", root) if root else None,
    )


async def _builder(params: dict[str, str]) -> dict[str, Any]:
    """Query-param adapter for the subgraph route. Params: ``root`` (tag
    name), ``code_root`` (abs dir), ``view`` (tree|full), ``mentions`` (1|0)."""
    from flow_sdk.tags.grammar import normalize_tag  # noqa: PLC0415

    raw_root = (params.get("root") or "").strip()
    root: Optional[str] = None
    if raw_root:
        root = normalize_tag(raw_root)  # invalid → ValueError → 500-guard below
    return await build_tag_graph(
        root,
        code_root=params.get("code_root") or None,
        tree_only=params.get("view") == "tree",
        mentions=params.get("mentions") == "1",
    )


register_projection("tag", _builder)
