---
id: 098a70ff-0160-4950-aa04-b7e7d1990ea2
name: mockify
description: 'Turns a product idea into a clickable HTML mock of the user journey
  that the user can walk and comment on — every screen in order, with a journey bar
  and a per-screen feedback box (text + image) whose comments are saved as typed rows and
  sent back to this session in one Execute. The mock and its feedback are typed data
  (kinds mockify.mock / mockify.feedback). Two
  modes: real, the default (built from a running app''s own captured DOM and CSS,
  checked side by side so it looks exactly like the app), and fast (HTML in the
  product''s tokens, minutes — only for a product that does not run here, or when
  the user asks for a rough sketch). Use for "mock this flow", "show me the UX", "prototype the journey", "how
  would the user do X — show me", "make a clickable mock", or a design discussion that
  needs screens before code; also when feedback on a mock arrives. NOT for a working
  app (web-app-builder), a one-page report or chart (html-builder), or slides (decker).'
---

# mockify — a clickable journey the user can give feedback on

A mock exists to get a decision. It shows the journey screen by screen, in the product's own look, with
the details being discussed written ON the screens; the reviewer walks it, leaves comments per screen,
and submits them back to you. It is not the product: no backend of its own, no real data.

**A mock never lives in the repo.** Every mock, its kinds, its datasets and its feedback live in the
**mock project** — `$TMPDIR/mockify/<repo folder name>/`, a Flowpad project of its own outside the repo.
Nothing is written into the repo until the person presses **💾 Save to repo** (the journey bar's popup toolbar) (or asks for it in
words) — then §8 copies that one mock in. Never `install_data.py`, `DM ds-put` or a mock folder into the repo.

**A mock is data.** Its journey is a `mockify.mock` row in the mock project's `mocks` dataset; every comment
is a `mockify.feedback` row in `mock-feedback` (text, optional image, optional decision id, status).
The page reads and writes those rows through the Flowpad SDK. Every data step follows the
**data-management** skill — load it, and obey its ground rules (probe first, rows only through
`dm_ctl` / the SDK, never by hand). `DM` below is its `dm_ctl` shell function.

## 0. The mock project (once per repo, again whenever the skill's kinds change)

```bash
"$FLOWPAD_PYTHON" <this skill>/scripts/mock_project.py ensure <repo root>
# {"root": "<mock project>", "project_id", "ns", "mocks": "<…/dataset/mocks>", "feedback": "<…/dataset/mock-feedback>", "webapps": "<…/webapp>"}
```

It makes (or finds) `$TMPDIR/mockify/<repo folder name>/`, registers it as a project, installs the kinds
(`schema/`, in the repo's namespace) and the `mocks` / `mock-feedback` datasets, applies and indexes them.
Repeat it any time: it finds the same project. `<mock project>` below is its `root`. First time on this
Flowpad: prove the kinds in a data-management probe (good value fits, a broken one is refused).

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
DM ds-put <mock project>/agentic-assets/dataset/mocks <slug> '{"input": {"title": "…", "mode": "real",
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
- `session` is YOUR agentic process id (`flow context`) — where Send delivers the feedback.
- `folder` is the mock's web app folder in the mock project (absolute) — the review panel's Open folder shows it.
- `repo` is the repo root (absolute) — where **💾 Save to repo** puts the mock (§8).
- `DM check` the value against `mockify.mock` before the put; a refused put writes nothing.

## 2. Pick the mode — real is the default

| mode | when | fidelity |
|---|---|---|
| **real** (default) | any screen of an app that runs here — Flowpad, the user's app — new, redesigned or existing | identical |
| **fast** | only a product that does not run here (a third-party site), or when the user asks for a rough sketch | recognisable |

Use **real** unless one of fast's two reasons holds. A screen being "new" is not one: every redesigned
screen is new, and it still has to be built from the app's own components. `/sdk/flowpad.css` carries
tokens only (colours, radius, theme) — no button, card, tab, badge or dialog — so a fast Flowpad screen is
hand-made components that match the colours and miss the shapes. When the user says the mock "doesn't
look like our app", it was built fast: rebuild it real — do not restyle by hand again.

- **real**: follow `reference/real-capture.md` — capture the live app's DOM and CSS on a test instance,
  build new screens by cloning its real elements and using its components' own classes (checked with
  `scripts/check_classes.py`), assemble with `scripts/build_mock.py --key <slug> --project <project_id>` into the same webapp folder.
- **fast**: copy `templates/fast-mock/` to `<mock project>/agentic-assets/webapp/mock-<slug>/`, fill
  `webapp.json`, set `MOCKIFY.key = '<slug>'` and `MOCKIFY.project = '<project_id>'` (from §0), one `<section data-step="<id>">` per step. The product gets its
  recognisable frame (colours, font, logo text); a Flowpad sketch uses `/sdk/flowpad.css` for its tokens.

## 3. The journey bar — always, never hand-made

Paste `assets/journey-bar.js` inline as the last script (build_mock.py does it in real mode) and set
`MOCKIFY.key = '<slug>'` and `MOCKIFY.project` (build_mock.py `--project <project_id>`). It reads the mock row and gives the reviewer Restart, Back / Next, where they
are, the screens list, per-screen feedback and ▶ Execute — contract and controls: `assets/journey-bar.md`.
Its 🎯 picker (where the MOCK label was) lets the reviewer point at one element and comment on it, like
DevTools' element picker; the comment keeps where it is and a numbered bubble marks it on the screen.
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
invented, the open decisions (D1…), and one line: "Walk it, use 🎯 or ☰ → 💬 Feedback to leave a comment or
an image, then **▶ Execute** sends me what you have so far (☰ → Review shows exactly what I receive)." Mention anything the real app did along the
way that looked wrong.

## 7. Reading feedback (when a Send prompt arrives)

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
4. Verify again (§5) and re-show.

## 8. Save to repo (only when the person asks)

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
