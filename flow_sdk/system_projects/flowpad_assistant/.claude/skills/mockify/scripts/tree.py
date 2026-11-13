"""The mock tree: screens (nodes), actions (edges), vars (state) -- validated, then compiled into the one DFS walk.

    python3 -I tree.py validate     <row.json>    # problems, one per line; exit 1 when there are any
    python3 -I tree.py show         <row.json>    # the tree, indented: the step table the reviewer gets
    python3 -I tree.py compile      <row.json>    # the compiled tree (JSON): MOCKIFY.tree for a hand-written fast mock
    python3 -I tree.py from-journey <row.json>    # a legacy `journey` as a tree (JSON), to paste into the row

A screen's PARENT is the one action of kind main / branch / alt that points at it. A screen's children are its
branch and alt actions in the order written, then its main action last. The walk is DFS preorder from `root`:
Next is the next screen in that order, Back the previous, Reset the root. Nothing else decides navigation.

An action may `set` vars ("desk=on"); a screen's state is the vars' initial values plus every `set` on the way to
it. A screen may assert its `state`; a `jump` must land on a screen whose state is the one it leaves with.

Pure Python, no browser, milliseconds. `build_mock.py` refuses a tree with problems.
"""

from __future__ import annotations

import json
import pathlib
import re
import sys

TREE_KINDS = ("main", "branch", "alt")     # the edges that make the tree; "jump" goes to a screen that has a parent
KINDS = (*TREE_KINDS, "jump")
# The device presets are data (assets/devices.json): add a device there, not here.
PRESETS = json.loads((pathlib.Path(__file__).resolve().parent.parent / "assets" / "devices.json").read_text())
DEVICES = ("desktop", *PRESETS)
BAR_NEXT = "next"                          # the id of an action with no control on the screen: the bar's own Next


def mock_input(row: dict) -> dict:
    return row.get("input", row)


def load_row(row_path: str) -> dict:
    """The mock row's value from a file: the value itself, a row with `input`, or `DM ds-rows` output."""
    row = json.loads(pathlib.Path(row_path).read_text(encoding="utf-8"))
    if isinstance(row, dict) and "rows" in row:
        row = row["rows"]
    if isinstance(row, list):
        row = row[0] if row else {}
    return mock_input(row)


def tree_of(row: dict) -> dict:
    """The mock's tree: its own, or its legacy journey converted."""
    mock = mock_input(row)
    return mock.get("tree") or from_journey(mock)


def _pairs(items, where: str, problems: list) -> dict:
    out = {}
    for item in items or []:
        name, eq, value = str(item).partition("=")
        if not eq or not name.strip():
            problems.append(f"{where}: {item!r} is not `var=value`")
            continue
        out[name.strip()] = value.strip()
    return out


def _slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:32]


# ── validate + compile: one pass over the same structure ──

