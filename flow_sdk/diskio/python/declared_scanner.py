"""DeclaredScanner — spec §3. The scan is ``assets.scanning.scan_declared``
itself; a ``TypeScanSpec`` is handed to it as the few attributes of a
``TypeInfo`` it reads, so there is one scan and no second copy of its order,
dedup or message rules."""

from __future__ import annotations

from pathlib import Path
from typing import Any, Sequence

from flow_sdk.assets.layout import File, Folder, Layout, Shape, Walk
from flow_sdk.assets.scanning import scan_declared
from flow_sdk.diskio.contract import ScanCandidate, ScanProblem, ShapeSpec, TypeScanSpec, WalkSpec


def type_scan_spec(info: Any) -> TypeScanSpec:
    """Export one ``TypeInfo``'s scan declaration as data: its shape and its
    walks, placement applied to every mount-less walk — an ``anywhere`` walk
    included, whose mounts are what it skips rather than what it scans.

    A fixed-name file shape (``File.names``) has no ``ShapeSpec`` form and is refused."""
    from flow_sdk.assets.placement import scan_mounts  # noqa: PLC0415

    shape = info.shape
    if isinstance(shape, Folder):
        shape_spec = ShapeSpec(kind="folder", main=shape.main)
    else:
        if shape.names:
            raise ValueError(f"{info.type_name}: a fixed-name file shape has no diskio scan spec")
        shape_spec = ShapeSpec(kind="file", ext=shape.ext, also=shape.also)
    placement = scan_mounts(*info._resolved_layout)
    return TypeScanSpec(
        type_name=info.type_name,
        shape=shape_spec,
        walks=tuple(
            WalkSpec(roots=walk.roots, mounts=walk.mounts or placement,
                     recursive=walk.recursive, anywhere=walk.anywhere)
            for walk in info.walk
        ),
    )


#: The root kind of a per-directory scan (``RecordType.FOLDER``).
FOLDER_ROOT = "folder"


def folder_walks(walks) -> tuple:
    """The walks rooted at a folder — the ones a stage-1 scan runs per directory."""
    return tuple(walk for walk in walks if FOLDER_ROOT in walk.roots)


def folder_scan_specs() -> tuple[TypeScanSpec, ...]:
    """One spec per registered type with a folder-rooted walk, carrying ONLY those
    walks — what a stage-1 request sends when root-kind scans stay with the parent."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    out: list[TypeScanSpec] = []
    for name in sorted(SchemaRegistry.get_all_types()):
        info = SchemaRegistry.get(name)
        if info is None or not folder_walks(info.walk):
            continue
        spec = type_scan_spec(info)
        out.append(spec.model_copy(update={
            "walks": tuple(walk.model_copy(update={"roots": (FOLDER_ROOT,)}) for walk in folder_walks(spec.walks)),
        }))
    return tuple(out)


class _SpecInfo:
    """What ``scan_declared`` reads off a ``TypeInfo``, rebuilt from a ``TypeScanSpec``."""

    #: No placement: the exporter already applied it to ``WalkSpec.mounts``.
    _resolved_layout = (None, None, None)

    def __init__(self, spec: TypeScanSpec) -> None:
        self.type_name = spec.type_name
        self.shape: Shape = (
            Folder(main=spec.shape.main) if spec.shape.kind == "folder"
            else File(ext=spec.shape.ext or ".md", also=spec.shape.also)
        )
        self.walk = tuple(
            Walk(roots=walk.roots, mounts=() if walk.anywhere else walk.mounts,
                 recursive=walk.recursive, anywhere=walk.anywhere)
            for walk in spec.walks
        )
        # What an ``anywhere`` walk skips an entry for being under: the union of
        # the type's walk mounts (``TypeInfo.scan_mounts`` for every such type).
        self.scan_mounts = tuple(dict.fromkeys(m for walk in spec.walks for m in walk.mounts))

    def layout_of(self, path: Path, *, verify: bool = False) -> Layout:
        return self.shape.locate(path, verify=verify)


class PyDeclaredScanner:
    def scan(
        self, root: str, root_type: str, specs: Sequence[TypeScanSpec],
    ) -> tuple[list[ScanCandidate], list[ScanProblem]]:
        candidates: list[ScanCandidate] = []
        problems: list[ScanProblem] = []
        root_path = Path(root)
        for spec in specs:
            result = scan_declared(_SpecInfo(spec), root_path, root_type)  # type: ignore[arg-type]
            candidates.extend(
                ScanCandidate(path=str(c.path), type_name=c.type_name, layout=c.layout.kind.value,
                              parent=str(c.traversal_parent))
                for c in result.candidates
            )
            problems.extend(
                ScanProblem(path=str(issue.path), type_name=issue.type_name or spec.type_name,
                            message=issue.message)
                for issue in result.issues
            )
        return candidates, problems
