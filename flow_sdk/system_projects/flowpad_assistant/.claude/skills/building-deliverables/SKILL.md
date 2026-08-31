---
id: 5204aeda-dfc7-43bb-a689-300e6795263c
name: building-deliverables
description: Routes a build request to the right Flowpad skill and says how to present
  the result — web apps, slide decks, standalone HTML pages, static sites, images,
  skills, agents, whiteboards, docs and URL-to-markdown captures. Use whenever the
  user asks to build, create, make, generate, scaffold or prototype something, when
  they ask to test what was built, or when they want an existing app opened or a
  command run in their visible terminal.
---

# Building deliverables — what to build, and with what

Pick the row that matches the request and follow it. Do not hand-write what a skill
already owns. After every deliverable, present it with `flow show` (see the
`flowpad-navigation` skill for the full show/navigate rule).

## Routing

**MCP UI / MCP Apps / interactive chat forms** → the **mcp-ui** skill. Write a single
`.mcp.html` file, then `flow show file <absolute-path-to-file.mcp.html>`. The user
submits inside that UI; after submission, reply with `MCP_UI_RECEIVED` and echo the
submitted fields.

**Data source / feed / RSS / Slack / Drive / mail / repo to ingest**, "what can I do
with these items", label / annotate / training set → the **connect-data-source** skill
(connect, then `define`). Present with `flow show view data-sources` or the source's
editor (`flow show view "app/<editor typeid>?source=<id>"`; `SC specs` reports each
definition's `editor`).

**Full web app / SaaS / dashboard / anything with a database or auth** → the
**web-app-builder** skill (copy its template as-is, run its setup as-is). When the dev
server is up: `flow show webapp --port <port>` — the port the dev server actually
reported, never an assumed one.

**Slide deck / presentation / slideshow / pitch deck / keynote** (anything the user
wants as slides — even phrased as "make me a presentation about X") → the **decker**
skill. It builds a reusable deck template (asking which page types to support via an
mcp-ui multi-select) and generates a single self-contained deck HTML, then
`flow show file <abs-path>.html`. Do NOT hand-write slide HTML and do NOT route a deck
through the `.html` rule below — decks belong to decker.

**`.html` deliverable** (a generated `crm.html`, a chart, a report, a mockup, or a small
static site of a few pages with their own images and stylesheets; NOT a slide deck) →
the **html-builder** skill for the page itself (it loads **frontend-design** first, so
the result looks designed rather than defaulted), then write the files in the project
directory and `flow show file <abs-path-to-the-entry-page>.html`. No `http.server`, no
port.

The preview serves that file at a url ending in its own path, so **links to sibling
pages, local images, stylesheets, scripts and `#anchors` all work normally** — write
ordinary relative html and do not contort it. Do NOT strip `href="#section"` anchors, do
not inline images as `data:` uris to "make them load", and do not flatten a multi-page
site into one file. Those were workarounds for a defect that no longer exists.

**Two things the preview still cannot do**, and they are the only reasons to reach for
the server rule below:

* **`localStorage` / `sessionStorage`** — a page that remembers something (a todo list,
  a saved theme, a score). Storage *throws* in the preview, which kills the whole
  script, so the page half-renders with no visible error.
* **`fetch` of its own data file** — a page that loads `data.json` beside it. (A
  `<script src="data.js">` is fine; it is the `fetch`/XHR that is blocked.)

If the page needs either, serve it from the very first show rather than switching later
— the surface changes shape under the user mid-session.

**Simple or static app / page** ("hello world app", a landing page, a one-page demo, a
small game, a chart page) → fast path, NOT the full template:
1. Write the files (`index.html` + assets) in the project directory, through the
   **html-builder** skill — it owns no-build static pages and loads **frontend-design**
   for the aesthetic direction, which is what stops this coming out as bare unstyled text.
2. Get a port and serve on it — never pick a number yourself (other builds are serving
   on this machine too). One Bash call:
   `PORT=$(flow app free-dev-port --bare); (cd <dir> && python3 -m http.server $PORT >/dev/null 2>&1 &); echo $PORT`
3. `flow show webapp --port <the port it echoed>`

**Image deliverable** ("find/search an image of X and show it", "download this picture",
a generated diagram/screenshot) → get the image file into the project directory, then
show the FILE itself:
1. Find a direct image URL (WebSearch is available) and download it with Bash:
   `curl -sL -o <project-dir>/<name>.<ext> "<image-url>"` — keep the real extension
   (jpg/png/webp/svg/gif). Sanity-check it's an image: `file <path>` should say image
   data, not HTML.
2. `flow show file <abs-path-to-image>` — the surface renders it in the image viewer.
   Show the image file itself, never an html page wrapping it. (Video/audio files work
   the same way: download, then `flow show file`.)

**Skill** → scaffold `.claude/skills/<name>/SKILL.md` (+ references) in the project, then
`flow show file <abs-path-to-SKILL.md>` — this opens the full skill editor (Flowpad
resolves the entity for you; no indexing step).

**Agent** → write `.claude/agents/<name>.md` (frontmatter: name, description, tools),
then `flow show file <abs-path>`.

**Whiteboard / board / diagram** → a folder `.claude/whiteboards/<name>/` in the project
containing:
- `WHITE_BOARD.md` — YAML frontmatter with `name:` (no `id` needed) + a one-line
  description body.
- `board.json` — a plain Excalidraw scene: `{"elements": [...], "appState": {}}` with
  `rectangle`/`ellipse`/`diamond`/`arrow`/`text` elements (each needs `id`, `type`, `x`,
  `y`, `width`, `height`; text needs `text` + `fontSize`). Lay items out on a grid,
  don't overlap.
Then `flow show file <abs-path-to-WHITE_BOARD.md>`.

**Doc / plan / report** → write the markdown, then `flow show file <abs-path>`.

**URL → markdown doc** → create an indexed Flowpad markdown entity, not a loose file:
1. Fetch the raw page with Bash: `curl -sL "<url>"`. Do **not** use `WebFetch` or
   `WebSearch` for the article body; those can return condensed model output and drop
   images/tables/structured blocks.
2. Convert the article body faithfully: preserve headings, paragraphs, lists, tables,
   links, blockquotes, and images as markdown image links with absolute URLs. Strip only
   site chrome (nav/footer/share/cookie/related-post blocks).
3. Write the markdown under the project `docs/` directory using a safe filename.
4. Run `flow record index "<absolute-md-path>" --types markdown`.
5. Take the returned `markdown-...` TypeId and run `flow show entity <typeid>`. If
   indexing returns no TypeId, fix the file/index command before showing it.

## Testing in the browser — the `web-tester` skill

When the user asks to **test / QA / validate / smoke-test / check** what you built in a
browser ("test this", "make sure it works", "does the app work", "check the pages") → use
the **web-tester** skill. It runs a headless backend Playwright sweep over every HTML
target — standalone `.html` files AND running apps — capturing console/JS errors, failed
requests, screenshots, broken links, and basic a11y, and reports pass/fail. All debug
artifacts go to an isolated temp folder — never write test output into the user's project
unless they ask. Don't hand-roll browser checks or a Playwright setup yourself; route
through the skill. If a sweep finds failures and the user wants them fixed, fix the app
files in place and re-run the sweep.

## Opening an EXISTING web app

("open the app", "run the dashboard", "show the frontend") → don't rebuild:

```bash
flow app open "<user words>"
```

It first reuses a matching saved WEBAPP artifact. If none matches, it scans the project
for web app roots (`package.json`, common frameworks, static `index.html` folders),
starts the best match, creates/updates the WEBAPP artifact, and shows it. Exit 0 =
opened and shown. Exit 4 = no app found → say so briefly and offer to create one. Do not
manually emit `<flow-result>` XML for this; the command persists the artifact.

For anything else that already exists (a doc, a skill, a board, a screen), use the
**flowpad-navigation** skill — it owns show/open/navigate.

## The terminal — when the user wants to SEE it run

Your `Bash` tool runs in a subprocess nobody can see. Its output reaches you, never the
screen. So "do it in the terminal", "run it in a terminal", "show me the output" means
the terminal the USER is looking at:

```bash
flow terminal open                    # open it (reuses the one already open)
flow terminal open --cwd <abs-path>   # ...somewhere other than the project root
flow terminal run "npm test"          # run it visibly AND read the output back
```

Exit 0 = done. (`2` bad args, `4` no terminal open yet — run `flow terminal open` first,
`5` server down.) Rules:

- `open` is idempotent — it re-shows the terminal you already opened. Call it once, then
  `run` as many times as you like; don't open one per command.
- `run` returns JSON with `output`, `exit_code` and `completed`. You SEE the result —
  read it and act on it (a failing `exit_code` means fix it, don't report success). The
  user watches the same command run in their terminal.
- A long command returns `completed: false` with the output so far; it is still running
  in the user's terminal. Say so rather than guessing at the result.
- Don't re-run the command with your own `Bash` to "check" it — `run` already told you
  what happened, and doing it twice runs it twice.
- Use your own `Bash` for YOUR work (reading files, checking things, building). Use
  `flow terminal` when running it is the point the user asked for.
