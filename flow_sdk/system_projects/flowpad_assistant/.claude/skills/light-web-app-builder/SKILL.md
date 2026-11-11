---
id: 6de99f72-20b5-415d-acab-e3d5735581f3
name: light-web-app-builder
description: Builds a small web app that saves its own data, fast and with no heavy
  installs — one Python (FastAPI) server, a SQLite file for the data, and plain HTML
  pages styled like shadcn/ui (Basecoat) with Alpine.js for interactivity. No Node,
  no npm, no build step, no Docker, no database server; it is up in seconds and runs
  comfortably on a small sandbox. Use for learners, classrooms, quick prototypes and
  any app whose user wants a working result now — a list, a quiz, a poll, a guestbook,
  a scoreboard, a small shop or booking page. NOT for a page with no saved data (html-builder),
  a production SaaS with sign-ups, Postgres or a Vercel deploy (web-app-builder),
  or an app over Flowpad's own tasks and docs (web-app-builder's template-flowpad).
tags:
- webapp
- fastapi
- sqlite
- basecoat
- alpine
- lightweight
allowed-tools:
- Bash
- Read
- Write
- Edit
- Glob
- Grep
---

# Light Web App Builder

One server, one data file, plain pages. Everything a learner needs to see a working app in
under a minute, and nothing a professional developer would add on top.

| Part | What | Where |
|---|---|---|
| Server | FastAPI (Python): serves the pages AND the API | `app.py` |
| Data | SQLite, one file; tables created on every start | `schema.sql`, `data/app.db` |
| Pages | Plain HTML, no build | `static/index.html`, `static/app.js`, `static/styles.css` |
| Look | Basecoat — shadcn/ui components and tokens as CSS classes | `static/vendor/basecoat.min.css` |
| Behaviour | Alpine.js — `x-data`, `x-for`, `@click` in the HTML | `static/vendor/alpine.min.js` |

The vendor files are copied into the template, so nothing is downloaded from npm or a CDN.

## Bootstrap — copy as-is, run as-is

**Target directory = `<project root>/agentic-assets/webapp/<app name>`**: `<project root>` is the
session's working directory, `<app name>` a short kebab-case name for what is being built. That
folder is the one place Flowpad reads a `webapp.json` from; an app built anywhere else is not an
app to Flowpad and nothing starts it. If the folder already holds an app from this template
(`app.py` + `static/`), skip to *Changing the app*.

1. Copy the template verbatim:

   ```bash
   cp -R "<this skill's directory>/template/." "<project root>/agentic-assets/webapp/<app name>/"
   ```

   Then set `name` in its `webapp.json` to `<app name>` and `title` to the app's title.

2. Run setup from the app folder, exactly as shipped (idempotent; a few seconds):

   ```bash
   python3 setup.py
   ```

3. Open it — Flowpad starts the server from `webapp.json` on a free port and shows it:

   ```bash
   flow app open <app name>
   ```

Never pick a port, and never start `uvicorn` by hand for the user: `flow app open` and
`flow app restart <app name>` do it, and `flow app ports --bare <app name>` reads the port.

## Changing the app

Start from the example (`items`) and rename it to what the app is about.

- **A table** → `schema.sql`, as `CREATE TABLE IF NOT EXISTS`. It runs on every start, so a new
  table appears on the next restart. A change to a table that already holds data (a new column)
  goes in `migrate()` in `app.py`, guarded so it runs once — the docstring there shows how.
  Never delete `data/app.db` to "apply" a change: that is the user's data.
- **An API route** → `app.py`, under `/api/...`, before the `app.mount("/", ...)` line (the last
  line serves the pages and would swallow any route below it). Use `?` placeholders for every
  value in SQL — never build SQL with f-strings.
- **A page** → a new `static/<name>.html` with the same `<head>` as `index.html`; link pages with
  relative hrefs (`href="scores.html"`).
- **Behaviour** → a function in `static/app.js` that returns state and actions, bound with
  `x-data="name()"`. Call the API with the `api()` helper there.
- **Paths are relative** — `api/items`, `vendor/...`, `styles.css`, never `/api/...`. The app may
  be served under a path, and a leading `/` breaks it there.
- **Restart after editing `app.py` or `schema.sql`**: `flow app restart <app name>`. Pages
  (`static/`) need only a browser refresh.
- **A Python package** → add it to `requirements.txt` and re-run `python3 setup.py`. Prefer the
  standard library; every package is something the next machine must install.

## Look and feel

Load the **`frontend-design`** skill first and give the app a real direction — palette, type, one
signature element. Unstyled or default-looking output is a failed answer.

- Components come from Basecoat: `class="btn"` (`data-variant="secondary|outline|ghost|destructive"`,
  `data-size="sm|lg|icon"`), `class="card"` (with `<header>`, `<section>`, `<footer>`),
  `class="input"` (text, checkbox, radio), `class="badge"`, `class="field"`, `class="table"`,
  `class="alert"`, dialogs, tabs and dropdowns. Markup for each: https://basecoatui.com — read it
  before using a component you have not used here; class names changed in Basecoat 1.0.
- Layout and the app's own look go in `static/styles.css` (Basecoat ships no layout utilities —
  `flex`, `gap-4` and other Tailwind classes do nothing here). Use the shadcn tokens
  (`var(--primary)`, `var(--muted-foreground)`, `var(--border)`, `var(--radius)`) instead of fixed
  colours; to retheme, override them under `:root`. `class="dark"` on `<html>` is dark mode.
- A Hebrew or Arabic app: `<html lang="he" dir="rtl">` (or `ar`), and write every visible text
  in that language.
- Icons: inline SVG (e.g. copied from lucide.dev). No icon package.

## Before you show it — prove it works

Run the **`web-tester`** skill on the running app (URL from `flow app ports`): no console errors,
no failed requests, and a screenshot that matches what was asked. A 200 from the server is not
proof — the page can still throw. Fix what it finds, then show:

```bash
flow show webapp --port <port>
```

Exactly once (exit 0 = shown).

## When this is the wrong skill

Move to `web-app-builder` only when the app truly needs what it adds: real user sign-ups and
logins at scale, Postgres, or a public Vercel deploy. Say so to the user first — it installs a
much heavier stack.
