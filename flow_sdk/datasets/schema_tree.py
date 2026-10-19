"""The schemas a project defines, as one tree (``SchemaTreeSpec``) -- what the schema tree shows.

Every schema a data schema folder of the project defines, with the kinds its fields name and the
dataset that keeps its rows. A field names a kind the same way whether it links to a row or holds
the value; what tells them apart is the rule a row write applies (``links.is_row_kind``): a kind a
dataset of the project keeps rows of is LINKED, any other is held INSIDE the row.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Iterable

from flow_sdk.datasets.links import datasets_holding, is_row_kind, row_kind
from flow_sdk.schema.data_spec.schema_tree_spec import (
    SchemaDatasetSpec,
    SchemaFieldSpec,
    SchemaNodeSpec,
    SchemaTreeSpec,
    SchemaUseSpec,
)


def _fields(form: dict) -> list[SchemaFieldSpec]:
    """A record's fields; a dataset kind's example slots, read as its fields."""
    if form["subkind"] == "dataset":
        return [SchemaFieldSpec(name=slot, shape=shape) for slot, shape in form["slots"].items()]
    return [SchemaFieldSpec(name=name, shape=f["shape"], description=f["description"], required=f["required"])
            for name, f in form["fields"].items()]


def schema_tree(root: Path, datasets: Iterable[Any], mounts: tuple[tuple[str, str], ...]) -> SchemaTreeSpec:
    """``root``'s schemas as a tree. ``datasets``: the project's dataset rows; ``mounts``: every
    project's folder and id (``load_project_mounts``) -- where a kind another project defines is
    looked up. Reads the disk: call it off the event loop."""
    from flow_sdk.fs_store.indexer.roots import deepest_project_id_for_path  # noqa: PLC0415
    from flow_sdk.fs_store.path_utils import canonical_posix_path  # noqa: PLC0415
    from flow_sdk.schema.data_spec.declared import folder_of, kinds_named, kinds_under  # noqa: PLC0415
    from flow_sdk.schema.data_spec.kind_form import kind_form  # noqa: PLC0415

    root = Path(root).resolve()
    cache: dict = {}  # one listing of the project's datasets, whatever is asked of it
    rows_of: dict[str, list] = {}
    for dataset in datasets:
        rows_of.setdefault(row_kind(dataset.spec), []).append(dataset)
    uses: dict[str, SchemaUseSpec] = {}

    def use(kind: str) -> SchemaUseSpec:
        if kind not in uses:
            defined = folder_of(kind)
            home = deepest_project_id_for_path(canonical_posix_path(str(defined)), mounts) if defined else None
            uses[kind] = SchemaUseSpec(
                kind=kind, held="link" if is_row_kind(kind, root, cache) else "inside", project_id=home or "")
        return uses[kind]

    nodes = []
    for kind, folder in kinds_under(root).items():
        form = kind_form(kind)
        if form is None:
            continue
        fields = _fields(form)
        keeps = datasets_holding(kind, rows_of.get(kind, []), cache)
        nodes.append(SchemaNodeSpec(
            kind=kind,
            name=folder.name,
            subkind=form["subkind"],
            description=form.get("description", ""),
            folder=folder.resolve().relative_to(root).as_posix(),
            fields=fields,
            rules=form.get("rules", []),
            uses=[use(named) for named in dict.fromkeys(n for field in fields for n in kinds_named(field.shape))],
            dataset=SchemaDatasetSpec(id=keeps[0].id, title=keeps[0].title or keeps[0].name,
                                      rows=keeps[0].num_rows, source_id=keeps[0].source_id) if keeps else None,
        ))
    return SchemaTreeSpec(schemas=nodes)
