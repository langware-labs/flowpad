"""The build list: what an APPROVED mock owes the product, in the order it is built and tested.

    python3 -I build_list.py make   <row.json> --feedback <rows.json> [--html <index.html>] [--existing <items.json>]
    python3 -I build_list.py show   <items.json>
    python3 -I build_list.py next   <items.json>
    python3 -I build_list.py set    <items.json> <n> <status> [--where TEXT] [--note TEXT] [--shot FILE]
    python3 -I build_list.py report <items.json>

`make` turns the mock row into one item per thing owed -- in the tree's walk order, per screen: the screen itself,
its state, each change, each decision, each action that goes somewhere. It refuses a mock that is not `approved`,
a tree with problems, and a comment nobody answered. A rejected change is not an item. With `--existing` (a
re-approval after a redraw) an item whose mock content did not change keeps its status; a changed or new one
starts again at `todo`. It prints the rows (the summary goes to stderr): pipe them into
`DM ds-sync <mock-build dataset> - --match '{"input.mock": "<mock ref>"}'`, which also drops what the mock no longer has.

`show` prints the list as a checklist. `next` names the one item to work on now. `set` prints one item's new
state as a one-row list -- pipe it into `DM ds-put-many <mock-build dataset> -` -- and
refuses what the order forbids: an item on a later screen while an earlier screen is not finished, `matches`
with no screenshot, `differs` / `not_checked` / `flagged` with no note. `report` prints the table the person
checks and exits 1 until every item is `matches` or `not_checked`. A refusal is one line on stderr, exit 1, and
nothing on stdout.

`<row.json>`, `<rows.json>` and `<items.json>` are `DM ds-rows` output. Pure Python, no browser, milliseconds.
"""

from __future__ import annotations

import base64
import hashlib
import json
import mimetypes
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import tree  # noqa: E402

STATUSES = ("todo", "built", "matches", "differs", "not_checked", "flagged")
DONE = ("matches", "not_checked")            # an item in one of these needs no more work
NEEDS_NOTE = ("differs", "not_checked", "flagged")
PLAIN_VERDICT = re.compile(r"^(yes|no|approved|rejected)?$", re.I)


class Refused(ValueError):
    """The list cannot be made, or the step is not allowed. The message says why."""


def _sig(*parts) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def sections(html: str) -> dict:
    """Each screen's own HTML (`<section data-step="id">` up to the next one), so a redrawn screen changes its sig.
    The last screen ends at the page's last `</section>`: what follows is the journey bar, not a drawing."""
    marks = [(m.start(), m.group(1)) for m in re.finditer(r"<section\b[^>]*\bdata-step=\"([^\"]+)\"", html)]
    ends = [start for start, _ in marks[1:]] + [html.rfind("</section>") + len("</section>")]
    return {sid: html[start:end] for (start, sid), end in zip(marks, ends)}


def _votes(comments: list) -> dict:
    """(step, change) -> the reviewer's latest verdict on that change. `comments` are feedback values."""
    latest: dict = {}
    for f in sorted(comments, key=lambda f: f.get("created") or ""):
        if f.get("change"):
            latest[(f.get("step"), f["change"])] = f
    return latest


def unanswered(comments: list) -> list:
    """The comments that still wait for the builder: not addressed, and saying something. A verdict with no words
    (Approved / Yes / the option picked) asks nothing. The SAME rule as the bar's `waitingRows` (journey-bar.js):
    change one, change the other."""
    out = []
    for f in comments:
        text = (f.get("text") or "").strip()
        plain_vote = f.get("change") and (PLAIN_VERDICT.match(text) or text == (f.get("choice") or None))
        if f.get("status") != "addressed" and not plain_vote:
            out.append(f"{f.get('step')}: {text[:80]}")
    return out


