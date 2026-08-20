---
id: 1d92d10f-44be-4159-a0cd-02244885300d
name: web-tester
description: Test all the HTML the session produced — self-contained .html assets
  AND running web apps (web-app-builder / vibe apps) — by driving each page in a
  headless, backend Python Playwright sweep. For every page it captures console
  errors, uncaught JS exceptions, failed (4xx/5xx) network requests, a full-page
  screenshot, broken in-app links, and basic accessibility findings, then reports
  pass/fail. Use this whenever the user asks to test, QA, validate, smoke-test,
  check, or "make sure it works" for HTML pages, a website, a web app, a dashboard,
  or a deck they built here — even if they don't say "Playwright". All debug
  artifacts land in an isolated temp folder; the user's project dirs are never
  written to unless they ask. Building/scaffolding a web app is the web-app-builder
  skill's job — this skill only TESTS what already exists.
tags:
- testing
- playwright
- web
- qa
- html
allowed-tools:
- Bash
- Read
- Write
- Edit
- Glob
- Grep
---

# Web Tester

Order a headless **backend Python Playwright** sweep over every piece of HTML in
the session and report what's broken. Playwright is **not** shipped with Flowpad,
so this skill installs it on demand into an isolated, throwaway location — it does
**not** add Playwright to the user's project or its dependencies.

The driver script is `runner.py` next to this file. It does the browser work; this
document tells you how to discover targets, bootstrap, run it, and report.

## Non-negotiable: keep debug artifacts out of the user's dirs

Every artifact — screenshots, `report.json`, `report.md`, the ephemeral Python env
— goes under **one isolated temp directory** you create per run:

```bash
OUT="$(mktemp -d "${TMPDIR:-/tmp}/flowpad-web-tester.XXXXXX")"
```

Never write test output, screenshots, a `playwright.config`, a `tests/` folder, or
a venv into the user's project (the session cwd or anything under `assets/`) **unless
the user explicitly asks you to save them there**. `runner.py` already writes only
under `--out`; you keep the same discipline for anything you add. When you report,
give the user the `$OUT` path so they can browse the artifacts, and offer to copy a
specific screenshot/report into their project if they want it kept.

## 1. Discover targets ("all the HTML stuff")

Collect two kinds of target and pass each with a `--target` flag.

**a) Self-contained HTML files** — standalone `.html` under the project (decks,
exported pages, single-file apps). These load via `file://`, no server needed:

```bash
# from the session cwd (the project the user is working in)
find . -type f -name '*.html' \
  -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*'
```

Pass each hit as an absolute path: `--target /abs/path/to/page.html`.

**b) Running web apps** — anything with a dev server (a web-app-builder app under
`assets/apps/<name>`, a vibe app, etc.). Prefer testing the **live** app, not its
source files:

- If the dev server is already up, use its URL (web-app-builder frontend is
  `http://localhost:<port>`; the port is whatever the dev server printed / was `flow show`n — never assume 3000).
- If it isn't running and the user wants it tested, start it per that app's own
  skill/README (e.g. web-app-builder: `cd assets/apps/<name>/frontend && npm run dev`),
  wait until it answers, then target it. Enumerate its routes (read the app's router
  / `app/` pages) and pass each meaningful route as a URL:
  `--target http://localhost:<port>/ --target http://localhost:<port>/dashboard`.

If discovery finds nothing, tell the user there's no HTML to test and stop — don't
invent targets.

## 2. Bootstrap Playwright (idempotent, isolated)

Use `uv`'s ephemeral env so nothing is installed into the user's project. The
Chromium binary lands in the shared Playwright cache (a tool cache, not a user dir),
so this is a no-op after the first run:

```bash
uv run --with playwright python -m playwright install chromium
```

If `uv` isn't available, fall back to a venv **inside `$OUT`** (still isolated):

```bash
python3 -m venv "$OUT/.venv" && "$OUT/.venv/bin/pip" -q install playwright \
  && "$OUT/.venv/bin/python" -m playwright install chromium
```

## 3. Run the sweep

```bash
uv run --with playwright python \
  "<this skill's directory>/runner.py" --out "$OUT" \
  --target http://localhost:<port>/ \
  --target /abs/path/to/page.html
```

(venv fallback: swap the interpreter for `"$OUT/.venv/bin/python"`.) With many
targets, write them one-per-line to `$OUT/targets.txt` and pass `--targets-file
"$OUT/targets.txt"` instead of many `--target` flags.

The runner never aborts the whole sweep on one bad page, and its per-page nav
timeout is deliberately capped — **do not raise it to make a slow page pass**; a
page that needs longer is the bug. Exit code is 0 when the sweep *ran*; read
`$OUT/report.json` for the actual pass/fail. What it checks per page:

| Check | Signal |
|-------|--------|
| Console errors | `console.error(...)` emitted while loading |
| Uncaught JS errors | `pageerror` — an exception the page threw |
| Failed requests | any 4xx/5xx or network-failed doc/script/style/fetch/img |
| Screenshot | full-page PNG under `$OUT/screenshots/` |
| Broken links | in-app `<a href>` that resolves to a non-2xx/3xx |
| Basic a11y | missing `lang`/`<title>`/`alt`, unlabeled inputs, nameless links/buttons |

## 4. Report to the user

Read `$OUT/report.md` (and `report.json` for detail) and summarize: how many pages
passed/failed and the concrete failures (which page, which console/JS error, which
request, which dead link, which a11y finding). Point them at `$OUT` for the
screenshots and full report. Only copy artifacts into their project if they ask.

If they want the failures **fixed**, that's ordinary editing of their app/pages —
do it in their project (not in `$OUT`), then re-run the sweep to confirm green.

## Scope

This skill **tests** existing HTML. It does not scaffold apps (web-app-builder),
build decks (decker), or drive the Flowpad UI itself (flowpad-navigation). If the
user has nothing built yet, route them to the builder skill first.
