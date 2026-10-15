---
id: 098a70ff-0160-4950-aa04-b7e7d1990ea2
name: mockify
description: 'Turns a product idea into a clickable HTML mock of the user journey
  that the user can walk and comment on — every screen in order, with a journey bar
  (Restart, Back / Next, where the screen sits in the journey, all screens) and a
  per-screen feedback box (text + image) whose comments are saved as typed rows and
  sent back to this session in one Submit. The mock and its feedback are typed data
  (kinds mockify.mock / mockify.feedback, built with the data-management skill). Two
  modes: fast (HTML in the product''s tokens, minutes) and real (built from a running
  app''s own captured DOM and CSS, checked side by side so it looks exactly like the
  app). Use for "mock this flow", "show me the UX", "prototype the journey", "how
  would the user do X — show me", "make a clickable mock", or a design discussion that
  needs screens before code; also when feedback on a mock arrives. NOT for a working
  app (web-app-builder), a one-page report or chart (html-builder), or slides (decker).'
---

# mockify — a clickable journey the user can give feedback on

A mock exists to get a decision. It shows the journey screen by screen, in the product's own look, with
the details being discussed written ON the screens; the reviewer walks it, leaves comments per screen,
and submits them back to you. It is not the product: no backend of its own, no real data.

**A mock is data.** Its journey is a `mockify.mock` row in the project's `mocks` dataset; every comment
is a `mockify.feedback` row in `mock-feedback` (text, optional image, optional decision id, status).
The page reads and writes those rows through the Flowpad SDK. Every data step follows the
**data-management** skill — load it, and obey its ground rules (probe first, rows only through
`dm_ctl` / the SDK, never by hand). `DM` below is its `dm_ctl` shell function.

## 0. Once per project: the kinds and datasets

```bash
python3 -I <this skill>/scripts/install_data.py <project root>      # prints the next commands
flow schema apply <project>/agentic-assets/data_schema               # exit 0, every status ok
flow record index <project>/agentic-assets/dataset/mocks --types dataset
flow record index <project>/agentic-assets/dataset/mock-feedback --types dataset
```

It copies `schema/` (the four kinds) under the project's own `ns` and writes the two `dataset.json`.
No `ns` yet: data-management `schema` mode, Gate 1. First time on this Flowpad: prove the kinds in a
data-management probe (good value fits, a broken one is refused) before installing.

## 1. Pin the journey — as the mock row

List the steps and send them to the user in one short message, then write the row:

```
id        app      title                  note (the detail the user should react to)
home      Flowpad  Home                   where the user starts
pick      Flowpad  "+" Add a channel      the tile says what it needs
grant     GitHub   Authorize Flowpad      long-term OAuth, revocable on GitHub
denied    GitHub   ↳ if denied            blocks the channel, Retry          (branch_of: grant)
done      Flowpad  Listening              PRs arrive as conversations
```

```bash
DM ds-put <project>/agentic-assets/dataset/mocks <slug> '{"input": {"title": "…", "mode": "fast",
  "status": "draft", "session": "<this process id>", "journey": [{"id": "home", "app": "Flowpad",
  "title": "Home", "note": "…", "decisions": [{"id": "D1", "question": "…", "shown": "…"}]}, …]}}'
```