def _walk(tree: dict, mock: dict, problems: list) -> list:
    """The screens in DFS order, each with num / depth / parent / via / state. Fills `problems`."""
    screens = tree.get("screens") or []
    personas = {p.get("id") for p in mock.get("personas") or []}
    by_id: dict = {}
    for s in screens:
        sid = s.get("id")
        if not sid or not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", str(sid)):
            problems.append(f"screen id {sid!r}: lower-case letters, digits, - and _ only")
        elif sid in by_id:
            problems.append(f"{sid}: two screens have this id")
        else:
            by_id[sid] = s
    root = tree.get("root")
    if root not in by_id:
        problems.append(f"root {root!r} is not a screen")
        return []

    declared, initial = {}, {}
    for v in tree.get("vars") or []:
        name, values = v.get("name"), list(v.get("values") or [])
        if not name or name in declared:
            problems.append(f"var {name!r}: missing or declared twice")
            continue
        if v.get("initial") not in values:
            problems.append(f"var {name}: initial {v.get('initial')!r} is not one of {values}")
        declared[name] = values
        initial[name] = v.get("initial")

    def assigns(items, where):
        got = _pairs(items, where, problems)
        for name, value in got.items():
            if name not in declared:
                problems.append(f"{where}: no var {name!r} (declared: {sorted(declared) or 'none'})")
            elif value not in declared[name]:
                problems.append(f"{where}: {name}={value!r} is not one of {declared[name]}")
        return got

    parent: dict = {}     # screen id -> its parent's id
    kids: dict = {}       # screen id -> the tree actions that leave it, as written
    whose: dict = {}      # screen id -> (persona, device), the mock's defaults filled in -- resolved once, here
    for sid, s in by_id.items():
        if s.get("tag") not in (None, "existing", "new"):
            problems.append(f"{sid}: tag {s.get('tag')!r} is not existing | new")
        who, device = s.get("persona") or mock.get("persona") or "", s.get("device") or mock.get("device") or "desktop"
        whose[sid] = (who, device)
        if device not in DEVICES:
            problems.append(f"{sid}: device {device!r} is not one of {list(DEVICES)}")
        if who and who not in personas:
            problems.append(f"{sid}: persona {who!r} is not one of the mock's personas {sorted(personas)}")
        elif not who and len(personas) > 1:
            problems.append(f"{sid}: names no persona -- the mock has several, so every screen says whose it is")
        if s.get("tag") == "new" and s.get("changes"):
            problems.append(f"{sid}: a new screen carries no `changes` -- everything on it is new")
        seen_actions, mains = set(), 0
        for a in s.get("actions") or []:
            aid, where = a.get("id"), f"{sid}.{a.get('id')}"
            if not aid or aid in seen_actions:
                problems.append(f"{sid}: action id {aid!r} is missing or used twice")
            seen_actions.add(aid)
            to, kind = a.get("to"), a.get("kind")
            if not to:
                if kind or a.get("set"):
                    problems.append(f"{where}: an action with no `to` has no kind and sets nothing")
                continue
            if to not in by_id:
                problems.append(f"{where}: goes to {to!r}, which is not a screen")
                continue
            if kind not in KINDS:
                problems.append(f"{where}: kind {kind!r} is not one of {list(KINDS)}")
                continue
            if kind == "branch" and not a.get("when"):
                problems.append(f"{where}: a branch says `when` it happens")
            if kind == "main":
                mains += 1
            if kind in TREE_KINDS:
                if to == root:
                    problems.append(f"{where}: the root has no parent -- make this a jump")
                elif to in parent:
                    problems.append(f"{to}: two parents ({parent[to]} and {sid}) -- keep one, make the other a jump")
                else:
                    parent[to] = sid
                    kids.setdefault(sid, []).append(a)
        if mains > 1:
            problems.append(f"{sid}: {mains} main actions -- a screen continues one way; the others are branches")
        changes = s.get("changes") or []
        ids = [c.get("id") for c in changes]
        if len(set(ids)) != len(ids):
            problems.append(f"{sid}: a change id is used twice")
        opened = {c.get("to") for c in changes if (c.get("mode") or "place") == "screen"}
        alts = {a.get("to") for a in s.get("actions") or [] if a.get("kind") == "alt"}
        for missing in sorted(x for x in opened - alts if x):
            problems.append(f"{sid}: a change opens {missing!r} but no alt action goes there")
        for extra in sorted(x for x in alts - opened if x):
            problems.append(f"{sid}: an alt action goes to {extra!r} but no change (mode screen) opens it")

    order: list = []

    def number(label: str, action: dict, k: int) -> str:
        if action["kind"] != "main":
            return f"{label}{chr(ord('a') + k) if k < 26 else f'-{k}'}"
        head = re.fullmatch(r"(.*?)(\d+)", label)
        return f"{head.group(1)}{int(head.group(2)) + 1}" if head else f"{label}.2"

    stack = [(root, "1", 0, None, None, dict(initial))]
    visited = set()
    while stack:
        sid, num, depth, up, via, state = stack.pop()
        if sid in visited:   # only a cycle of tree edges can do this; two-parents is already reported
            continue
        visited.add(sid)
        s = by_id[sid]
        own = assigns(s.get("state"), f"{sid}.state")
        for name, value in own.items():
            if name in state and state[name] != value:
                problems.append(f"{sid}: asserts {name}={value} but the way here leaves {name}={state[name]}")
        order.append({**s, "persona": whose[sid][0], "device": whose[sid][1],
                      "num": num, "depth": depth, "parent": up, "via": via and via.get("id"),
                      "via_kind": via["kind"] if via else "root", "when": via.get("when") if via else None, "state": state})
        frames, side = [], 0
        for a in sorted(kids.get(sid, []), key=lambda a: a["kind"] == "main"):   # branches and alts as written, main last
            is_side = a["kind"] != "main"
            frames.append((a["to"], number(num, a, side), depth + is_side, sid, a,
                           {**state, **assigns(a.get("set"), f"{sid}.{a.get('id')}.set")}))
            side += is_side
        stack.extend(reversed(frames))

    for sid in by_id:
        if sid not in visited:
            problems.append(f"{sid}: not reachable from the root -- no main, branch or alt action leads to it")
    state_at = {n["id"]: n["state"] for n in order}
    for n in order:
        for a in n.get("actions") or []:
            if a.get("kind") == "jump" and a.get("to") in state_at:
                leaves = {**n["state"], **_pairs(a.get("set"), "", [])}
                lands = state_at[a["to"]]
                diff = sorted(k for k in leaves if leaves[k] != lands.get(k))
                if diff:
                    problems.append(f"{n['id']}.{a.get('id')}: jumps to {a['to']} with {', '.join(f'{k}={leaves[k]}' for k in diff)}, "
                                    f"but that screen is at {', '.join(f'{k}={lands.get(k)}' for k in diff)}")
    for n in order[:-1]:
        if not any(a.get("to") for a in n.get("actions") or []):
            problems.append(f"{n['id']}: no action goes anywhere -- a dead end before the last screen")
    return order


