"""Check a C4 chart folder before it is shown.

Usage: python3 -I check_c4.py <chart folder> [<chart folder> ...]

Checks each folder's c4.json against chartit.c4: known level and kinds, unique ids, every
relation and boundary pointing at something that exists, no boundary loop, every `ref` naming
a chart in the same project, and no style fields (the editor owns the look). Warns past 20
elements. Prints one JSON line per folder and exits 1 when any folder has an error.
Icons are checked separately: `flow icons check <tag> ... --path <chart folder>`.
Standard library only.
"""

import json
import re
import sys
from pathlib import Path

LEVELS = {"landscape", "context", "container", "component", "code", "dynamic", "deployment"}
KINDS = {"person", "system", "container", "database", "queue", "component", "code"}
STATUSES = {"current", "migrating", "target"}
FIELDS = {
    "chart": {"title", "level", "direction", "elements", "boundaries", "relations"},
    "element": {"id", "kind", "label", "tech", "description", "external", "boundary", "icon", "ref", "status", "note"},
    "boundary": {"id", "label", "kind", "tech", "parent", "note"},
    "relation": {"id", "from", "to", "label", "tech", "order", "style", "note"},
}
MAX_ELEMENTS = 20


def project_root(folder: Path) -> Path:
    for p in [folder, *folder.parents]:
        if (p / "agentic-assets").is_dir() and p != folder:
            return p
    return folder.parent


def chart_names(root: Path) -> set[str]:
    """Names of every chart in the project: CHART.md frontmatter `name`, else the folder name."""
    names = set()
    for doc in (root / "agentic-assets" / "chart").glob("*/CHART.md"):
        m = re.search(r"^name:\s*(.+)$", doc.read_text(encoding="utf-8", errors="replace"), re.M)
        names.add(m.group(1).strip().strip("'\"") if m else doc.parent.name)
    return names


def check(folder: Path) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        data = json.loads((folder / "c4.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return {"chart": str(folder), "ok": False, "errors": [f"c4.json: {e}"], "warnings": []}
    if not isinstance(data, dict):
        return {"chart": str(folder), "ok": False, "errors": ["c4.json is not an object"], "warnings": []}

    def extra(kind: str, item: dict, where: str) -> None:
        unknown = sorted(set(item) - FIELDS[kind])
        if unknown:
            errors.append(f"{where}: unknown field(s) {unknown} — the editor owns the look; keep facts only")

    extra("chart", data, "chart")
    if data.get("level") not in LEVELS:
        errors.append(f"level {data.get('level')!r} is not one of {sorted(LEVELS)}")
    if data.get("direction") not in (None, "TB", "LR"):
        errors.append("direction must be TB or LR")
    elements = data.get("elements") or []
    boundaries = data.get("boundaries") or []
    relations = data.get("relations") or []
    seen: set[str] = set()

    def unique(item: dict, where: str) -> str:
        iid = item.get("id")
        if not isinstance(iid, str) or not iid:
            errors.append(f"{where}: missing id")
            return ""
        if iid in seen:
            errors.append(f"{where}: id {iid!r} is used twice")
        seen.add(iid)
        return iid

    bids = {b.get("id") for b in boundaries if isinstance(b, dict)}
    eids = {e.get("id") for e in elements if isinstance(e, dict)}
    refs: list[str] = []
    for i, e in enumerate(elements):
        where = f"elements[{i}]"
        if not isinstance(e, dict):
            errors.append(f"{where}: not an object")
            continue
        iid = unique(e, where)
        extra("element", e, f"element {iid or i}")
        if e.get("kind") not in KINDS:
            errors.append(f"element {iid}: kind {e.get('kind')!r} is not one of {sorted(KINDS)}")
        if not e.get("label"):
            errors.append(f"element {iid}: missing label")
        if e.get("boundary") and e["boundary"] not in bids:
            errors.append(f"element {iid}: boundary {e['boundary']!r} does not exist")
        if e.get("status") not in (None, *STATUSES):
            errors.append(f"element {iid}: status must be one of {sorted(STATUSES)}")
        if e.get("ref"):
            refs.append(e["ref"])
    for i, b in enumerate(boundaries):
        where = f"boundaries[{i}]"
        if not isinstance(b, dict):
            errors.append(f"{where}: not an object")
            continue
        iid = unique(b, where)
        extra("boundary", b, f"boundary {iid or i}")
        if not b.get("label"):
            errors.append(f"boundary {iid}: missing label")
        if b.get("parent") and b["parent"] not in bids:
            errors.append(f"boundary {iid}: parent {b['parent']!r} does not exist")
        # a loop of parents would never close
        chain, at = set(), b.get("parent")
        while at:
            if at in chain or at == iid:
                errors.append(f"boundary {iid}: its parents loop")
                break
            chain.add(at)
            at = next((x.get("parent") for x in boundaries if isinstance(x, dict) and x.get("id") == at), None)
        if iid and not any(isinstance(e, dict) and e.get("boundary") == iid for e in elements) and not any(
            isinstance(x, dict) and x.get("parent") == iid for x in boundaries
        ):
            warnings.append(f"boundary {iid}: holds nothing, so it is not drawn")
    for i, r in enumerate(relations):
        where = f"relations[{i}]"
        if not isinstance(r, dict):
            errors.append(f"{where}: not an object")
            continue
        iid = unique(r, where)
        extra("relation", r, f"relation {iid or i}")
        for end in ("from", "to"):
            if r.get(end) not in eids:
                errors.append(f"relation {iid}: {end} {r.get(end)!r} is not an element")
        if r.get("from") == r.get("to"):
            errors.append(f"relation {iid}: from and to are the same element")
        if not r.get("label"):
            errors.append(f"relation {iid}: missing label")
        if r.get("style") not in (None, "sync", "async"):
            errors.append(f"relation {iid}: style must be sync or async")
    if len(elements) > MAX_ELEMENTS:
        warnings.append(f"{len(elements)} elements — past {MAX_ELEMENTS}, split it: zoom in with another chart and `ref`")
    if refs:
        names = chart_names(project_root(folder))
        for ref in refs:
            if ref not in names:
                errors.append(f"ref {ref!r}: no chart with that name in the project")
    return {"chart": str(folder), "ok": not errors, "errors": errors, "warnings": warnings}


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    failed = False
    for arg in sys.argv[1:]:
        result = check(Path(arg).resolve())
        failed |= not result["ok"]
        print(json.dumps(result))
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