def make(row: dict, feedback: list, html: str = "", existing: list | None = None) -> dict:
    """The mock row (with its `key` and `ref`) -> {rows, not_built}. Raises Refused."""
    mock, comments = tree.mock_input(row), [tree.mock_input(r) for r in feedback]
    key, ref = row.get("key"), row.get("ref")
    if not key or not ref:
        raise Refused("the mock row has no key / ref -- pass the `DM ds-rows` output, not the bare value")
    if mock.get("status") != "approved":
        raise Refused(f"the mock is {mock.get('status')!r}, not approved -- only an approved mock has a build list")
    compiled, problems = tree.check(mock)
    if problems:
        raise Refused("the mock tree has problems:\n  - " + "\n  - ".join(problems))
    waiting = unanswered(comments)
    if waiting:
        raise Refused(f"{len(waiting)} comment(s) are not addressed -- answer them on the mock first:\n  - " + "\n  - ".join(waiting))

    votes, html_of = _votes(comments), sections(html)
    answers = {f["decision"]: f for f in comments if f.get("decision")}
    by_id = {n["id"]: n for n in compiled["screens"]}
    items, not_built = [], []

    def add(kind, n, ref_id, title, *content):
        items.append({"kind": kind, "step": n["id"], "ref": ref_id, "title": title, "sig": _sig(kind, n["id"], ref_id, title, *content)})

    for n in compiled["screens"]:
        label = f"Screen {n['num']} \"{n['title']}\""
        add("screen", n, None, f"{label}: the same place in the product, the same layout, controls and words as the mock",
            n.get("scenario"), n.get("note"), n.get("tag"), n.get("persona"), n.get("device"), html_of.get(n["id"]))
        if n["state"]:
            add("state", n, None, f"{label}: reached for real with " + ", ".join(f"{k}={v}" for k, v in n["state"].items()))
        for c in n.get("changes") or []:
            vote = votes.get((n["id"], c["id"])) or {}
            if vote.get("vote") == "no":
                not_built.append(f"{n['num']} {c['id']} \"{c.get('title')}\": rejected")
                continue
            picked = f" -- option picked: {vote['choice']}" if vote.get("choice") else ""
            add("change", n, c["id"], f"{label}: change {c['id']} \"{c.get('title')}\"{picked}", c, vote.get("choice"))
        for d in n.get("decisions") or []:
            answer = (answers.get(d["id"]) or {}).get("text")
            says = f"answered: {answer}" if answer else f"not answered -- build what the mock shows ({d.get('shown') or 'as drawn'})"
            add("decision", n, d["id"], f"{label}: decision {d['id']} \"{d.get('question')}\" {says}", d, answer)
        for a in n.get("actions") or []:
            to = by_id.get(a.get("to"))
            if not to:
                continue
            control = "the journey continues" if a.get("id") == tree.BAR_NEXT else f"\"{a.get('label')}\""
            kind = "" if a.get("kind") == "main" else f" [{a.get('kind')}{': ' + a['when'] if a.get('when') else ''}]"
            add("action", n, a.get("id"), f"{label}: {control} goes to {to['num']} \"{to['title']}\"{kind}", a)

    kept = {}
    for old in existing or []:
        i = tree.mock_input(old)
        kept[(i.get("kind"), i.get("step"), i.get("ref"))] = i
    rows = []
    for k, item in enumerate(items, start=1):
        old = kept.get((item["kind"], item["step"], item["ref"])) or {}
        # Where it lives rarely moves with a redraw, so it is always kept; the proof is kept only for unchanged content.
        keep = ("where", "status", "note", "shot") if old.get("sig") == item["sig"] else ("where",)
        carried = {f: old[f] for f in keep if old.get(f) is not None}
        rows.append({"key": f"{key}-{k:03d}", "input": {"mock": ref, "n": k, "status": "todo", **item, **carried}})
    return {"rows": rows, "not_built": not_built}


def _items(rows: list) -> list:
    return sorted(({"key": r.get("key"), **tree.mock_input(r)} for r in rows), key=lambda i: i.get("n") or 0)


def _open(item: dict) -> bool:
    return item.get("status") not in DONE


def _unproven(item: dict) -> str | None:
    """What a status still lacks to stand: `matches` its screenshot, the others their note. None when it stands."""
    status = item.get("status")
    if status == "matches" and not item.get("shot"):
        return "`matches` needs the screenshot of the built product (--shot)"
    if status in NEEDS_NOTE and not (item.get("note") or "").strip():
        return f"`{status}` needs a note saying what or why (--note)"
    return None


def show(rows: list) -> str:
    mark = {"todo": " ", "built": "~", "matches": "x", "not_checked": "-", "differs": "!", "flagged": "?"}
    return "\n".join(f"[{mark.get(i.get('status'), ' ')}] {i['n']:>3}  {i['title']}" + (f"  @ {i['where']}" if i.get("where") else "")
                     for i in _items(rows))


def next_item(rows: list) -> dict | None:
    """The first item that still needs work: the one thing to do now."""
    return next((i for i in _items(rows) if _open(i)), None)


