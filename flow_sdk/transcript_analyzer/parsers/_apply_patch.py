"""Codex ``apply_patch`` text parser.

The ``apply_patch`` custom tool input is a small DSL:

    *** Begin Patch
    *** Add File: <path>
    +<content lines, one per line>
    *** Update File: <path>
    @@ <hunk header>
    -<removed line>
    +<added line>
     <context line>
    *** Delete File: <path>
    *** End Patch

This module returns one structured op per file header so the codex parser
can emit one semantic entry per file (FileWriteEntry for Add File,
FileEditEntry for Update File, FileEditEntry stub for Delete File until a
dedicated FileDeleteEntry exists).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class _PatchOp:
    op: str  # 'add' | 'update' | 'delete'
    path: str
    body_lines: list[str] = field(default_factory=list)


def parse_apply_patch(text: str) -> list[_PatchOp]:
    """Split a codex apply_patch payload into per-file ops.

    Tolerant of missing ``*** Begin Patch`` / ``*** End Patch`` sentinels —
    only the per-file headers actually drive segmentation. Body lines are
    captured verbatim (including their leading ``+`` / ``-`` / `` `` marker
    so callers can render an accurate diff).
    """
    ops: list[_PatchOp] = []
    current: _PatchOp | None = None
    if not text:
        return ops
    for line in text.split("\n"):
        if line.startswith("*** Add File:"):
            if current is not None:
                ops.append(current)
            current = _PatchOp(op="add", path=line[len("*** Add File:"):].strip())
            continue
        if line.startswith("*** Update File:"):
            if current is not None:
                ops.append(current)
            current = _PatchOp(op="update", path=line[len("*** Update File:"):].strip())
            continue
        if line.startswith("*** Delete File:"):
            if current is not None:
                ops.append(current)
            ops.append(_PatchOp(op="delete", path=line[len("*** Delete File:"):].strip()))
            current = None
            continue
        if line.startswith("*** Begin Patch") or line.startswith("*** End Patch"):
            continue
        if line.startswith("*** End of File"):
            # Optional separator inside a multi-file patch — closes the
            # current op without starting a new one.
            if current is not None:
                ops.append(current)
                current = None
            continue
        if current is not None:
            current.body_lines.append(line)
    if current is not None:
        ops.append(current)
    return ops


def add_op_to_content(op: _PatchOp) -> str:
    """For an ``add`` op, strip the leading ``+`` from each body line."""
    if op.op != "add":
        return ""
    out: list[str] = []
    for ln in op.body_lines:
        if ln.startswith("+"):
            out.append(ln[1:])
        else:
            # Defensive: an Add File body shouldn't carry context lines, but
            # if codex changes the grammar later we keep the line verbatim
            # rather than dropping it.
            out.append(ln)
    return "\n".join(out)


def update_op_to_hunks(op: _PatchOp) -> list[dict]:
    """Split an ``update`` op into one hunk per ``@@`` header.

    Each hunk is ``{"header": str, "lines": [str, ...]}`` — body lines are
    preserved with their leading ``+`` / ``-`` / `` `` marker so the
    renderer can format a real diff.
    """
    if op.op != "update":
        return []
    hunks: list[dict] = []
    current: dict | None = None
    for ln in op.body_lines:
        if ln.startswith("@@"):
            if current is not None:
                hunks.append(current)
            current = {"header": ln, "lines": []}
            continue
        if current is None:
            current = {"header": "", "lines": []}
        current["lines"].append(ln)
    if current is not None:
        hunks.append(current)
    return hunks