- **Start where the user really starts** (often the screen they already live in). If unsure, ask once.
- One step per screen. `app` names the product the screen lives in.
- A branch (failure, cancel, "finish later") has `branch_of: <step id>` and `when` ("if denied"); it sits
  right after the step it branches from. A screen that goes on somewhere other than the next main-path screen (a
  branch's "Try again") says so with `next: <step id>`. Back / Next follow the main path; branches are reached from
  their screen's own buttons or the screens list.
- Decisions get ids unique across the mock (D1, D2…) in the step that asks them.
- `session` is YOUR agentic process id (`flow context`) — where Submit sends the feedback.
- `DM check` the value against `mockify.mock` before the put; a refused put writes nothing.

## 2. Pick the mode

| mode | when | fidelity |
|---|---|---|
| **fast** | the screens are new, in a third-party product, or a first rough pass | recognisable |
| **real** | the screens extend an app that runs here (Flowpad, the user's app) | identical |

When the user says the mock "doesn't look like our app", that is real mode — do not restyle by hand again.

- **fast**: copy `templates/fast-mock/` to `<project>/agentic-assets/webapp/mock-<slug>/`, fill
  `webapp.json`, set `MOCKIFY.key = '<slug>'`, one `<section data-step="<id>">` per step. Flowpad screens use
  `/sdk/flowpad.css`; another product gets its recognisable frame (colours, font, logo text).
- **real**: follow `reference/real-capture.md` — capture the live app's DOM and CSS on a test instance,
  build new screens by cloning its real elements and using its components' own classes (checked with
  `scripts/check_classes.py`), assemble with `scripts/build_mock.py --key <slug>` into the same webapp folder.

## 3. The journey bar — always, never hand-made

Paste `assets/journey-bar.js` inline as the last script (build_mock.py does it in real mode) and set
`MOCKIFY.key = '<slug>'`. It reads the mock row and gives the reviewer Restart, Back / Next, where they
are, the screens list, per-screen feedback and Submit — contract and controls: `assets/journey-bar.md`.
Every control on a screen that moves the journey says where it leads with **`data-next="<step id>"`** — a
click on it then moves the journey by itself; no `onclick` needed.

## 4. Put the discussed details on the screens

- Real copy, not lorem: the exact button labels, the sentence that explains what is missing, the error
  text. A user reacts to words.
- Every state the discussion named: empty, waiting, failed, done, "finish later".
- Say what each control does when it is not obvious (a one-line hint in the screen's own style).
- **Show the way forward.** Mark EVERY control that moves the journey with `data-next="<step id>"` — the
  main button and the branches (Cancel, Skip, Try again); the bar mildly highlights the one that goes on
  (`assets/journey-bar.md`). A screen with no marked control is a dead end for the reviewer — fix it.
- **Open decisions**: mark the element with `data-decision="D2"` — the id from the mock row; the bar
  offers that screen's decisions as chips on the feedback box.
- No invented scope: mock what was discussed; a gap you noticed goes in the reply, not on a screen.

## 5. Serve it through Flowpad and verify in a browser

```bash
flow app serve "Mock — <title>"      # from the mock's webapp folder; the URL it prints is app_url
DM ds-put <mocks dataset> <slug> '{"input": {…, "app_url": "<url>", "status": "in_review"}}'
```

Served by Flowpad, the page reaches the SDK at `/sdk/flowpad-sdk.js` — feedback saves. The app is served at
`/api/v1/graph/service_endpoint/<endpoint id>/service/<route>/` (both in the command's JSON: `endpoint.id`,
`endpoint.route`) — that is `app_url`; add `#<step id>` to open a screen. Run it from your own session (it
shows the app there); from elsewhere pass `--process <id> --no-show`. (A mock opened
from a bare `python3 -m http.server` still navigates, but its 💬 says feedback is off.)

Then in the browser (Chrome tools or `real-browser`, your own tab): open every step as a new load
(`?v=<n>#<id>` — a hash change alone does not reload), screenshot, fix what is off; click the main path
end to end and Restart once; save one comment with an image and delete it again (its row must appear
and go, `DM ds-rows`). Real mode: put each new screen beside the live app (`reference/real-capture.md` §6).
Phone width: when the window will not resize, load the mock in a 390px `<iframe>` on a scratch page.
Never report a mock you have not looked at.

## 6. Present

`flow show webapp` with the served app, then reply with: the step list (one line each), what is real vs
invented, the open decisions (D1…), and one line: "Walk it, press 💬 on any screen to leave a comment or
an image, and **Submit** when done — it comes back to me." Mention anything the real app did along the
way that looked wrong.

## 7. Reading feedback (when a Submit prompt arrives)

The prompt names the mock and its ref. Read the comments as rows:

```bash
DM ds-rows <project>/agentic-assets/dataset/mock-feedback \
  --match '{"input.mock": "<mock ref>", "input.status": "submitted"}'
```

Each row: `step`, `text`, `decision` (a D-id it answers), `screenshot` (an image — it is on disk as
`<row folder>/input/screenshot.<ext>`; open it), `created`. Then:

1. Answer per step and per decision, in the mock's journey order — say what you will change and what
   you will not, and why.
2. Revise the screens and the mock row (`DM ds-put` the row with its new journey / decisions; settled
   decisions leave the row, their answer goes into the screen).
3. Set each comment you acted on to `addressed` (`DM ds-put-many` with their versions); set the mock to
   `revised`, then `in_review` again once re-shown.
4. Verify again (§5) and re-show.