def set_item(rows: list, n: int, status: str, where: str | None = None, note: str | None = None,
             shot: str | None = None) -> dict:
    """One item's new state, as the row to put. Raises Refused when the order or the proof is missing."""
    items = _items(rows)
    item = next((i for i in items if i.get("n") == n), None)
    if not item:
        raise Refused(f"no item {n}")
    if status not in STATUSES:
        raise Refused(f"status {status!r} is not one of {list(STATUSES)}")
    steps = list(dict.fromkeys(i["step"] for i in items))
    if status in ("built", "matches"):
        behind = [i for i in items if steps.index(i["step"]) < steps.index(item["step"]) and _open(i)]
        if behind:
            raise Refused(f"item {behind[0]['n']} ({behind[0]['title']}) is on an earlier screen and still "
                          f"{behind[0].get('status')} -- finish that screen first")
    new = {k: v for k, v in item.items() if k != "key"}
    new["status"] = status
    if where is not None:
        new["where"] = where
    if note is not None:
        new["note"] = note
    if shot:
        data = pathlib.Path(shot).read_bytes()
        new["shot"] = f"data:{mimetypes.guess_type(shot)[0] or 'image/png'};base64,{base64.b64encode(data).decode()}"
    if status in ("built", "matches") and not new.get("where"):
        raise Refused(f"item {n}: say where the product carries it (--where) before it is {status}")
    if _unproven(new):
        raise Refused(f"item {n}: {_unproven(new)}")
    if status not in NEEDS_NOTE:
        new.pop("note", None)
    return {"key": item["key"], "input": new}


def report(rows: list) -> tuple:
    """(the table, the reasons it is not done). Done only when the second is empty."""
    items, blocking = _items(rows), []
    lines = ["| # | mock item | where in the product | result |", "|---|---|---|---|"]
    for i in items:
        status, note = i.get("status"), (i.get("note") or "").strip()
        result = {"matches": "matches", "differs": f"differs: {note}", "not_checked": f"not checked: {note}",
                  "flagged": f"flagged: {note}"}.get(status, status)
        lines.append(f"| {i['n']} | {i['title']} | {i.get('where') or '-'} | {result} |")
        if _open(i) or _unproven(i):
            blocking.append(f"{i['n']}: {_unproven(i) or status}")
    if not items:
        blocking.append("the build list is empty")
    return "\n".join(lines), blocking


def _flag(args: list, name: str) -> str | None:
    if name in args:
        k = args.index(name)
        value = args[k + 1] if k + 1 < len(args) else sys.exit(f"{name} needs a value")
        del args[k:k + 2]
        return value
    return None


def main() -> None:
    args = sys.argv[1:]
    if not args or args[0] not in ("make", "show", "next", "set", "report"):
        sys.exit(__doc__)
    cmd = args.pop(0)
    try:
        if cmd == "make":
            feedback, html, existing = _flag(args, "--feedback"), _flag(args, "--html"), _flag(args, "--existing")
            if len(args) != 1 or feedback is None:
                sys.exit(__doc__)
            made = make((tree.load_rows(args[0]) or [{}])[0], tree.load_rows(feedback),
                        pathlib.Path(html).read_text(encoding="utf-8") if html else "", tree.load_rows(existing) if existing else None)
            print(json.dumps(made["rows"], ensure_ascii=False))
            left = sum(1 for r in made["rows"] if r["input"]["status"] not in DONE)
            print(f"{len(made['rows'])} items, {left} to do" + "".join(f"\nnot built: {n}" for n in made["not_built"]), file=sys.stderr)
        elif cmd == "show":
            print(show(tree.load_rows(args[0])))
        elif cmd == "next":
            item = next_item(tree.load_rows(args[0]))
            print(json.dumps({"ok": True, "next": item and {k: v for k, v in item.items() if k != "shot"}}, ensure_ascii=False))
        elif cmd == "set":
            where, note, shot = _flag(args, "--where"), _flag(args, "--note"), _flag(args, "--shot")
            if len(args) != 3:
                sys.exit(__doc__)
            print(json.dumps([set_item(tree.load_rows(args[0]), int(args[1]), args[2], where, note, shot)], ensure_ascii=False))
        else:
            table, blocking = report(tree.load_rows(args[0]))
            print(table)
            if blocking:
                print(f"\nNOT DONE -- {len(blocking)} item(s):\n" + "\n".join(f"- {b}" for b in blocking))
                sys.exit(1)
            print("\nDONE: every item matches the mock or is marked not checked with its reason.")
    except Refused as exc:
        print(f"REFUSED: {exc}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
