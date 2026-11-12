---
id: 098a70ff-0160-4950-aa04-b7e7d1990ea2
name: mockify
description: 'Turns a product idea into a clickable HTML mock of the user journey
  that the user can walk and comment on — every screen in order, with a journey bar
  and a per-screen feedback box (text + image) whose comments are saved as typed rows and
  sent back to this session in one Execute. Two
  modes: real, the default (built from a running app''s own captured DOM and CSS,
  checked side by side so it looks exactly like the app), and fast (HTML in the
  product''s tokens, minutes — only for a product that does not run here, or when
  the user asks for a rough sketch). Use for "mock this flow", "show me the UX", "prototype the journey", "how
  would the user do X — show me", "make a clickable mock", or a design discussion that
  needs screens before code; also when feedback on a mock arrives. `mockify test`: define a regression
  test on the current UI and write it as a manual_regression .md. NOT for a working
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
(`schema/`, in the mock project's own namespace `mocks_<repo ns>` — never the repo's, or a restart drops them) and the `mocks` / `mock-feedback` datasets, applies and indexes them.
Repeat it any time: it finds the same project. `<mock project>` below is its `root`. First time on this
Flowpad: prove the kinds in a data-management probe (good value fits, a broken one is refused).

## The three phases — in order, none skipped

| phase | output | done when |
|---|---|---|
| **1. Plan** | the mock row's **tree**: screens, their actions and vars — `tree.py validate` says OK | the user has the tree (`tree.py show`) |
| **2. Implement** | ONE `index.html` holding every screen as its own `<section data-step>` | `build_mock.py` wrote it with no missing screen |
| **3. Validate** | `validate_mock.py` PASS, then your own look at every screen | PASS + screenshots looked at |

The failure this order prevents: a mock that is one base screen with small patches, where clicking a
control changes nothing. Every screen is planned, then built in full, then checked against its plan.

## Phase 1 — Write the mock tree

A mock is a **tree**: screens are its nodes, actions its edges, vars its state. You write it once, as the mock
row's `tree`; `scripts/tree.py` validates it and computes the one walk that Next, Back and the screen numbers
follow. Browsing is never guessed: nothing outside the tree decides where a click or Next goes.

**Screen** (`mockify.screen`, a node):