def check(row: dict) -> tuple:
    """(compiled tree, problems) in one walk. The compiled tree is what the page carries: the screens in DFS order
    with number, depth, parent, persona, device and state. Use it only when `problems` is empty."""
    tree, problems = tree_of(row), []
    order = _walk(tree, mock_input(row), problems)
    return {"root": tree.get("root"), "vars": tree.get("vars") or [], "screens": order}, list(dict.fromkeys(problems))


def validate(row: dict) -> list:
    """Every problem in the mock's tree, as one line each; [] when it is sound."""
    return check(row)[1]


def compile_tree(row: dict) -> dict:
    """The compiled tree. Raises on a bad tree."""
    compiled, problems = check(row)
    if problems:
        raise ValueError("the mock tree has problems:\n  - " + "\n  - ".join(problems))
    return compiled


def as_journey(row: dict) -> list:
    """The compiled screens in the legacy step shape (`branch_of`, `when`, `controls`, `next`) -- for test_md.py,
    which writes one test per path."""
    steps = []
    for n in compile_tree(row)["screens"]:
        side = n["via_kind"] in ("branch", "alt")
        jump = next((a["to"] for a in n.get("actions") or [] if a.get("kind") == "jump"), None)
        steps.append({**n, "branch_of": n["parent"] if side else None, "next": jump if side else None,
                      "controls": [{"label": a.get("label"), "does": a.get("does"), "next": a.get("to")}
                                   for a in n.get("actions") or [] if a.get("id") != BAR_NEXT]})
    return steps


# ── a legacy journey, as a tree ──

