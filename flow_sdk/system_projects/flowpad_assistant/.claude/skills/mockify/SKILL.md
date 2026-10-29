---
id: 098a70ff-0160-4950-aa04-b7e7d1990ea2
name: mockify
description: 'Turns a product idea into a clickable HTML mock of the user journey
  that the user can walk and comment on — every screen in order, with a journey bar
  and a per-screen feedback box (text + image) whose comments are saved as typed rows and
  sent back to this session in one Execute. Mock and feedback are typed
  (mockify.mock / mockify.feedback). Two
  modes: real, the default (built from a running app''s own captured DOM and CSS,
  checked side by side so it looks exactly like the app), and fast (HTML in the
  product''s tokens, minutes — only for a product that does not run here, or when
  the user asks for a rough sketch). Use for "mock this flow", "show me the UX", "prototype the journey", "how
  would the user do X — show me", "make a clickable mock", or a design discussion that
  needs screens before code; also when feedback on a mock arrives. Plans every screen, builds one HTML
  file, script-validates it before showing. NOT for a working
  app (web-app-builder), a one-page report or chart (html-builder), or slides (decker).'
---

# mockify — a clickable journey the user can give feedback on

A mock exists to get a decision. It shows the journey screen by screen, in the product's own look, with
the details being discussed written ON the screens; the reviewer walks it, leaves comments per screen,
and submits them back to you. It is not the product: no backend of its own, no real data.

**A mock never lives in the repo.** Every mock, its kinds, its datasets and its feedback live in the
**mock project** — `$TMPDIR/mockify/<repo folder name>/`, a Flowpad project of its own outside the repo.
Nothing is written into the repo until the person presses **💾 Save to repo** (the journey bar's popup toolbar) (or asks for it in
words) — then "Save to repo" below copies that one mock in. Never `install_data.py`, `DM ds-put` or a mock folder into the repo.

**A mock is data.** Its journey is a `mockify.mock` row in the mock project's `mocks` dataset; every comment
is a `mockify.feedback` row in `mock-feedback` (text, optional image, optional decision id, status).
The page reads and writes those rows through the Flowpad SDK. Every data step follows the
**data-management** skill — load it, and obey its ground rules (probe first, rows only through
`dm_ctl` / the SDK, never by hand). `DM` below is its `dm_ctl` shell function.

## Setup — the mock project (once per repo, again whenever the skill's kinds change)

```bash
"$FLOWPAD_PYTHON" <this skill>/scripts/mock_project.py ensure <repo root>
# {"root": "<mock project>", "project_id", "ns", "mocks": "<…/dataset/mocks>", "feedback": "<…/dataset/mock-feedback>", "webapps": "<…/webapp>"}
```

