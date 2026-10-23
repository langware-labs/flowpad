"""Phase 3: check a built mock against its plan. Prints PASS/FAIL per step; exit 1 on any FAIL.

Usage:
  uv run --with playwright python -I validate_mock.py <mock-dir>/index.html --row <mock-row.json> [--shots <dir>]
  (first time on a machine: uv run --with playwright python -m playwright install chromium)

The page opens from disk as built (it carries its journey; feedback is off). Per step:
  - the screen exists ([data-step="<id>"]) and is not empty;
  - its visible text is not the same as another step's (the "one base screen" bug);
  - no red tweak banner (a states.js selector that missed);
  - every planned control with `next` is on it as data-next, and clicking it shows that step;
  - every data-next on it names a step of the journey; a main-path screen that is not the last has a way on.
Whole page: no console errors, no missing file, nothing fetched from outside the file but /sdk/ and Google Fonts.
"""

import argparse
import pathlib
import sys

from playwright.sync_api import sync_playwright

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))   # -I leaves the script's folder off the path
from build_mock import load_row  # noqa: E402

ALLOWED = ("file:", "data:", "blob:", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/")
SHOWN = "(id) => { const s = document.querySelector(`[data-step=\"${CSS.escape(id)}\"]`); return !!s && !s.hidden; }"
SCREEN = """(id) => {
  const s = document.querySelector(`[data-step="${CSS.escape(id)}"]`);
  if (!s) return null;
  return { text: s.innerText.replace(/\\s+/g, ' ').trim(), els: s.getElementsByTagName('*').length,
           error: [...s.querySelectorAll('[data-mockify-error]')].map((e) => e.textContent),
           next: [...s.querySelectorAll('[data-next]')].map((e) => e.dataset.next) };
}"""


DISPLAY_WIDTH = 760
# A fitted screen keeps its captured width (wider than the frame) and is zoomed down to it.
FIT = """(id) => {
  const s = document.querySelector(`[data-step="${CSS.escape(id)}"]`);
  return { reflowed: parseFloat(getComputedStyle(s).width) <= innerWidth + 1 };
}"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("page")
    ap.add_argument("--row", required=True)
    ap.add_argument("--shots", help="write one screenshot per step here")
    a = ap.parse_args()

    journey = load_row(a.row).get("journey", [])
    if not journey:
        sys.exit("validate_mock: the row has no journey")
    if not pathlib.Path(a.page).is_file():
        sys.exit(f"validate_mock: no page at {a.page}")
    ids = [s["id"] for s in journey]
    last_main = max(i for i, s in enumerate(journey) if not s.get("branch_of"))
    shots = pathlib.Path(a.shots) if a.shots else None
    if shots:
        shots.mkdir(parents=True, exist_ok=True)

    problems: dict[str, list[str]] = {i: [] for i in ids}
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
            page.wait_for_function("typeof window.mockifyGo === 'function'", timeout=5000)
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
            if not info["next"] and not step.get("branch_of") and i < last_main:
                bad.append("no data-next on it: a dead end for the reviewer")
            if shots:
                page.screenshot(path=str(shots / f"{i + 1:02d}-{sid}.png"))

            for ctl in step.get("controls") or []:
                to, label = ctl.get("next"), ctl.get("label")
                if not to:
                    continue
                if to not in info["next"]:
                    bad.append(f'planned control "{label}" → {to}: no data-next="{to}" on the screen')
                    continue
                if not page.evaluate(SHOWN, sid):
                    show(sid)
                try:
                    page.locator(f'[data-step="{sid}"] [data-next="{to}"]').first.click(timeout=2000)
                except Exception as e:  # noqa: BLE001 — a click that fails is the step's problem
                    bad.append(f'"{label}" could not be clicked: {str(e).splitlines()[0]}')
                    continue
                if not shown(to):
                    bad.append(f'"{label}" → {to}: that screen did not show')

        # The Flowpad display is about half a screen. A screen that reflows into it (laid out at the frame's
        # width instead of the captured one) loses its layout — the reviewer sees a near-empty page.
        page.set_viewport_size({"width": DISPLAY_WIDTH, "height": 700})
        for step in journey:
            sid = step["id"]
            if not show(sid):
                continue
            fit = page.evaluate(FIT, sid)
            if fit["reflowed"]:
                problems[sid].append(f"at the display's width ({DISPLAY_WIDTH}px) the screen reflows instead of "
                                     "scaling — build with --width <capture width>")
            if shots:
                page.screenshot(path=str(shots / f"display-{sid}.png"))
        browser.close()

    page_problems = ([f"console: {m}" for m in errors[:10]] + [f"missing file: {u}" for u in sorted(broken)[:10]]
                     + [f"fetched from outside the file: {u}" for u in sorted(outside)[:10]])
    for sid in ids:
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
