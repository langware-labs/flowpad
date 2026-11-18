"""Phase 3: check a built mock against its plan. Prints PASS/FAIL per step; exit 1 on any FAIL.

Usage:
  uv run --with playwright python -I validate_mock.py <mock-dir>/index.html --row <mock-row.json> [--shots <dir>]
  (first time on a machine: uv run --with playwright python -m playwright install chromium)

First the mock tree itself (scripts/tree.py validate: structure, vars, reachability) -- no browser.
Then the page opens from disk as built (it carries its compiled tree; feedback is off). Per screen, in DFS order:
  - the screen exists ([data-step="<id>"]) and is not empty;
  - its visible text is not the same as another step's (the "one base screen" bug);
  - no red tweak banner (a states.js selector that missed);
  - every action with `to` is on it as data-next, and clicking it shows that screen; every data-next on it is one
    of its actions; a screen that is not the last has a way on (or declares the bar's Next: an action with id `next`);
  - every change (`changes`): a place change has its today element [data-change] on the screen (a removal may
    have an empty template; an addition a .mk-anchor), its <template data-change-after> when it is not a removal,
    and revealing it shows something; a screen change names an existing step in `to`;
  - EXISTING screens: in the default Diff view every change shows today (red) and the suggestion (green), each
    labelled, labels not on each other, nothing off the screen sideways (--shots also writes one crop per change
    with 120px of context: <n>-<step>-<change>.png); NEW screens (tag new) carry no marks;
  - at the display's size, the screen reaches the frame's bottom (no dead space under a zoomed 100vh layout); a phone
    step (`device`) is in its frame at its device size, 1:1.
The walk (window.mock): Next from the root visits every screen in the tree's order, Back returns the same way,
Reset lands on the root.
A test mock (test_md): every step captured, the first has a url, some step has an expect.
Whole page: no console errors, no missing file, nothing fetched from outside the file but /sdk/ and Google Fonts.
"""

import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))   # -I leaves the script's folder off the path
from build_mock import DEVICES  # noqa: E402
import tree as mock_tree  # noqa: E402
from tree import load_row  # noqa: E402

