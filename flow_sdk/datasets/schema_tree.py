"""The schemas a project defines, as one tree (``SchemaTreeSpec``) -- what the schema view shows.

Every kind a data schema folder of the project defines, with the kinds its fields name and the
dataset that keeps its rows. A kind a field names is written the same way whether the field links
to a row or holds the value; what tells them apart is the rule a row write already applies
(``links._inline_detail``): a kind some dataset keeps rows of is LINKED, any other is held INSIDE.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

from flow_sdk.datasets.links import datasets_for_kind, owner_of, row_kind
from flow_sdk.schema.data_spec.schema_tree_spec import (
    Held,
    SchemaDatasetSpec,
    SchemaFieldSpec,
    SchemaNodeSpec,
    SchemaTreeSpec,
    SchemaUseSpec,
)


def held_on_disk(kind: str, candidates: Iterable[Any]) -> list:
    """The datasets among ``candidates`` (index rows) whose folder still holds rows of ``kind``, once
    per folder. The index proposes, the disk decides: a stale row never differs from the Python
    lookup (``datasets_for_kind``)."""
    found, seen, held = [], set(), {}
    for d in candidates:
        folder = Path(d.asset_ref).resolve() if d.asset_ref else None
        if folder is None or not folder.is_dir() or folder in seen:
            continue
        owner = owner_of(folder)
        if owner not in held:
            held[owner] = {f.resolve() for f in datasets_for_kind(kind, owner)}
        if folder in held[owner]:
            seen.add(folder)
            found.append(d)
    return found


def _fields(form: dict) -> list[SchemaFieldSpec]:
    """A record's fields; a dataset kind's example slots, read as its fields."""
    if form["subkind"] == "dataset":
        return [SchemaFieldSpec(name=slot, shape=shape) for slot, shape in form["slots"].items()]
    return [SchemaFieldSpec(name=name, shape=f["shape"], description=f["description"], required=f["required"])
            for name, f in form["fields"].items()]


def _project_at(folder: Path, roots: dict[Path, str]) -> str:
    """The project whose folder holds ``folder`` (the innermost one), or ``""``."""
    inside = [root for root in roots if root == folder or root in folder.parents]
    return roots[max(inside, key=lambda root: len(root.parts))] if inside else ""


def schema_tree(project_id: str, root: Path, datasets: Iterable[Any], roots: dict[Path, str]) -> SchemaTreeSpec:
    """``root``'s schemas as a tree. ``datasets``: the project's dataset rows; ``roots``: every
    project folder by its id's project (resolved paths) -- where a kind another project defines is
    looked up. Reads the disk: call it off the event loop."""
    from flow_sdk.schema.data_spec.declared import _refs, folder_of, kinds_under  # noqa: PLC0415
    from flow_sdk.server.routes.kinds import kind_form  # noqa: PLC0415 — the one reading of a kind's form

    root = Path(root).resolve()
    datasets = list(datasets)
    nodes = []
    for kind, folder in kinds_under(root).items():
        form = kind_form(kind)
        if form is None:
            continue
        fields = _fields(form)
        uses = []
        for used in dict.fromkeys(ref for field in fields for ref in _refs(field.shape)):
            defined = folder_of(used)
            home = _project_at(defined.resolve(), roots) if defined is not None else ""
            owners = {root} | {r for r, pid in roots.items() if pid == home}
            held: Held = "link" if any(datasets_for_kind(used, owner) for owner in owners) else "inside"
            uses.append(SchemaUseSpec(kind=used, held=held, project_id=home))
        keeps = held_on_disk(kind, [d for d in datasets if row_kind(d.spec) == kind])
        nodes.append(SchemaNodeSpec(
            kind=kind,
            name=folder.name,
            subkind=form["subkind"],
            description=form.get("description", ""),
            folder=folder.resolve().relative_to(root).as_posix(),
            fields=fields,
            rules=form.get("rules", []),
            uses=uses,
            dataset=SchemaDatasetSpec(id=keeps[0].id, title=keeps[0].title or keeps[0].name,
                                      rows=keeps[0].num_examples, source_id=keeps[0].source_id) if keeps else None,
        ))
    return SchemaTreeSpec(project_id=project_id, kinds=nodes)
