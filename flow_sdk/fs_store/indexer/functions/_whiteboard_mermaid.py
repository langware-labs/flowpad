"""Pure-function Excalidraw → Mermaid serializer.

This module is intentionally self-contained and side-effect free. It is paired
with a TypeScript port at ``ui/src/components/assets/editor/whiteboard/
excalidrawToMermaid.ts`` — the two implementations MUST produce byte-identical
output for any given input. The shared corpus under
``tests/fixtures/mermaid_corpus/`` enforces that invariant.
"""

from __future__ import annotations

from typing import Any


_HEADER = "flowchart TD"
_INDENT = "  "
_ESCAPE_CHARS = set("[]{}()|<>\\")


def _is_deleted(el: dict) -> bool:
    return bool(el.get("isDeleted"))


def _label_text(text_el: dict) -> str:
    return str(text_el.get("text", "")).strip()


def _escape_label(label: str) -> str:
    if not label:
        return '""'
    if any(ch in _ESCAPE_CHARS for ch in label):
        return '"' + label.replace('"', '\\"') + '"'
    return label


def _bbox_contains(shape: dict, px: float, py: float) -> bool:
    sx = float(shape.get("x", 0))
    sy = float(shape.get("y", 0))
    sw = float(shape.get("width", 0))
    sh = float(shape.get("height", 0))
    return sx <= px <= sx + sw and sy <= py <= sy + sh


def _center(el: dict) -> tuple[float, float]:
    x = float(el.get("x", 0))
    y = float(el.get("y", 0))
    w = float(el.get("width", 0))
    h = float(el.get("height", 0))
    return (x + w / 2.0, y + h / 2.0)


def _arrow_midpoint(arrow: dict) -> tuple[float, float]:
    # Excalidraw arrows have x/y as origin and `points` as offsets.
    pts = arrow.get("points") or []
    if not pts:
        return _center(arrow)
    origin_x = float(arrow.get("x", 0))
    origin_y = float(arrow.get("y", 0))
    first = pts[0]
    last = pts[-1]
    fx, fy = float(first[0]), float(first[1])
    lx, ly = float(last[0]), float(last[1])
    mx = origin_x + (fx + lx) / 2.0
    my = origin_y + (fy + ly) / 2.0
    return (mx, my)


def _shape_open_close(stype: str) -> tuple[str, str]:
    if stype == "rectangle":
        return ("[", "]")
    if stype == "diamond":
        return ("{{", "}}")
    if stype == "ellipse":
        return ("((", "))")
    return ("[", "]")


def _format_node(node_id: str, stype: str, label: str) -> str:
    open_b, close_b = _shape_open_close(stype)
    return f"{node_id}{open_b}{_escape_label(label)}{close_b}"


def _empty_board() -> str:
    return f"{_HEADER}\n{_INDENT}%% empty board\n"


def _malformed(err: str) -> str:
    one_line = " ".join(str(err).split())
    return f"{_HEADER}\n{_INDENT}%% malformed: {one_line}\n"