def from_journey(mock: dict) -> dict:
    """`journey` (mockify.step) -> tree. Array order is the main chain; `branch_of` a branch; a change that opens
    a screen an alt; `next` and any other control with `next` a jump; `path: suggested` the tag `new`."""
    journey = mock.get("journey") or []
    ids = [s["id"] for s in journey]
    alt_of = {c["to"]: s["id"] for s in journey for c in s.get("changes") or []
              if (c.get("mode") or "place") == "screen" and c.get("to") in ids}
    chain = [s["id"] for s in journey if not s.get("branch_of") and s["id"] not in alt_of]
    child_kind = {(a, b): ("main", None) for a, b in zip(chain, chain[1:])}   # (parent, child) -> (kind, when)
    child_kind.update({(s["branch_of"], s["id"]): ("branch", s.get("when") or "otherwise")
                       for s in journey if s.get("branch_of") in ids and s["id"] not in alt_of})
    child_kind.update({(par, child): ("alt", None) for child, par in alt_of.items()})

    screens = []
    for s in journey:
        sid, actions, used, taken = s["id"], [], set(), set()

        def add(label, does, to=None, kind=None, when=None, aid=None):
            aid = aid or _slug(label) or "a"
            base, n = aid, 1
            while aid in used:
                n += 1
                aid = f"{base}-{n}"
            used.add(aid)
            action = {"id": aid, "label": label, "does": does}
            if to:
                action.update(to=to, kind=kind)
                if when:
                    action["when"] = when
            actions.append(action)

        for c in s.get("controls") or []:
            to, label, does = c.get("next"), c.get("label") or c.get("next") or "control", c.get("does") or ""
            if to in ids and (sid, to) in child_kind and to not in taken:
                taken.add(to)
                add(label, does, to, *child_kind[(sid, to)])
            elif to in ids:
                add(label, does, to, "jump")
            else:
                add(label, does)
        for (par, child), (kind, when) in child_kind.items():
            if par == sid and child not in taken:   # no control leads there: the bar's Next, a branch pin, a change card
                label = "Next" if kind == "main" else (when or "opens the suggestion")
                add(label, "goes on" if kind == "main" else label, child, kind, when,
                    aid=BAR_NEXT if kind == "main" else f"{kind}-{child}")
        if s.get("next") in ids and all(a.get("to") != s["next"] for a in actions):
            add("goes on", "goes on", s["next"], "jump", aid=f"to-{s['next']}")

        screen = {k: s[k] for k in ("id", "app", "title", "persona", "device", "scenario", "source", "note", "expect", "url") if s.get(k)}
        screen["tag"] = "new" if s.get("path") == "suggested" else "existing"
        screen["actions"] = actions
        screen["changes"] = [] if screen["tag"] == "new" else list(s.get("changes") or [])
        screen["decisions"] = list(s.get("decisions") or [])
        screens.append(screen)
    return {"root": ids[0] if ids else "", "vars": [], "screens": screens}


def show(compiled: dict) -> str:
    lines = []
    for n in compiled["screens"]:
        goes = ", ".join(f"{a['label']} → {a['to']}" + (f" [{a['kind']}]" if a["kind"] != "main" else "")
                         for a in n.get("actions") or [] if a.get("to"))
        state = " ".join(f"{k}={v}" for k, v in n["state"].items())
        when = f"({n['when']}) " if n.get("when") else ""
        lines.append(f"{'  ' * n['depth']}{n['num']:<6} {when}{n['title']}  ·  {n.get('persona') or '-'}  ·  {n.get('tag') or 'existing'}"
                     + (f"  ·  {state}" if state else "") + (f"\n{'  ' * n['depth']}       ↳ {goes}" if goes else ""))
    return "\n".join(lines)


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in ("validate", "show", "compile", "from-journey"):
        sys.exit(__doc__)
    row = load_row(sys.argv[2])
    if sys.argv[1] == "from-journey":
        print(json.dumps(from_journey(row), indent=1, ensure_ascii=False))
        return
    compiled, problems = check(row)
    if problems:
        print("\n".join(f"- {p}" for p in problems))
        sys.exit(1)
    print({"compile": lambda: json.dumps(compiled, ensure_ascii=False), "show": lambda: show(compiled),
           "validate": lambda: f"OK: {len(compiled['screens'])} screens"}[sys.argv[1]]())


if __name__ == "__main__":
    main()
