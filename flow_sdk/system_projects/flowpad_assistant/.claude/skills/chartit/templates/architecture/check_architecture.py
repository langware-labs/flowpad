"""Check an architecture chart folder before it is shown.

Usage: python3 -I check_architecture.py <chart folder> [<chart folder> ...]

Checks each folder's architecture.json against chartit.architecture: unique ids across groups, tiers and
parts, known roles, every link joining two things that exist, every step number on a part and every
part's step listed in `steps`, every `ref` naming a chart in the same project, and no style fields (the
editor owns the look). Warns past 30 parts or 5 parts in one tier row. Prints one JSON line per folder
and exits 1 when any folder has an error. Standard library only.
"""

import json
import re
import sys
from pathlib import Path

# Mirrors the chartit.architecture* data_schema kinds (schema/…/data_schema/chartit/) — keep them in step.
ROLES = {"client", "service", "db", "files", "worker", "external"}
FIELDS = {
    "chart": {"title", "groups", "links", "steps"},
    "group": {"id", "label", "sublabel", "tiers", "parts", "cols"},
    "tier": {"id", "label", "cols", "parts"},
    "part": {"id", "label", "sublabel", "role", "step", "ref", "note"},
    "link": {"id", "from", "to", "label", "style", "both", "note"},
    "step": {"n", "text"},
}
MAX_PARTS = 30


def project_root(folder: Path) -> Path:
    for p in [folder, *folder.parents]:
        if (p / "agentic-assets").is_dir() and p != folder:
            return p
    return folder.parent


def chart_names(root: Path) -> set[str]:
    """Every chart's name in the project — the two places a chart lives, `agentic-assets/chart/<name>/` and
    `docs/<area>/<name>/`: CHART.md frontmatter `name`, else the folder name."""
    names = set()
    docs = [*(root / "agentic-assets" / "chart").glob("*/CHART.md"), *(root / "docs").glob("*/*/CHART.md")]
    for doc in docs:
        m = re.search(r"^name:\s*(.+)$", doc.read_text(encoding="utf-8", errors="replace"), re.M)
        names.add(m.group(1).strip().strip("'\"") if m else doc.parent.name)
    return names


def _extra(kind: str, obj: dict, where: str, errors: list[str]) -> None:
    for key in sorted(set(obj) - FIELDS[kind]):
        errors.append(f"{where}: unknown field '{key}' (the editor owns the look)")


def check(folder: Path) -> dict:
    errors: list[str] = []
    warnings: list[str] = []
    try:
        data = json.loads((folder / "architecture.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        return {"chart": str(folder), "ok": False, "errors": [f"architecture.json: {e}"], "warnings": []}
    if not isinstance(data, dict):
        return {"chart": str(folder), "ok": False, "errors": ["architecture.json: not an object"], "warnings": []}
    _extra("chart", data, "chart", errors)
    ids: set[str] = set()
    parts: list[dict] = []

    def take(obj_id: object, where: str) -> None:
        if not isinstance(obj_id, str) or not obj_id:
            errors.append(f"{where}: missing id")
        elif obj_id in ids:
            errors.append(f"{where}: duplicate id '{obj_id}'")
        else:
            ids.add(obj_id)

    for gi, g in enumerate(data.get("groups") or []):
        where = f"groups[{gi}]"
        _extra("group", g, where, errors)
        take(g.get("id"), where)
        if not g.get("label"):
            errors.append(f"{where}: missing label")
        tiers = g.get("tiers") or ([{"id": f"{g.get('id')}-parts", "label": "", "parts": g["parts"], "cols": g.get("cols", 1)}] if g.get("parts") else [])
        if not tiers:
            warnings.append(f"{where}: no tiers or parts — an empty box")
        for ti, t in enumerate(tiers):
            tw = f"{where}.tiers[{ti}]"
            _extra("tier", t, tw, errors)
            take(t.get("id"), tw)
            row = t.get("cols") or min(len(t.get("parts") or []), 4)
            if row > 5:
                warnings.append(f"{tw}: {row} parts in one row — set fewer `cols`")
            for pi, p in enumerate(t.get("parts") or []):
                pw = f"{tw}.parts[{pi}]"
                _extra("part", p, pw, errors)
                take(p.get("id"), pw)
                if not p.get("label"):
                    errors.append(f"{pw}: missing label")
                if p.get("role") not in ROLES:
                    errors.append(f"{pw}: role must be one of {sorted(ROLES)}")
                parts.append(p)
    if len(parts) > MAX_PARTS:
        warnings.append(f"{len(parts)} parts — past {MAX_PARTS}, split it: give a part a `ref` to a chart of its insides")

    for li, link in enumerate(data.get("links") or []):
        lw = f"links[{li}]"
        _extra("link", link, lw, errors)
        for end in ("from", "to"):
            if link.get(end) not in ids:
                errors.append(f"{lw}: {end} '{link.get(end)}' is no group, tier or part")
        if link.get("style") not in (None, "solid", "dashed"):
            errors.append(f"{lw}: style must be solid or dashed")

    step_parts = {p["step"] for p in parts if isinstance(p.get("step"), int)}
    listed = set()
    for si, s in enumerate(data.get("steps") or []):
        _extra("step", s, f"steps[{si}]", errors)
        if not isinstance(s.get("n"), int) or not s.get("text"):
            errors.append(f"steps[{si}]: needs an int `n` and a `text`")
            continue
        listed.add(s["n"])
        if s["n"] not in step_parts:
            errors.append(f"steps[{si}]: step {s['n']} is on no part")
    for n in sorted(step_parts - listed):
        errors.append(f"step {n} is on a part but not listed in `steps`")

    refs = [p["ref"] for p in parts if p.get("ref")]
    if refs:
        known = chart_names(project_root(folder))
        for ref in refs:
            if ref not in known:
                errors.append(f"ref '{ref}' names no chart in the project")
    return {"chart": str(folder), "ok": not errors, "errors": errors, "warnings": warnings}


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    bad = False
    for arg in argv:
        result = check(Path(arg).resolve())
        print(json.dumps(result))
        bad = bad or not result["ok"]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