ALLOWED = ("file:", "data:", "blob:", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/")
SHOWN = "(id) => { const s = document.querySelector(`[data-step=\"${CSS.escape(id)}\"]`); return !!s && !s.hidden; }"
SCREEN = """(id) => {
  const s = document.querySelector(`[data-step="${CSS.escape(id)}"]`);
  if (!s) return null;
  return { text: s.innerText.replace(/\\s+/g, ' ').trim(), els: s.getElementsByTagName('*').length,
           error: [...s.querySelectorAll('[data-mockify-error]')].map((e) => e.textContent),
           next: [...s.querySelectorAll('[data-next]')].map((e) => e.dataset.next),
           tnext: [...s.querySelectorAll('template')].flatMap((t) => [...t.content.querySelectorAll('[data-next]')].map((e) => e.dataset.next)) };
}"""


CHANGE = """({sid, cid}) => {
  const s = document.querySelector(`[data-step="${CSS.escape(sid)}"]`), q = CSS.escape(cid);
  const t = s.querySelector(`template[data-change-after="${q}"]`);
  const els = [...s.querySelectorAll(`[data-change="${q}"]`)];
  return { els: els.length, tpl: !!t, removal: !!t && !t.innerHTML.trim(), onlyAnchor: els.length > 0 && els.every((e) => e.classList.contains('mk-anchor')) };
}"""


LAYERS = """(id) => {
  // dialogs open at once: overlays (backdrop / scrim / role=dialog) that are visible on this screen
  const s = document.querySelector(`[data-step="${CSS.escape(id)}"]`);
  const vis = (e) => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden]');
  // a backdrop CLASS, not Tailwind's backdrop-blur / supports-[backdrop-filter] utilities (every Flowpad footer has them)
  const scrim = (e) => [...e.classList].some((t) => /backdrop|modal-bg/.test(t) && !/^backdrop-|backdrop-filter/.test(t));
  const tops = [...s.querySelectorAll('[role=dialog],[aria-modal=true],[class*="backdrop"],[class*="modal-bg"]')]
    .filter((e) => e.matches('[role=dialog],[aria-modal=true]') || scrim(e)).filter(vis);
  return tops.filter((e) => !tops.some((o) => o !== e && o.contains(e))).length;
}"""
DIFF = """([id, cid]) => {
  // the change as the reviewer sees it in the default Diff view: today (red) and the suggestion (green),
  // both on screen with room around them, each with its label, no label on another one
  const s = document.querySelector(`[data-step="${CSS.escape(id)}"]`), q = CSS.escape(cid);
  const vis = (e) => e && e.getClientRects().length && e.getBoundingClientRect().width > 0;
  const was = [...s.querySelectorAll(`[data-change="${q}"]`)].find((e) => vis(e) && !e.classList.contains('mk-anchor'));
  const now = s.querySelector(`[data-mk-after="${q}"]`);
  const box = (e) => { if (!vis(e)) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top + scrollY, w: r.width, h: r.height }; };
  const labels = [...document.querySelectorAll(`.mk-dl[data-c="${q}"]`)].map((e) => e.getBoundingClientRect());
  const all = [...document.querySelectorAll('.mk-dl')].map((e) => e.getBoundingClientRect());
  const overlap = labels.some((a) => all.some((b) => b !== a && !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top) && !(a.left === b.left && a.top === b.top)));
  return { was: box(was), now: box(now), labels: labels.length, overlap, vw: innerWidth, removal: !!was && was.classList.contains('mk-removed') };
}"""
MARKS = "(id) => document.querySelector(`[data-step=\"${CSS.escape(id)}\"]`).querySelectorAll('[data-change],template[data-change-after]').length"
FILLS = """(id) => {
  // a full-height layout box left at the ZOOMED height (frame x zoom) ends above the frame: dead space under it
  const s = document.querySelector(`[data-step="${CSS.escape(id)}"]`), z = +s.style.zoom || 1;
  if (z >= 1) return [];
  const top = s.getBoundingClientRect().top, shrunk = innerHeight * z;
  return [...s.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.top - top <= 2 && Math.abs(r.height - shrunk) < 2; })
    .slice(0, 3).map((e) => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className ? '.' + String(e.className).trim().split(/\\s+/)[0] : '')));
}"""
REACH = """([id, cid]) => {
  // can the reviewer bring this change into view and see it on top? (a stretched dialog that cannot scroll fails)
  const s = document.querySelector(`[data-step="${CSS.escape(id)}"]`), q = CSS.escape(cid);
  const el = [...s.querySelectorAll(`[data-change="${q}"]`)].find((e) => e.getClientRects().length);
  if (!el) return true;
  el.scrollIntoView({ block: 'center' });
  const r = el.getBoundingClientRect();
  if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
  const x = Math.min(innerWidth - 1, Math.max(0, r.left + Math.min(r.width / 2, 20))), y = Math.min(innerHeight - 1, Math.max(0, r.top + Math.min(r.height / 2, 10)));
  const hit = document.elementFromPoint(x, y);
  return !!hit && (el.contains(hit) || hit.contains(el) || !!hit.closest('[data-mockify]'));
}"""
TOPMOST = """([id, to]) => {
  // the data-next control a person would click: the first one that is on top where it is drawn
  const els = [...document.querySelectorAll(`[data-step="${CSS.escape(id)}"] [data-next="${CSS.escape(to)}"]`)];
  for (let i = 0; i < els.length; i++) {
    const e = els[i]; if (!e.getClientRects().length) continue;
    e.scrollIntoView({ block: 'center' });
    const r = e.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (hit && (e.contains(hit) || hit.contains(e))) return i;
  }
  return els.length ? 0 : -1;
}"""


DISPLAY_WIDTH = 760
# A fitted screen keeps its captured width (wider than the frame) and is zoomed down to it; a phone step
# (data-device) is its device's width, framed, at 1:1 whenever the frame fits.
FIT = """(id) => {
  const s = document.querySelector(`[data-step="${CSS.escape(id)}"]`), scr = s.querySelector(':scope > .mk-device > .mk-screen');
  return { reflowed: parseFloat(getComputedStyle(s).width) <= innerWidth + 1, device: s.dataset.device || null,
           framed: !!scr, w: scr ? scr.offsetWidth : 0, h: scr ? scr.offsetHeight : 0, zoom: +s.style.zoom || 1,
           fits: s.getBoundingClientRect().width <= innerWidth + 1 };
}"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("page")
    ap.add_argument("--row", required=True)
    ap.add_argument("--shots", help="write one screenshot per step here")
    ap.add_argument("--steps", help="comma-separated step ids: check only these (a feedback round); whole-page checks still run. "
                                    "Run the full check before the first show.")
    a = ap.parse_args()

    row = load_row(a.row)
    compiled, tree_problems = mock_tree.check(row)   # the tree first: structure, vars, reachability (no browser needed)
    if tree_problems:
        sys.exit("validate_mock: the mock tree has problems (scripts/tree.py validate):\n  - " + "\n  - ".join(tree_problems))
    journey = compiled["screens"]   # the screens in DFS order
    if not journey:
        sys.exit("validate_mock: the mock tree has no screens")
    if not pathlib.Path(a.page).is_file():
        sys.exit(f"validate_mock: no page at {a.page}")
    ids = [s["id"] for s in journey]
    only = set(a.steps.split(",")) if a.steps else set(ids)
    if only - set(ids):
        sys.exit(f"validate_mock: --steps names no step: {sorted(only - set(ids))}")
    shots = pathlib.Path(a.shots) if a.shots else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)

    problems: dict[str, list[str]] = {i: [] for i in ids}
    if row.get("test_md"):   # mockify test: the current UI only, and something to check
        for s in journey:
            if str(s.get("source", "")).startswith("built"):
                problems[s["id"]].append("test mock: drawn, not captured -- the current UI does not have it")
        if not journey[0].get("url"):
            problems[ids[0]].append("test mock: the first step has no url")
        if not any(s.get("expect") for s in journey):
            problems[ids[0]].append("test mock: no step has an expect")
    walk_problems: list[str] = []
    errors: list[str] = []
    broken: set[str] = set()    # a file the page names that is not there
    outside: set[str] = set()   # anything fetched from beyond the file

    def own(url: str) -> bool:  # off Flowpad the SDK import fails by design (feedback off)
        return "/sdk/" in url

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.on("console", lambda m: m.type == "error" and not own((m.location or {}).get("url", "") + m.text)
                and not m.text.startswith("Failed to load resource") and errors.append(m.text))
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("requestfailed", lambda r: own(r.url) or broken.add(r.url))
        page.on("response", lambda r: r.status >= 400 and not own(r.url) and broken.add(r.url))
        page.on("request", lambda r: r.url.startswith(ALLOWED) or own(r.url) or outside.add(r.url))
        page.goto(pathlib.Path(a.page).resolve().as_uri() + "#" + ids[0])
        try:
            page.wait_for_function("typeof window.mockifyGo === 'function' && !!window.mock", timeout=5000)
        except Exception:  # noqa: BLE001
            sys.exit("validate_mock: the journey bar did not start (is journey-bar.js the last script?)")

        def show(step_id: str) -> bool:
            page.evaluate("(id) => window.mockifyGo(id)", step_id)
            return shown(step_id)

        def shown(step_id: str) -> bool:
            try:
                page.wait_for_function(SHOWN, arg=step_id, timeout=1500)
                return True
            except Exception:  # noqa: BLE001
                return False

        seen: dict[str, str] = {}   # screen text → the first step showing it
        for i, step in enumerate(journey):
            if step["id"] not in only:
                continue
            sid, bad = step["id"], problems[step["id"]]
            if not show(sid):
                bad.append("no screen: no [data-step] section for it, or it does not show")
                continue
            info = page.evaluate(SCREEN, sid)
            if info["els"] < 3 and not info["text"]:
                bad.append("the screen is empty")
            if info["text"] in seen:
                bad.append(f'same screen as "{seen[info["text"]]}" — nothing on it changed')
            seen.setdefault(info["text"], sid)
            bad += info["error"]
            bad += [f'data-next="{to}" names no step' for to in sorted(set(info["next"]) - set(ids))]
            for c in step.get("changes") or []:
                cid = c.get("id")
                chk = page.evaluate(CHANGE, {"sid": sid, "cid": cid})
                if (c.get("mode") or "place") == "screen":
                    if c.get("to") not in ids:
                        bad.append(f'change {cid}: mode screen, but to="{c.get("to")}" names no step')
                    if not chk["els"]:
                        bad.append(f'change {cid} "{c.get("title")}": no [data-change="{cid}"] — mark the element that leads to the new screen, or its pin floats at the edge')
                    continue
                if not chk["els"]:
                    bad.append(f'change {cid} "{c.get("title")}": no [data-change="{cid}"] on the screen')
                elif chk["onlyAnchor"] and chk["removal"]:
                    bad.append(f'change {cid} "{c.get("title")}": nothing visible changes (an anchor with an empty template) — a behaviour with no screen goes on the summary, not here')
                elif not chk["tpl"] and not chk["removal"] and not c.get("options"):
                    bad.append(f'change {cid}: no <template data-change-after="{cid}"> (an empty one marks a removal)')
            bad += [f'a revealed change has data-next="{to}", which names no step' for to in sorted(set(info["tnext"]) - set(ids))]
            if page.evaluate(LAYERS, sid) > 1:
                bad.append("a dialog opens over another dialog — the product closes the first one; build it over the page")
            for c in step.get("changes") or []:
                if (c.get("mode") or "place") != "screen" and not page.evaluate(REACH, [sid, c.get("id")]):
                    bad.append(f'change {c.get("id")} "{c.get("title")}": cannot be scrolled into view or is covered — keep the dialog\'s own scrolling')
            # EXISTING vs NEW: a new screen is all new and carries no annotation; an existing screen shows
            # every change as a diff — today and the suggestion, each visible, labelled and with room around it
            if step.get("tag") == "new":
                if page.evaluate(MARKS, sid):
                    bad.append("a NEW screen has [data-change] / <template data-change-after> marks — draw it as it would be, no annotation")
            else:
                for k, c in enumerate(step.get("changes") or []):
                    cid = c.get("id")
                    d = page.evaluate(DIFF, [sid, cid])
                    tag = f'change {cid} "{c.get("title")}"'
                    if (c.get("mode") or "place") == "screen":
                        if not d["labels"]:
                            bad.append(f"{tag}: no diff label on the control that opens the new screen")
                        continue
                    if not d["was"] and not d["now"]:
                        bad.append(f"{tag}: neither today nor the suggestion is visible in the Diff view")
                    if d["was"] and not d["now"] and not d["removal"]:
                        bad.append(f"{tag}: today is shown but the suggestion is not — fill its <template data-change-after>")
                    if d["labels"] < (1 if d["removal"] or not d["was"] else 2):
                        bad.append(f"{tag}: its diff labels are missing (− today / + suggestion)")
                    if d["overlap"]:
                        bad.append(f"{tag}: its label sits on another change's label — leave room between changes")
                    for name, b in (("today", d["was"]), ("suggestion", d["now"])):
                        if b and (b["x"] < 0 or b["x"] + b["w"] > d["vw"] + 1):
                            bad.append(f"{tag}: the {name} version runs off the screen sideways — it needs room around it")
                    if shots and (d["was"] or d["now"]):
                        boxes = [b for b in (d["was"], d["now"]) if b]
                        x0 = min(b["x"] for b in boxes) - 120
                        y0 = min(b["y"] for b in boxes) - 120
                        x1 = max(b["x"] + b["w"] for b in boxes) + 120
                        y1 = max(b["y"] + b["h"] for b in boxes) + 120
                        page.evaluate("(y) => window.scrollTo(0, Math.max(0, y))", y0)
                        page.wait_for_timeout(150)
                        sy = page.evaluate("() => scrollY")
                        clip = {"x": max(0, x0), "y": max(0, y0 - sy), "width": min(d["vw"], x1) - max(0, x0), "height": y1 - y0}
                        try:
                            page.screenshot(path=str(shots / f"{i + 1:02d}-{sid}-{cid}.png"), clip=clip)
                        except Exception:  # noqa: BLE001 — a clip past the page edge: the whole screen instead
                            page.screenshot(path=str(shots / f"{i + 1:02d}-{sid}-{cid}.png"))
            show(sid)
            page.evaluate("() => window.scrollTo(0, 0)")   # the screen shot from its top, after the per-change crops scrolled
            ways = info["next"] or info["tnext"] or any((c.get("mode") == "screen") for c in step.get("changes") or [])
            actions = [x for x in step.get("actions") or [] if x.get("to")]
            bar_only = any(x.get("id") == mock_tree.BAR_NEXT for x in actions)   # declared: only the bar's Next goes on
            if not ways and not bar_only and i < len(journey) - 1:
                bad.append("no data-next on it: a dead end for the reviewer")
            for to in sorted(set(info["next"]) - {x["to"] for x in actions}):
                if to in ids:
                    bad.append(f'data-next="{to}" is on the screen but none of its actions goes there -- add the action to the tree')
            if shots:
                page.screenshot(path=str(shots / f"{i + 1:02d}-{sid}.png"))

            for ctl in actions:
                to, label = ctl.get("to"), ctl.get("label")
                if ctl.get("id") == mock_tree.BAR_NEXT or ctl.get("kind") == "alt":   # the bar's Next; a change card
                    continue
                if to not in info["next"]:
                    bad.append(f'planned control "{label}" → {to}: no data-next="{to}" on the screen')
                    continue
                if not page.evaluate(SHOWN, sid):
                    show(sid)
                try:
                    k = page.evaluate(TOPMOST, [sid, to])
                    page.locator(f'[data-step="{sid}"] [data-next="{to}"]').nth(max(k, 0)).click(timeout=2000)
                except Exception as e:  # noqa: BLE001 — a click that fails is the step's problem
                    bad.append(f'"{label}" could not be clicked: {str(e).splitlines()[0]}')
                    continue
                if not shown(to):
                    bad.append(f'"{label}" → {to}: that screen did not show')

        # The walk: Next from the root visits every screen in the compiled DFS order, Back returns the same way,
        # Reset lands on the root -- what the reviewer's Next button does, through window.mock.
        if only == set(ids):
            walked = page.evaluate("""() => { const m = window.mock, f = [], b = []; m.reset(); f.push(m.current.id);
              while (m.canNext) { m.next(); f.push(m.current.id); }
              const shownAtEnd = [...document.querySelectorAll('[data-step]')].filter((e) => !e.hidden).map((e) => e.dataset.step);
              m.reset(); const reset = m.current.id; m.go(f[f.length - 1]);   // Reset from the far end, then back there
              b.push(m.current.id); while (m.canBack) { m.back(); b.push(m.current.id); }
              return { f, b, shownAtEnd, reset, next: m.next() && m.current.id }; }""")
            if walked["f"] != ids:
                walk_problems.append(f"Next does not walk the tree's order: {walked['f']} (expected {ids})")
            if walked["b"] != ids[::-1]:
                walk_problems.append(f"Back does not return the way Next came: {walked['b']}")
            if walked["shownAtEnd"] != ids[-1:]:
                walk_problems.append(f"after the last Next the screen shown is {walked['shownAtEnd']}, not {ids[-1]}")
            if walked["reset"] != ids[0] or (len(ids) > 1 and walked["next"] != ids[1]):
                walk_problems.append(f"Reset lands on {walked['reset']} and Next then on {walked['next']} (expected {ids[0]}, {ids[1:2]})")

        # The Flowpad display is about half a screen. A screen that reflows into it (laid out at the frame's
        # width instead of the captured one) loses its layout — the reviewer sees a near-empty page.
        page.set_viewport_size({"width": DISPLAY_WIDTH, "height": 700})
        for step in journey:
            sid = step["id"]
            if sid not in only:
                continue
            if not show(sid):
                continue
            fit = page.evaluate(FIT, sid)
            device = step["device"]
            if device in DEVICES:
                w, h = DEVICES[device]
                if not fit["framed"] or fit["device"] != device:
                    problems[sid].append(f"device {device}: the screen is not in its device frame — rebuild with build_mock.py")
                elif (fit["w"], fit["h"]) != (w, h):
                    problems[sid].append(f"device {device}: the screen is {fit['w']}x{fit['h']}, not {w}x{h}")
                elif fit["zoom"] != 1 or not fit["fits"]:
                    problems[sid].append(f"device {device}: shown at zoom {fit['zoom']:.2f}, not 1:1, in a {DISPLAY_WIDTH}px display")
            elif fit["reflowed"]:
                problems[sid].append(f"at the display's width ({DISPLAY_WIDTH}px) the screen reflows instead of "
                                     "scaling — build with --width <capture width>")
            # dead space: the zoomed screen's own 100vh layout must still reach the frame's bottom
            short = page.evaluate(FILLS, sid)
            if short:
                problems[sid].append(f"dead space under the screen: {', '.join(short)} keep the zoomed 100vh height and end "
                                     "above the frame — rebuild with build_mock.py (its fit stretches them; window.mockifyFit)")
            if shots:
                page.screenshot(path=str(shots / f"display-{sid}.png"))
        browser.close()

    page_problems = ([f"walk: {m}" for m in walk_problems] + [f"console: {m}" for m in errors[:10]] + [f"missing file: {u}" for u in sorted(broken)[:10]]
                     + [f"fetched from outside the file: {u}" for u in sorted(outside)[:10]])
    for sid in (i for i in ids if i in only):
        print(("FAIL " if problems[sid] else "PASS ") + sid)
        for p in problems[sid]:
            print("     - " + p)
    for p in page_problems:
        print("PAGE - " + p)
    failed = bool(page_problems) or any(problems.values())
    print("FAIL" if failed else "PASS")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
