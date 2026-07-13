#!/usr/bin/env python3
"""web-tester runner — headless, backend (Python) Playwright sweep over HTML targets.

Drives each target in a headless Chromium and reports, per page:
  * console errors + uncaught JS exceptions ("pageerror")
  * failed network requests (4xx / 5xx / requestfailed)
  * a full-page screenshot
  * broken same-origin links (dead <a href> -> non-2xx/3xx)
  * a small set of basic accessibility rule checks (no external deps)

EVERYTHING it writes (screenshots, report.json, report.md, any debug artifact)
goes UNDER --out, which the caller MUST point at an isolated temp directory.
The runner never writes anywhere else. It does not touch the user's project.

Usage:
  python runner.py --out /tmp/flowpad-web-tester-<id> \
      --target http://localhost:3000 \
      --target /abs/path/to/page.html

  # or a newline/JSON list of targets:
  python runner.py --out DIR --targets-file targets.txt

A target is either an http(s) URL or a filesystem path to an .html file
(it is loaded as a file:// URL). Exit code is 0 when the sweep completed
(read report.json for pass/fail); it is non-zero only if the sweep itself
could not run.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys
import urllib.parse

# Kept deliberately modest. Per repo policy these are NOT to be widened to mask a
# slow/hanging page — a page that needs longer than this is the thing to fix.
NAV_TIMEOUT_MS = 15_000
SETTLE_MS = 500
MAX_LINKS_PER_PAGE = 40


def slugify(s: str) -> str:
    s = re.sub(r"^[a-z]+://", "", s)
    s = re.sub(r"[^A-Za-z0-9._-]+", "_", s).strip("_")
    return (s or "page")[:80]


def to_url(target: str) -> str:
    if re.match(r"^https?://", target):
        return target
    p = pathlib.Path(target).expanduser().resolve()
    return p.as_uri()


# --- basic a11y checks, run in-page. No axe/CDN so it works fully offline. ---
A11Y_JS = r"""
() => {
  const out = [];
  const push = (rule, detail) => out.push({ rule, detail });
  if (!document.documentElement.getAttribute('lang'))
    push('html-has-lang', '<html> is missing a lang attribute');
  if (!document.title || !document.title.trim())
    push('document-title', 'document has no <title>');
  let noAlt = 0;
  document.querySelectorAll('img').forEach(img => {
    if (!img.hasAttribute('alt')) noAlt++;
  });
  if (noAlt) push('image-alt', noAlt + ' <img> without an alt attribute');
  let unlabeled = 0;
  document.querySelectorAll('input:not([type=hidden]), select, textarea').forEach(el => {
    const id = el.getAttribute('id');
    const labelled =
      (id && document.querySelector('label[for="' + CSS.escape(id) + '"]')) ||
      el.closest('label') ||
      el.getAttribute('aria-label') ||
      el.getAttribute('aria-labelledby') ||
      el.getAttribute('title');
    if (!labelled) unlabeled++;
  });
  if (unlabeled) push('label', unlabeled + ' form control(s) without an accessible label');
  let namelessBtn = 0;
  document.querySelectorAll('button, a[href]').forEach(el => {
    const name =
      (el.textContent || '').trim() ||
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      (el.querySelector('img') && el.querySelector('img').getAttribute('alt'));
    if (!name) namelessBtn++;
  });
  if (namelessBtn) push('link-name', namelessBtn + ' link/button(s) without an accessible name');
  return out;
}
"""


def blank_result(target: str, url: str) -> dict:
    """The canonical per-target result shape — the single source of its schema."""
    return {
        "target": target,
        "url": url,
        "loaded": False,
        "console_errors": [],
        "page_errors": [],
        "failed_requests": [],
        "broken_links": [],
        "a11y": [],
        "screenshot": None,
        "nav_error": None,
    }


def test_target(context, target: str, out_dir: pathlib.Path) -> dict:
    url = to_url(target)
    slug = slugify(target)
    result = blank_result(target, url)
    page = context.new_page()
    page.on("console", lambda m: m.type == "error" and result["console_errors"].append(m.text[:500]))
    page.on("pageerror", lambda e: result["page_errors"].append(str(e)[:500]))

    def on_response(resp):
        try:
            if resp.status >= 400 and resp.request.resource_type in ("document", "script", "stylesheet", "fetch", "xhr", "image"):
                result["failed_requests"].append({"url": resp.url[:300], "status": resp.status})
        except Exception:
            pass

    page.on("response", on_response)
    page.on("requestfailed", lambda r: result["failed_requests"].append(
        {"url": r.url[:300], "status": (r.failure or "failed")}))

    try:
        page.goto(url, wait_until="load", timeout=NAV_TIMEOUT_MS)
        page.wait_for_timeout(SETTLE_MS)
        result["loaded"] = True
    except Exception as e:  # navigation itself failed
        result["nav_error"] = str(e)[:500]
        page.close()
        return result

    # screenshot (out_dir/screenshots is created once by the caller)
    shot = out_dir / "screenshots" / f"{slug}.png"
    try:
        page.screenshot(path=str(shot), full_page=True)
        result["screenshot"] = str(shot)
    except Exception as e:
        result["screenshot_error"] = str(e)[:300]

    # a11y
    try:
        result["a11y"] = page.evaluate(A11Y_JS)
    except Exception as e:
        result["a11y_error"] = str(e)[:300]

    # broken same-origin links
    try:
        origin = urllib.parse.urlsplit(page.url)
        hrefs = page.eval_on_selector_all(
            "a[href]", "els => els.map(e => e.href)")
        seen = set()
        for h in hrefs:
            sp = urllib.parse.urlsplit(h)
            if sp.scheme not in ("http", "https"):
                continue
            if (sp.scheme, sp.netloc) != (origin.scheme, origin.netloc):
                continue  # only check in-app links
            base = urllib.parse.urldefrag(h).url
            if base in seen:
                continue
            if len(seen) >= MAX_LINKS_PER_PAGE:
                break
            seen.add(base)
            try:
                resp = context.request.get(base, timeout=NAV_TIMEOUT_MS)
                if resp.status >= 400:
                    result["broken_links"].append({"url": base[:300], "status": resp.status})
            except Exception as e:
                result["broken_links"].append({"url": base[:300], "status": str(e)[:120]})
    except Exception as e:
        result["links_error"] = str(e)[:300]

    page.close()
    return result


def page_failed(r: dict) -> bool:
    return bool(
        not r["loaded"] or r["console_errors"] or r["page_errors"]
        or r["failed_requests"] or r["broken_links"]
    )


def write_reports(out_dir: pathlib.Path, results: list[dict]) -> dict:
    failed = [r for r in results if page_failed(r)]
    a11y_pages = [r for r in results if r.get("a11y")]
    summary = {
        "total": len(results),
        "passed": len(results) - len(failed),
        "failed": len(failed),
        "pages_with_a11y_findings": len(a11y_pages),
    }
    (out_dir / "report.json").write_text(
        json.dumps({"summary": summary, "results": results}, indent=2))

    lines = ["# web-tester report", ""]
    lines.append(f"- targets: **{summary['total']}**  ·  passed: **{summary['passed']}**  ·  failed: **{summary['failed']}**")
    lines.append(f"- artifacts: `{out_dir}`")
    lines.append("")
    for r in results:
        status = "❌ FAIL" if page_failed(r) else "✅ ok"
        lines.append(f"## {status} — {r['target']}")
        if r["nav_error"]:
            lines.append(f"- **did not load:** {r['nav_error']}")
        for k, label in [
            ("page_errors", "uncaught JS errors"),
            ("console_errors", "console errors"),
            ("failed_requests", "failed requests"),
            ("broken_links", "broken links"),
            ("a11y", "a11y findings"),
        ]:
            items = r.get(k) or []
            if items:
                lines.append(f"- {label} ({len(items)}):")
                for it in items[:10]:
                    lines.append(f"    - {json.dumps(it) if isinstance(it, (dict, list)) else it}")
        if r.get("screenshot"):
            lines.append(f"- screenshot: `{r['screenshot']}`")
        lines.append("")
    (out_dir / "report.md").write_text("\n".join(lines))
    return summary


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", required=True, help="isolated temp output dir (created if missing)")
    ap.add_argument("--target", action="append", default=[], help="URL or .html path (repeatable)")
    ap.add_argument("--targets-file", help="file with one target per line, or a JSON array")
    args = ap.parse_args()

    targets = list(args.target)
    if args.targets_file:
        raw = pathlib.Path(args.targets_file).read_text().strip()
        try:
            targets += json.loads(raw)
        except json.JSONDecodeError:
            targets += [ln.strip() for ln in raw.splitlines() if ln.strip()]
    targets = [t for t in dict.fromkeys(targets) if t]
    if not targets:
        print("no targets given", file=sys.stderr)
        return 2

    out_dir = pathlib.Path(args.out).expanduser().resolve()
    (out_dir / "screenshots").mkdir(parents=True, exist_ok=True)

    try:
        from playwright.sync_api import sync_playwright
    except ModuleNotFoundError:
        print("playwright not installed — see SKILL.md bootstrap step", file=sys.stderr)
        return 3

    results = []
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        context = browser.new_context(ignore_https_errors=True)
        for t in targets:
            print(f"[web-tester] {t}", file=sys.stderr)
            try:
                results.append(test_target(context, t, out_dir))
            except Exception as e:  # never let one target abort the sweep
                r = blank_result(t, t)
                r["nav_error"] = f"runner error: {e}"
                results.append(r)
        context.close()
        browser.close()

    summary = write_reports(out_dir, results)
    print(f"[web-tester] done: {summary['passed']}/{summary['total']} passed, "
          f"{summary['failed']} failed → {out_dir}/report.md", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
