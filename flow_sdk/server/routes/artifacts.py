"""What an execution read and produced — for any record, not just a flow run.

The engine has always written standardized I/O records
(``prepare_execution_io``); nothing read them back, so a run's real products
were reachable only through the filesystem — and for a bare process the UI's
only affordance shelled out to the OS file manager.

This is deliberately **path-only**. Every execution folder in the system has
the same two subdirectories, whether it belongs to a graph-workflow run
(``<run>/executions/<seq>-<node>/``) or a process (``<record>/execution/``), so
one lister serves both and the only thing a caller supplies is which record.
The flow-specific part — resolving an agent node's artifacts through the run
journal — stays in the graph-workflow route, because only there does a journal
exist.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional, Union

logger = logging.getLogger(__name__)

#: Never inline a file larger than this — the panel previews, it does not host.
MAX_ARTIFACT_PREVIEW_BYTES = 256 * 1024

#: The two subfolders `prepare_execution_io` materializes per execution.
DIRECTIONS = ("input", "output")

#: Extensions rendered as a live document rather than as source text. An HTML
#: report shown as escaped markup in a narrow pane is the single worst thing
#: about the old artifact view — the whole point of the file is to be read.
RENDERABLE_SUFFIXES = {".html", ".htm", ".svg", ".md"}


@dataclass(frozen=True)
class ArtifactRoot:
    """One execution's record folder. ``dir`` never crosses the wire."""
    key: str
    label: str
    seq: int
    node: str
    dir: Path
    process_id: Optional[str] = None


def roots_under(base: Path) -> dict[str, ArtifactRoot]:
    """Every execution folder inside one record dir, keyed.

    ``execution/`` is the record's own; ``executions/<seq>-<node>/`` are a
    flow run's inline steps. A process has only the former, a run usually both.
    """
    roots: dict[str, ArtifactRoot] = {}
    if (base / "execution").is_dir():
        roots["run"] = ArtifactRoot("run", "run", 0, "", base / "execution")

    nested = base / "executions"
    if nested.is_dir():
        for child in sorted(nested.iterdir()):
            if not child.is_dir():
                continue
            seq_str, _, node = child.name.partition("-")
            roots[child.name] = ArtifactRoot(
                key=child.name,
                label=node or child.name,
                seq=int(seq_str) if seq_str.isdigit() else 0,
                node=node,
                dir=child,
            )
    return roots


def list_files(folder: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for direction in DIRECTIONS:
        sub = folder / direction
        if not sub.is_dir():
            continue
        for path in sorted(sub.rglob("*")):
            if not path.is_file():
                continue
            try:
                size = path.stat().st_size
            except OSError:
                continue
            out.append({
                "name": str(path.relative_to(sub)),
                "direction": direction,
                "size": size,
                "previewable": size <= MAX_ARTIFACT_PREVIEW_BYTES,
                "renderable": path.suffix.lower() in RENDERABLE_SUFFIXES,
                "path": str(path),
            })
    return out


def as_executions(roots: dict[str, ArtifactRoot]) -> list[dict[str, Any]]:
    """Wire shape: the roots plus their files, ordered as they ran."""
    rows = [
        {
            "key": root.key, "label": root.label, "seq": root.seq,
            "node": root.node, "process_id": root.process_id,
            "files": list_files(root.dir),
        }
        for root in roots.values()
    ]
    rows.sort(key=lambda e: (e["seq"], e["key"]))
    return rows


def artifacts_for_record(record_type: str, record_id: str) -> list[dict[str, Any]]:
    """Executions of one record, by type + id."""
    from flow_sdk.fs_store.record_paths import shadow_dir_for  # noqa: PLC0415

    return as_executions(roots_under(shadow_dir_for(record_type, record_id)))


def resolve_artifact(root: ArtifactRoot, name: str) -> Optional[Path]:
    """``(root, name)`` → path, without re-walking the tree.

    Containment is checked on the RESOLVED path rather than trusted from the
    listing, so a crafted ``name`` cannot climb out of the execution folder even
    though every legitimate name came from ``list_files``.
    """
    for direction in DIRECTIONS:
        base = (root.dir / direction).resolve()
        try:
            candidate = (base / name).resolve()
        except OSError:
            continue
        if candidate.is_relative_to(base) and candidate.is_file():
            return candidate
    return None


def read_artifact(record_type: str, record_id: str, key: str,
                  name: str) -> Union[dict[str, Any], str, None]:
    """One artifact's content, or an error string, or None when absent."""
    from flow_sdk.fs_store.record_paths import shadow_dir_for  # noqa: PLC0415

    root = roots_under(shadow_dir_for(record_type, record_id)).get(key)
    if root is None:
        return f"unknown execution: {key}"
    path = resolve_artifact(root, name)
    if path is None:
        return None

    size = path.stat().st_size
    if size > MAX_ARTIFACT_PREVIEW_BYTES:
        return f"{name} is {size} bytes — too large to preview"
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        return f"unreadable: {exc}"
    return {
        "name": name, "size": size, "path": str(path), "text": text,
        "renderable": path.suffix.lower() in RENDERABLE_SUFFIXES,
    }