def excalidraw_to_mermaid(data: Any) -> str:
    """Convert an Excalidraw payload dict into a mermaid flowchart string.

    Never raises. Returns at minimum a valid `flowchart TD\\n  %% empty board\\n`.
    """
    try:
        if not isinstance(data, dict):
            return _empty_board()

        elements = data.get("elements")
        if not isinstance(elements, list) or len(elements) == 0:
            return _empty_board()

        # Pass 1: build shape nodes (rectangle / diamond / ellipse) in array order.
        shape_types = {"rectangle", "diamond", "ellipse"}
        shapes: list[dict] = []
        id_to_node: dict[str, str] = {}
        for el in elements:
            if not isinstance(el, dict):
                continue
            if _is_deleted(el):
                continue
            stype = el.get("type")
            if stype in shape_types:
                shapes.append(el)
                node_id = f"N{len(shapes)}"
                el_id = el.get("id")
                if isinstance(el_id, str):
                    id_to_node[el_id] = node_id

        # Pass 2: find text elements and pair them to shapes by bbox.
        texts: list[dict] = [
            el for el in elements
            if isinstance(el, dict) and not _is_deleted(el) and el.get("type") == "text"
        ]

        used_text_ids: set[str] = set()
        shape_labels: dict[int, str] = {}
        for shape_idx, shape in enumerate(shapes):
            label: str | None = None
            for t in texts:
                tid = t.get("id")
                if isinstance(tid, str) and tid in used_text_ids:
                    continue
                cx, cy = _center(t)
                if _bbox_contains(shape, cx, cy):
                    label = _label_text(t)
                    if isinstance(tid, str):
                        used_text_ids.add(tid)
                    break
            shape_labels[shape_idx] = label if (label is not None and label != "") else "Untitled"

        # Pass 3: arrows → edges. Arrow label = a not-yet-used text whose center
        # sits within 30px of the arrow midpoint.
        edge_lines: list[str] = []
        arrows_emitted_count = 0
        unbound_arrow_count = 0
        for el in elements:
            if not isinstance(el, dict):
                continue
            if _is_deleted(el):
                continue
            if el.get("type") != "arrow":
                continue
            sb = el.get("startBinding") or {}
            eb = el.get("endBinding") or {}
            sid = sb.get("elementId") if isinstance(sb, dict) else None
            tid = eb.get("elementId") if isinstance(eb, dict) else None
            if not (isinstance(sid, str) and isinstance(tid, str)
                    and sid in id_to_node and tid in id_to_node):
                unbound_arrow_count += 1
                continue
            src_node = id_to_node[sid]
            dst_node = id_to_node[tid]

            mx, my = _arrow_midpoint(el)
            label: str | None = None
            for t in texts:
                tx = t.get("id")
                if isinstance(tx, str) and tx in used_text_ids:
                    continue
                cx, cy = _center(t)
                dx = cx - mx
                dy = cy - my
                if (dx * dx + dy * dy) <= (30.0 * 30.0):
                    label = _label_text(t)
                    if isinstance(tx, str):
                        used_text_ids.add(tx)
                    break
            if label:
                edge_lines.append(f"{src_node} -->|{_escape_label(label)}| {dst_node}")
            else:
                edge_lines.append(f"{src_node} --> {dst_node}")
            arrows_emitted_count += 1

        # Build node lines.
        node_lines: list[str] = []
        for idx, shape in enumerate(shapes):
            stype = shape.get("type", "rectangle")
            label = shape_labels.get(idx, "Untitled")
            node_lines.append(_format_node(f"N{idx + 1}", stype, label))

        # Pass 4: loose elements bookkeeping.
        loose_categories: list[tuple[str, int]] = []
        freedraw_count = 0
        image_count = 0
        frame_count = 0
        orphan_text_count = 0
        for el in elements:
            if not isinstance(el, dict):
                continue
            if _is_deleted(el):
                continue
            etype = el.get("type")
            if etype == "freedraw":
                freedraw_count += 1
            elif etype == "image":
                image_count += 1
            elif etype == "frame":
                frame_count += 1
            elif etype == "text":
                eid = el.get("id")
                if not (isinstance(eid, str) and eid in used_text_ids):
                    orphan_text_count += 1
        loose_categories.append(("freedraw", freedraw_count))
        loose_categories.append(("image", image_count))
        loose_categories.append(("frame", frame_count))
        loose_categories.append(("orphan-text", orphan_text_count))
        loose_categories.append(("unbound-arrow", unbound_arrow_count))
        loose_parts = [f"{count} {name}" for (name, count) in loose_categories if count > 0]

        # Decide whether to emit `%% empty board`: no nodes, no edges, no loose.
        if not node_lines and not edge_lines and not loose_parts:
            return _empty_board()

        body_lines: list[str] = []
        for nl in node_lines:
            body_lines.append(f"{_INDENT}{nl}")
        for el in edge_lines:
            body_lines.append(f"{_INDENT}{el}")
        if loose_parts:
            body_lines.append(f"{_INDENT}%% loose elements: " + ", ".join(loose_parts))

        return f"{_HEADER}\n" + "\n".join(body_lines) + "\n"
    except (KeyError, TypeError) as err:
        return _malformed(repr(err))