It makes (or finds) `$TMPDIR/mockify/<repo folder name>/`, registers it as a project, installs the kinds
(`schema/`, in the repo's namespace) and the `mocks` / `mock-feedback` datasets, applies and indexes them.
Repeat it any time: it finds the same project. `<mock project>` below is its `root`. First time on this
Flowpad: prove the kinds in a data-management probe (good value fits, a broken one is refused).

## The three phases — in order, none skipped

| phase | output | done when |
|---|---|---|
| **1. Plan** | the mock row: the flow, and per screen a scenario, its controls and where the screen comes from | the user has the step table |
| **2. Implement** | ONE `index.html` holding every screen as its own `<section data-step>` | `build_mock.py` wrote it with no missing screen |
| **3. Validate** | `validate_mock.py` PASS, then your own look at every screen | PASS + screenshots looked at |

The failure this order prevents: a mock that is one base screen with small patches, where clicking a
control changes nothing. Every screen is planned, then built in full, then checked against its plan.

## Phase 1 — Plan the flow and each screen's scenario

Write the journey as the mock row before building anything. Per step:

| field | what |
|---|---|
| `id`, `app`, `title`, `note` | as before — the screen, the product it lives in, the detail to react to |
| `scenario` | what the user sees and does here, in a sentence or two — the brief the screen is built from |
| `controls` | every clickable thing on the screen the reviewer will try: `{label, does, next?}`. `next` = the step it leads to (it becomes `data-next`); no `next` = not part of this mock |
| `source` | `capture` (a live-app state you will reach and capture) or `built: <why>` (the live app cannot reach it; drawn from the component source) |
| `branch_of` + `when`, `next`, `decisions` | a branch, where a screen goes on, open questions (D1, D2… unique across the mock) |

```bash
DM ds-put <mock project>/agentic-assets/dataset/mocks <slug> '{"input": {"title": "…", "mode": "real",
  "status": "draft", "session": "<this process id>", "folder": "<webapp folder>", "repo": "<repo root>",
  "journey": [{"id": "home", "app": "Flowpad", "title": "Home", "note": "…",
    "scenario": "The user lands on Home and opens the + menu to add a channel.",
    "source": "capture",
    "controls": [{"label": "+ Add", "does": "opens the channel picker", "next": "pick"},
                 {"label": "Settings", "does": "opens settings"}],
    "decisions": [{"id": "D1", "question": "…", "shown": "…"}]}, …]}}'
```

- **Start where the user really starts** (often the screen they already live in). If unsure, ask once.
- One step per screen — a screen that looks different (a dialog open, a menu dropped, a toast shown) is its
  own step, never a patch on another step's screen.
- A branch (failure, cancel, "finish later") has `branch_of: <step id>` and `when`, right after the step it
  branches from; a screen that goes on somewhere other than the next main-path screen says `next`.
- `session` is YOUR agentic process id (`flow context`) — where Execute delivers the feedback.
- `DM check` the value against `mockify.mock` before the put; a refused put writes nothing.

Send the user the step table (id · title · scenario · controls that move on), one line per step.

**Then go straight on to Phase 2 — do not stop to ask.** The step table is a status line, not a
checkpoint: open decisions go ON the screens (`data-decision`), where the reviewer answers them while
walking the mock. Stop before building ONLY for a real blocker: the app cannot run here, a screen's state
cannot be reached (and fast mode was not asked for), or the request is too unclear to plan a single
screen. "The user may want to change the plan" is not a blocker — they change it through feedback.

### The mode is real — fast only when the person says so

| mode | when | fidelity |
|---|---|---|
| **real** (always, for an app that runs here) | any screen of an app whose code is here — new, redesigned or existing | identical |
| **fast** | ONLY (a) the person asked for a rough sketch in their own words, or (b) the product does not run here at all (a third-party site) | recognisable |

**You do not get to pick fast.** Effort is never a reason ("the state is hard to reach", "it needs
seed data"). Reach the state (`reference/real-capture.md` §2 has recipes for the hard ones). If you truly
cannot, STOP and ask. A fast mock's row MUST carry `fast_reason` (the person's quoted words, or the product
that does not run here); the bar refuses a fast mock without it.

## Phase 2 — Implement every screen, into one HTML file

**Keep everything that is not under discussion.** Every screen is a full-window capture — top bar, rail,
tab rows, status bar. A control missing from a mock reads as "remove it".

- **real**: follow `reference/real-capture.md`. For EVERY step, run the app yourself in its own dev / UI-only mode (never the person's
real running app or a copy of its data), drive it to that
  screen's state and capture it — `capture/<step id>.html`. A step whose `source` is `built` starts from the
  nearest capture and is edited per its scenario, cloning real elements and using the app's own classes
  (`scripts/check_classes.py`). Then assemble with `scripts/build_mock.py` (command: `reference/real-capture.md` §5).
  It writes ONE `index.html`: each step its own `<section data-step>`, the app's CSS inlined, icons and
  images as `data:` URIs, the app's scripts stripped, the journey bar last. It carries the journey, so it walks
  on its own. A journey step with no screen stops the build — there is no base screen to fall back to.
- **fast** (with `fast_reason`): copy `templates/fast-mock/` to `<mock project>/agentic-assets/webapp/mock-<slug>/`,
  fill `webapp.json`, set `MOCKIFY.key` / `MOCKIFY.project` / `MOCKIFY.journey` (the row's journey), and write one full `<section data-step="<id>">`
  per step — already one file.

On every screen, both modes:
- **Every planned control with `next` gets `data-next="<step id>"`** — a click moves the journey; the bar
  highlights the one going on. Any other control is inert, and the bar says "Not part of this mock" when it
  is clicked (mark one `data-dead` to also dim it). Never leave a control that silently does nothing.
- Real copy, not lorem: exact labels, the sentence that explains what is missing, the error text. Every
  state the discussion named (empty, waiting, failed, done, "finish later").
- Open decisions: `data-decision="D2"` on the element (the id from the row).
- No invented scope: a gap you noticed goes in the reply, not on a screen.
- The journey bar (`assets/journey-bar.js`, contract `assets/journey-bar.md`) is pasted inline as the last
  script — `build_mock.py` does it in real mode. Its 🎯 picker lets the reviewer comment on one element.

## Phase 3 — Validate

1. **The validator** (headless, from disk):
   ```bash
   DM ds-rows <mocks dataset> --match '{"key": "<slug>"}' > <scratch>/row.json
   uv run --with playwright python -I <skill>/scripts/validate_mock.py <mock-dir>/index.html \
     --row <scratch>/row.json --shots <scratch>/shots
   # first time on a machine: uv run --with playwright python -m playwright install chromium
   ```
   It checks every screen against its plan — above all that no step is **the same screen as another**, and
   that every planned control goes where the plan says (the full list is in the script's docstring). Fix and
   rebuild until it prints **PASS**. Never present a FAIL.
2. **Look at every screenshot** in `--shots` — the validator proves structure, not that it looks right.
3. **Serve it through Flowpad** so feedback saves:
   ```bash
   flow app serve "Mock — <title>"      # from the mock folder; endpoint URL = app_url
   DM ds-put <mocks dataset> <slug> '{"input": {…, "app_url": "<url>", "status": "in_review"}}'
   ```
   The app is at `/api/v1/graph/service_endpoint/<endpoint id>/service/<route>/` (`#<step id>` opens a
   screen). From outside your session pass `--process <id> --no-show`. In the browser (your own tab): walk
   the main path once, Restart once, save one comment with an image and delete it (`DM ds-rows`).
4. **Real mode: the side-by-side is required.** The first screen beside the live app, both screenshotted,
   the pair attached to your reply (`reference/real-capture.md` §6).

## Present

`flow show webapp` with the served app, then reply with: the mode in the first line (and `fast_reason` if
fast), the validator's PASS line, the side-by-side pair, the step list (one line each), what is captured vs
built, the open decisions (D1…), and: "Walk it, use 🎯 or ☰ → 💬 Feedback to leave a comment or an image,
then **▶ Execute** sends me what you have so far (☰ → Review shows exactly what I receive)." Mention
anything the real app did along the way that looked wrong.

## Reading feedback (when a Send prompt arrives)

The prompt names the mock and its ref. Read the comments as rows:

```bash
DM ds-rows <mock project>/agentic-assets/dataset/mock-feedback \
  --match '{"input.mock": "<mock ref>", "input.status": "submitted"}'
```

Each row: `step`, `text`, `decision` (a D-id it answers), `screenshot` (an image — it is on disk as
`<row folder>/input/screenshot.<ext>`; open it), `created`, and — when the reviewer pointed at an element —
`anchor` (`selector` to find it in the screen's HTML, `label`, its `html`, its position) and `element_shot`
(`input/element_shot.png`: the element as it looked). Change THAT element; the selector is where to look. Then:

1. Answer per step and per decision, in the mock's journey order — say what you will change and what
   you will not, and why.
2. Revise the screens and the mock row (`DM ds-put` the row with its new journey / decisions; settled
   decisions leave the row, their answer goes into the screen).
3. Set each comment you acted on to `addressed` (`DM ds-put-many` with their versions); set the mock to
   `revised`, then `in_review` again once re-shown.
4. Rebuild, validate again (Phase 3) and re-show.

## Save to repo (only when the person asks)

The popup toolbar's **💾 Save to repo** shows where the mock will go and, on confirm, sends you one line:
`Save mock "<slug>" to the repo: … mock_project.py save <repo> <slug>`. Run exactly that:

```bash
"$FLOWPAD_PYTHON" <this skill>/scripts/mock_project.py save <repo root> <slug>
# {"saved": "<repo>/agentic-assets/webapp/mock-<slug>", "files": [...]}
```

It copies ONE mock into `<repo>/agentic-assets/webapp/mock-<slug>/`: the page and its assets, `mock.json`
(the mock row's value) and the journey written into the page, so it navigates with no datasets. Feedback,
datasets and kinds stay in the mock project. Tell the person the folder and that it is NOT committed —
committing is theirs to ask for.