| field | what |
|---|---|
| `id`, `app`, `title`, `note` | the screen, the product it lives in, the detail to react to |
| `scenario` | what the user sees and does here, in a sentence or two — the brief the screen is built from |
| `source` | `capture` (a live-app state you will reach and capture) or `built: <why>` (the live app cannot reach it) |
| `persona`, `device` | whose screen it is (an id from the row's `personas`) and what it is on; absent = the row's `persona` / `device` |
| `tag` | `existing` (default: the product today, its changes drawn as a diff) or `new` (only the suggestion has it; no marks). **The tag never decides whether a screen is walked** |
| `actions` | every clickable thing the reviewer will try — see below |
| `state` | optional assertion, `["ticket=picked"]`: what must be true here |
| `changes`, `decisions` | the proposed changes ON this screen (see "Existing vs new"); open questions (D1, D2… unique across the mock) |

**Action** (`mockify.action`, an edge): `{id, label, does, to?, kind?, when?, set?}`

| `kind` | meaning |
|---|---|
| `main` | the screen's ONE continuation — where the journey goes on |
| `branch` | a side path (failure, cancel, "finish later"); needs `when` |
| `alt` | a suggested alternative that a change card (`mode: screen`) opens |
| `jump` | goes to a screen that already has a parent: Try again, back to the main path |
| *(no `to`)* | on the screen, not part of this mock |

`set: ["desk=on"]` says what the action changes. An action with id `next` is the bar's own Next — a continuation
with no control on the screen; use it only when the product really has none.

**Var** (`mockify.var`): `{name, values, initial}` — one thing the journey changes (`desk: off|on`,
`ticket: none|open|picked|closed`). A screen's state is the initial values plus every `set` on the way to it.

**The walk (DFS).** A screen's parent is the one `main` / `branch` / `alt` action pointing at it. Its children are
its branches and alts in the order written, then its main continuation last. Next is the next screen in DFS
preorder from `root`, Back the previous one, Reset the root — every screen is on it, whatever its tag. Numbers
follow the walk: 1, 2, 3 on the main chain; 6a, 6b for the branches off 6; 6a.2 further along a branch.

```bash
DM ds-put <mock project>/agentic-assets/dataset/mocks <slug> '{"input": {"title": "…", "mode": "real",
  "status": "draft", "session": "<this process id>", "folder": "<webapp folder>", "repo": "<repo root>",
  "tree": {"root": "home",
    "vars": [{"name": "channel", "values": ["none", "added"], "initial": "none"}],
    "screens": [
      {"id": "home", "app": "Flowpad", "title": "Home", "source": "capture",
       "scenario": "The user lands on Home and opens the + menu to add a channel.",
       "actions": [{"id": "add", "label": "+ Add", "does": "opens the channel picker", "to": "pick", "kind": "main"},
                   {"id": "settings", "label": "Settings", "does": "opens settings"}]},
      {"id": "pick", "app": "Flowpad", "title": "Pick a channel", "tag": "new", "source": "built: no picker today",
       "scenario": "…",
       "actions": [{"id": "ok", "label": "Connect", "does": "connects it", "to": "done", "kind": "main", "set": ["channel=added"]},
                   {"id": "deny", "label": "Cancel", "does": "the provider refuses", "to": "denied", "kind": "branch", "when": "if denied"}]},
      {"id": "denied", "app": "Flowpad", "title": "Denied", "scenario": "…", "source": "capture",
       "actions": [{"id": "again", "label": "Try again", "does": "reopens the picker", "to": "pick", "kind": "jump"}]},
      {"id": "done", "app": "Flowpad", "title": "Connected", "scenario": "…", "source": "capture", "state": ["channel=added"]}]}}}'
python3 -I <skill>/scripts/tree.py validate <row.json>   # every broken link, by name — fix until it prints OK
python3 -I <skill>/scripts/tree.py show <row.json>       # the tree, indented: send THIS to the user
```

`tree.py validate` runs in milliseconds, with no browser: unknown `to`, a screen with two parents or none, two
`main` actions, a branch with no `when`, a cycle, a dead end, an undeclared var or value, a `state` the way there
does not produce, a `jump` that lands in another state. `build_mock.py` and `validate_mock.py` refuse a tree
with problems. A mock row that still has a flat `journey` is read through `tree.py from-journey` — convert it and
write `tree` when you touch it.

- **Start where the user really starts — and find it in the code first.** Before writing a step, trace how the
  product does this action TODAY: the control that starts it, the dialog or page it opens, the components on
  the way (grep the UI for the action and the entity type). Plan the change as deltas ON that path, reusing its
  components. A new entry point, dialog or picker only when nothing exists — and say so in the reply. A mock that
  invents its own path beside an existing one gets thrown away.
- **Shortest path, plain words.** A choice the product can default is a default, not a screen; a technical
  detail (keys, devices, protocols) goes in a tooltip or a settings/expert view, never in the main flow. One
  warning icon with its reason on hover beats a panel of explanations.
- One step per screen — a screen that looks different (a dialog open, a menu dropped, a toast shown) is its
  own step, never a patch on another step's screen.
- A branch (failure, cancel, "finish later") is a `branch` action with `when` on the screen it leaves; it ends
  by a `jump` back to the main path, or simply ends (Next then continues with the parent's continuation).
- `session` is YOUR agentic process id — where Execute delivers the feedback. Read it from the env:
  `python3 -c 'import json,os;print(json.loads(os.environ["FLOWPAD_EXECUTION_SCOPE"])[0]["id"])'`.
  Never infer it from a file path (an attached screenshot lives under ANOTHER process's records), and
  never from `flow context` (that reads the browser tab, not the process).
- `DM ds-check` the row against the mocks dataset before the put; a refused put writes nothing.

Send the user the tree — `tree.py show`'s output (number · title · persona · tag · state, and where each action goes).

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

- **real** (`reference/real-capture.md`): run the app yourself in its own dev / UI-only mode (never the
  person's running app or a copy of its data), drive it to each step's state, capture `capture/<step id>.html`.
  A `built` step starts from the nearest capture, cloning real elements and the app's own classes
  (`scripts/check_classes.py`). `scripts/build_mock.py` assembles ONE `index.html` (a section per step, CSS and
  icons inlined, app scripts stripped, the journey bar last); a step with no screen stops it. Then
  `scripts/slim_mock.py index.html` drops unused CSS and inlines each repeated file once (~3× smaller).
- **fast** (with `fast_reason`): copy `templates/fast-mock/` to `<mock project>/agentic-assets/webapp/mock-<slug>/`,
  fill `webapp.json`, set `MOCKIFY.key` / `MOCKIFY.project` / `MOCKIFY.tree` (the output of `tree.py compile <row.json>`), paste
  `assets/mock-tree.js` and then `assets/journey-bar.js`, and write one full `<section data-step="<id>">` per screen, in the tree's order.

On every screen, both modes:
- **Every action with `to` gets `data-next="<screen id>"`** on its control (and nothing else carries one) — a click moves the journey; the bar
  highlights the one going on. Any other control is inert, and the bar says "Not part of this mock" when it
  is clicked (mark one `data-dead` to also dim it). Never leave a control that silently does nothing.
- Real copy, not lorem: exact labels, the sentence that explains what is missing, the error text. Every
  state the discussion named (empty, waiting, failed, done, "finish later").
- Open decisions: `data-decision="D2"` on the element (the id from the row).
- No invented scope: a gap you noticed goes in the reply, not on a screen.
- The journey bar (`assets/journey-bar.js`, contract `assets/journey-bar.md`) is pasted inline as the last
  script — `build_mock.py` does it in real mode. Its 🎯 picker lets the reviewer comment on one element.

## Device / screen

A journey that leaves the desktop — a reply on a phone, an email opened on mobile — says so per step:
`device: desktop | iphone | android` (the mock row's `device` is the default; absent = desktop). A phone
step is captured in a real mobile context (`reference/real-capture.md` §3) and `build_mock.py` shows it in a
device frame at its own width, 1:1, with its own media queries and safe areas, beside desktop steps at full
size. An email client or other third-party app is a `built` step: our content, its chrome. Fast mode: the
`mk-device` frame in `templates/fast-mock/`.

## Persona — whose screen it is

Every screen is someone's screen on some device. Name the people once on the row —
`personas: [{id: "owner", name: "Noa", role: "runs the support center"}, {id: "customer", name: "Dana", role: "opens a ticket"}]`
— a short first name and a few-word role, nothing more. Each step says `persona: "<id>"` (absent = the row's `persona`).
With two or more personas every step names one (`build_mock.py` and the validator fail otherwise). The bar
shows `👤 Noa · runs the support center · 🖥` on every screen and flashes it when the person changes.
Real mode: one signed-in instance per persona (`scripts/instance_ctl.sh launch dev-1` …, different hub users),
each screen captured from its persona's instance. An agent persona's screens are the agent's own session.

## Existing vs new — a UI diff, like git diff for designers

**Every screen is tagged** `EXISTING` or `NEW` (the bar draws the tag on the screen and in its title):

- **EXISTING** (`path` absent or `today`): the product as it is today, captured live. Its proposed changes are
  drawn **over it as a diff** — by default (the bar's **Diff** view) today's element is outlined **red** and the suggested
  version sits right after it, outlined **green**; a removal is red and struck through, an addition only green. Each
  side carries a small circle in its colour with the change's number in git-diff notation (`−2` / `+2`); hovering it says the whole change
  (`Change 2 · 3 elements removed — <title>`). The bar also offers **Today** (the screen untouched) and
  **After** (the screen as it would ship) — both clean, no outlines or labels; only **Diff** is annotated. Both versions show at once, so the reviewer never has to click to compare.
- **NEW** (`tag: new`): a screen that exists only in the suggestion. Everything on it is new, so it carries
  **no annotation** — no `changes`, no `data-change`, no templates. Draw it as it would be.

**Every change is visible, with room around it.** The bar gives a changed block room above it for its label and
keeps labels off each other; you make sure the change has context: keep the neighbouring rows, the section header
and the surrounding layout on the screen, and never put two changes on one element. A change the reviewer must
scroll a dialog to reach is fine; one that runs off the screen sideways, or hides another, is not. The verdict lives
on the label: a click opens the card — ✓ **approved by default**, or ✕ rejected, plus a comment. The bar draws the
outlines, labels and tags; the builder never draws its own banners, boxes or arrows.

| change type (`type`) | how it reveals (`mode`) | how the screen carries it |
|---|---|---|
| wording, value, control, section reshaped, table/data | `place` | today element `data-change="c1"` + `<template data-change-after="c1">` holding the suggested element(s) right after it |
| removed | `place` | today element `data-change="c2"` + an EMPTY `<template data-change-after="c2">` — shown red, struck through |
| added, new entry point | `place` | an anchor `<span class="mk-anchor" data-change="c3"></span>` where it goes + its template |
| new screen, screen replaced, flow changed | `screen` | `to: "<step id>"` — a NEW step (`path: "suggested"`) that the label's card opens; `data-change` on the element that would lead there (the button, the row, the link) — no template |
| states (several looks of one new thing) | `screen` | one suggested step per state, or a template per state as separate changes |
| alternatives (open question) | `place` | `options: ["A · …", "B · …"]` — the reviewer picks one |
| behaviour with nothing visible | — | **not a change on a screen**: it goes on the summary screen (the validator refuses an anchor with an empty template) |

- **Mark what actually changes.** The red outline and label sit on the element itself. A `screen` change sits on the control that leads to the new page (the button, the link, the row) — never on
  a nearby label. When the new page is reached from something the change adds, put the `data-next` inside the
  revealed version and do not make a second change for the page.
- A suggested screen is never deeper than the product would be: a new dialog opens over the PAGE, not over another
  dialog the product would have closed first. Build it from the page's capture, not from the screen before it.
- **Keep a dialog's own scrolling.** Never stretch a dialog to show all of it (no `max-height:none` / `overflow:visible`
  on its body): the reviewer then cannot reach what is below the fold. The bar's "↓ N changes below" points at the rest.
  The validator fails a change that cannot be scrolled into view, and a dialog opened over another dialog.
- Keep `note` short: why, and where it comes from (spec section, who decided).
- A NEW screen is on the walk like any other: it is reached by the action that leads to it. A screen that is an
  ALTERNATIVE to today's (a change with `mode: screen`) hangs off its screen as an `alt` action, and its change card opens it.
- Verdicts and comments are feedback rows (`change`, `vote` yes|no, `choice` on `mockify.feedback`) — the same
  Execute sends them. No row = approved. Act on every rejected change and every comment.
- Build the template's content the same way as any capture: clone the real element and edit the clone.

## Speed — capture once, edit many

- **One app instance for the whole mock**: start it once, keep it, capture every step and every round from it.
  Never launch two in parallel (they race for ports); stop it when the mock is done.
- **Captures are a cache.** Re-capture a step only when its scenario or state changed. A label or copy edit —
  in a feedback round too — goes into `capture/<id>.html` (or `--states`), then rebuild: no app, no browser.
- **A slow live state** (an agent run, a long job) may come from a recorded or seeded state; the step says
  `source: "capture (seeded)"` and the reply names what was seeded.
- **Validate incrementally**: `validate_mock.py --steps a,b` checks the changed steps (whole-page checks still
  run). The full run is required before the first show.

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
2. **Look at every screenshot** in `--shots` — the screens AND the per-change crops (`<n>-<step>-<change>.png`:
   each change in the Diff view with 120px of context; red and green both readable, the label on nothing) — the validator proves structure, not that it looks right. Check
   each against its `scenario`: what it names (the selected record, the open dialog, the filled state) is ON the
   screen. An empty pane, "not found" or an error captured where the scenario expects content is a blocker — reach
   the real state, or build that pane from its component and mark the step `built` — never ship it as the screen.
3. **Serve it through Flowpad** so feedback saves:
   Put the mock row FIRST and check the put printed `"ok": true` (a refused put writes nothing) — then serve and show it.
   ```bash
   flow app serve "Mock — <title>"      # from the mock folder; endpoint URL = app_url
   DM ds-put <mocks dataset> <slug> '{"input": {…, "app_url": "<url>", "status": "in_review"}}'
   ```
   The app is at `/api/v1/graph/service_endpoint/<endpoint id>/service/<route>/` (`#<step id>` opens a
   screen). The mock folder holds `webapp.json`, so it is served as a webapp ASSET: after a backend restart the
   display sets it up again instead of showing a dead end. A `DM` put refused with "names a kind nobody
   registered" means the backend restarted — run `mock_project.py ensure` again. Inside your session never pass `--process`: the CLI reads `FLOWPAD_EXECUTION_SCOPE` itself, and a wrong id puts the tab beside another session's tab. From outside your session pass `--process <id> --no-show`. In the browser (your own tab): walk
   the main path once, Restart once, save one comment with an image and delete it (`DM ds-rows`).
4. **Real mode: the side-by-side is required.** The first screen beside the live app, both screenshotted,
   the pair attached to your reply (`reference/real-capture.md` §6).

## Present

`flow show entity <shown.typeid>` (the typeid `flow app serve` printed), then reply with: the mode in the first line (and `fast_reason` if
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
2. Revise the screens and the mock row (`DM ds-put` the row with its new tree / decisions; settled
   decisions leave the row, their answer goes into the screen).
3. Set each comment you acted on to `addressed` (`DM ds-put-many` with their versions); set the mock to
   `revised`, then `in_review` again once re-shown.
4. Rebuild, validate again (Phase 3) and re-show.

## `mockify test` — define a regression test on the current UI

The same three phases, but the mock is a **test scenario of the app as it is today**: the person walks it,
agrees what each screen must show, and the approved mock becomes `ui/tests/manual_regression/<area>/<name>.md`.
The `.md.ts` is written afterwards the usual way (`ui/tests/manual_regression/run_test_instructions.md`) — not here.

- **Look for an existing scenario first** (`grep -ril "<words of the flow>" ui/tests/manual_regression`, skip
  `_results/`). One that covers the flow → show it and offer to extend it instead of a new file.
- **Current UI only.** Real mode, every step `source: capture`; never fast, never `built`. When the request
  differs from the app today — a screen, control or state it does not have — do not draw it. Say so in the
  plan reply: "<X> is not in the app today, so a test cannot check it — build it first, or use plain mockify
  to design it." A bug is not a different UI: for a test that pins a bug, the screen shows the app as it is,
  `expect` says the correct outcome, and the reply says the test fails today.
- **Plan fields** (on top of Phase 1): the mock's `test_md` (repo-relative path) and `setup` (the state the test
  starts from); per step `expect`, and `url` where the test navigates (always the first). Write each `expect` from the captured screen:
  exact label, `data-testid`, state — stable things, never LLM text, times or ids. A check no screen shows
  (no 401, no console error, still there after refresh) is an `expect` on the step where it is checked.
  Phase 3's validator fails a test mock with a drawn step, no first `url` or no `expect`.
- **Branches become tests**: the main path is test 1; each `branch` action (with its `when`) is another test.
- **When the person approves** (in words, or an Execute that says so) — write the `.md`:
  ```bash
  DM ds-rows <mocks dataset> --match '{"key": "<slug>"}' > <scratch>/row.json
  "$FLOWPAD_PYTHON" -I <skill>/scripts/test_md.py <scratch>/row.json <repo root> [--replace]
  ```
  An existing file needs `--replace` (it keeps the id). Show the file, list `steps_without_expect`, and stop: the mock stays in the mock project (no Save to
  repo), the `.md` is the scenario from now on, and nothing is committed unless asked.

## The mock project is a temp folder

`$TMPDIR` is emptied by macOS on an update or a restart — the mock, its captures and your build scripts go with it
(the mock row and the feedback rows survive: they live in Flowpad). So: keep the scripts that make the screens
(harness, fixture, change builders, capture) INSIDE the mock folder, not in a session scratchpad; when the person
has walked it once, say in one line that it lives in a temp folder and offer **💾 Save to repo**. If it is gone,
rebuild from the row: re-capture the screens, and recover any screen you cannot re-capture from a copy that was
sent or saved (a message attachment holds the whole page — every `<section data-step>` is a screen).

## Save to repo (only when the person asks)

The popup toolbar's **💾 Save to repo** shows where the mock will go and, on confirm, sends you one line:
`Save mock "<slug>" to the repo: … mock_project.py save <repo> <slug>`. Run exactly that:

```bash
"$FLOWPAD_PYTHON" <this skill>/scripts/mock_project.py save <repo root> <slug>
# {"saved": "<repo>/agentic-assets/webapp/mock-<slug>", "files": [...]}
```

It copies ONE mock into `<repo>/agentic-assets/webapp/mock-<slug>/`: the page and its assets, `mock.json`
(the mock row's value); the page already carries its compiled tree, so it navigates with no datasets. Feedback,
datasets and kinds stay in the mock project. Tell the person the folder and that it is NOT committed —
committing is theirs to ask for.
