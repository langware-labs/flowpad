"""Check a skill's flowmap, and whether it is still the map of the skill on disk.

Usage:
  python3 -I map_check.py check <skill dir>     # the map's problems, by name; exit 1 on any; prints OK otherwise
  python3 -I map_check.py stale <skill dir>     # exit 0 = fresh, 3 = the skill changed since the map, 4 = no map
  python3 -I map_check.py stamp <skill dir>     # write the skill's current source_hash into the map (after check passes)

The map is `<skill dir>/flowmap/map.value.json`: a `flowmap.map` value with `"spec_kind": "flowmap.map"`.
check: ids unique and named; every link names real nodes (from an entry or step, to a step or outcome); every
step is reached from an entry and goes on somewhere; every entry leads somewhere; a forward cycle that is not
marked `loop` (the viewer could not lay it out top to bottom); a step type outside instructions|code|screen.
"""

import hashlib
import json
import os
import pathlib
import sys

MAP = pathlib.Path("flowmap") / "map.value.json"
TYPES = {"instructions", "code", "screen"}
SKIP = {"flowmap", "__pycache__", ".flow", "node_modules", ".git"}


def source_hash(skill: pathlib.Path) -> str:
    """The skill's own files, in a stable order — the map is not part of it."""
    files = []
    for root, dirs, names in os.walk(skill):
        dirs[:] = [d for d in dirs if d not in SKIP and not d.startswith(".")]   # prune, never walk node_modules
        files += [pathlib.Path(root, n) for n in names if not n.startswith(".")]
    h = hashlib.sha256()
    for f in sorted(files):
        h.update(str(f.relative_to(skill)).encode() + b"\0" + f.read_bytes() + b"\0")
    return h.hexdigest()[:16]


def problems(m: dict) -> list[str]:
    out: list[str] = []
    if m.get("spec_kind") != "flowmap.map":
        out.append(f"spec_kind is {m.get('spec_kind')!r}, not 'flowmap.map'")
    kinds: dict[str, str] = {}
    for kind, items in (("entry", m.get("entries")), ("step", m.get("steps")), ("outcome", m.get("outcomes"))):
        if not items:
            out.append(f"no {kind} — a map has at least one entry, step and outcome")
        for it in items or []:
            nid = it.get("id")
            if not nid:
                out.append(f"a {kind} has no id: {it}")
            elif nid in kinds:
                out.append(f"{nid}: used twice ({kinds[nid]} and {kind})")
            else:
                kinds[nid] = kind
    for s in m.get("steps") or []:
        if s.get("type") not in TYPES:
            out.append(f"{s.get('id')}: type {s.get('type')!r} is not one of {sorted(TYPES)}")
    fwd: dict[str, list[str]] = {n: [] for n in kinds}
    for ln in m.get("links") or []:
        a, b = ln.get("from"), ln.get("to")
        where = f"link {a} → {b}"
        if kinds.get(a) not in ("entry", "step"):
            out.append(f"{where}: from {a!r}, which is not an entry or a step")
        elif kinds.get(b) not in ("step", "outcome"):
            out.append(f"{where}: to {b!r}, which is not a step or an outcome")
        elif not ln.get("loop"):
            fwd[a].append(b)
    has_out = {ln.get("from") for ln in m.get("links") or []}
    reached, todo = set(), [n for n, k in kinds.items() if k == "entry"]
    while todo:
        n = todo.pop()
        if n not in reached:
            reached.add(n)
            todo += fwd.get(n, [])
    for n, k in kinds.items():
        if k in ("step", "outcome") and n not in reached:
            out.append(f"{n}: no entry leads to it")
        if k in ("entry", "step") and n not in has_out:
            out.append(f"{n}: leads nowhere — link it on to a step or an outcome")
    state: dict[str, int] = {}

    def visit(n: str, path: list[str]) -> None:
        state[n] = 1
        for nxt in fwd.get(n, []):
            if state.get(nxt) == 1:
                out.append(f"{' → '.join(path + [n, nxt])}: a cycle — mark the link that goes back `loop: true`")
            elif not state.get(nxt):
                visit(nxt, path + [n])
        state[n] = 2

    for n in kinds:
        if not state.get(n):
            visit(n, [])
    return out


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in ("check", "stale", "stamp"):
        sys.exit(__doc__)
    cmd, skill = sys.argv[1], pathlib.Path(sys.argv[2]).expanduser().resolve()
    path = skill / MAP
    if not path.is_file():
        print(json.dumps({"ok": False, "map": str(path), "error": "no map yet — run flowmap map"}))
        sys.exit(4 if cmd == "stale" else 1)
    m = json.loads(path.read_text(encoding="utf-8"))
    if cmd == "check":
        bad = problems(m)
        print("\n".join(bad) if bad else f"OK: {len(m['entries'])} entries, {len(m['steps'])} steps, "
              f"{len(m['links'])} links, {len(m['outcomes'])} outcomes")
        sys.exit(1 if bad else 0)
    now = source_hash(skill)
    if cmd == "stale":
        fresh = m.get("source_hash") == now
        print(json.dumps({"ok": True, "fresh": fresh, "map": str(path), "map_hash": m.get("source_hash"), "skill_hash": now}))
        sys.exit(0 if fresh else 3)
    bad = problems(m)
    if bad:
        sys.exit("refusing to stamp a map with problems:\n" + "\n".join(bad))
    m["source_hash"] = now
    path.write_text(json.dumps(m, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "map": str(path), "source_hash": now}))


if __name__ == "__main__":
    main()
