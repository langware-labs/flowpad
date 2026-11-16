# Journey bar — contract (v2)

`journey-bar.js` is pasted inline, last in `<body>`, in every mock. It is the reviewer's control strip:

**🎯 · ⟲ Restart · ‹ Back · <step title / app trail · n of N> · Next › · ☰ screens · ▶ Execute (n) · –**

Every popup (☰ screens, feedback, review, save) opens with the same toolbar: **💬 Feedback · Review · 💾 Save to repo**.

## What the page defines (before the script)

```js
window.MOCKIFY = { tree: {…},          // the compiled mock tree (tree.py compile) — what window.mock walks
                   key: 'github-prs',   // the mock's row key in the mock project's `mocks` dataset
                   project: '<id>' };    // the mock project's id (mock_project.py ensure → project_id)
window.MOCK_BAR_AT = 'bottom';
// build_mock.py also sets MOCKIFY.schemas (the mock project's data_schema folder): when a backend restart left
// the kinds unloaded, the bar applies that folder once and retries instead of switching feedback off.            // real mode: start bottom-right (build_mock.py sets it)
```

## The mock tree and `window.mock`

`build_mock.py` validates the row's `tree` (`scripts/tree.py`), compiles it and writes it into the page as
`MOCKIFY.tree`: the screens **in DFS order**, each with `num`, `depth`, `parent`, `via` / `via_kind`, `when` and
`state`. It inlines `assets/mock-tree.js` before the bar, which exposes the walk:

```js
mock.next()   mock.back()   mock.reset()   mock.go('<screen id>')   // each returns false when it cannot move
mock.current  mock.index    mock.canNext   mock.canBack   mock.screens
mock.state    // { current, visited: [...], vars: { desk: 'on', ticket: 'picked' } }
mock.onChange((mock, how) => …)                                      // how: next | back | reset | go | hash
```

Next is the next screen of that order, Back the previous, Restart the root. The bar's buttons, the arrow keys, the
address bar's `#<id>`, a `data-next` click and the ☰ list all move through `window.mock`; the bar only paints.
Nothing in the bar decides an order, and a screen's tag (EXISTING / NEW) never takes it off the walk.

Screens are `<section data-step="<id>">`, one per screen, in the tree's order; the bar shows one and hides the
rest (no reloads). A decision shown on a screen is `data-decision="D2"`. The mock row is still read through the
SDK — for the title, session, status and feedback — but never for navigation.

A control that moves the journey says where it leads: **`data-next="<screen id>"`** — and nothing else (no
`onclick`); it must be one of that screen's actions (the validator checks both ways). On every screen the bar
marks the controls in the page: the one leading to where Next goes gets `.mk-next` (a soft glow in the bar's
accent, a few gentle pulses unless the reviewer prefers reduced motion), every other one `.mk-path` (a faint
ring); with no such control, the bar's own Next glows. Both use `box-shadow`, so a screen's own outlines (an open
decision) stay. Anything else on a screen that looks clickable (a pointer cursor, a form field) is not part of the
mock: a click on it shows "Not part of this mock" beside it instead of silently doing nothing; `data-dead` also
dims it, and `data-live` exempts a part the page handles itself. The reviewer can switch hints off at the bottom
of the screens list (remembered for the session). The ☰ list is the tree: indented by depth, numbered 1, 2, 6a,
with NEW tags and what each step changes (`ticket=picked`).

**Who and on what.** The bar's first chip says whose screen it is and its device — `👤 Noa · runs the support
center · 🖥` (📱 iPhone / 📱 Android on a phone step) — from the row's `personas` (`{id, name, role}`) and each step's `persona` / `device` (absent =
the mock's `persona` / `device`). When the persona changes from one screen to the next the chip flashes, so a jump
between people is never silent. The screens list and the feedback markdown carry the persona too. `build_mock.py`
also stamps `data-persona` on each section.

## Data, through the Flowpad SDK

The bar imports `/sdk/flowpad-sdk.js` (the page must be served by Flowpad — `flow app serve`), runs
`initSdk()`, resolves the project from its own URL (`resolveAppHost`), and finds the datasets by kind:
`Dataset.forKind('mockify.mock' | 'mockify.feedback', projectId)`. It never computes an id or writes files.

| reviewer does | the bar writes |
|---|---|
| 💬 → text (+ decision chip, + 📎 / pasted image) → **Save** | `append` one `mockify.feedback` row: `mock` = the mock row's `ref`, `step`, `text`, `decision?`, `screenshot?` (a `data:image/…;base64` URL — stored as `input/screenshot.png`), `status: open`, `created`; key `<mock>-<step>-<base36 time>` |
| 🎯 → point at an element (hover outlines it, Esc cancels) → the feedback box opens on it → **Save** | the same row, plus `anchor` (`mockify.anchor`: a `selector` from the screen's `[data-step]` or an id, the element's `label`, its `html`, its position `x y w h`) and `element_shot` (the element drawn through an SVG `foreignObject`, best effort: no picture for a big subtree or a cross-origin image) |
| ✕ on an open comment | `deleteRow(key, {expected: version})` |
| **▶ Execute (n)** on the bar | what **Send to <session>** below does, for the open comments — no review first — then asks the host to open the session's tab (`navigateHost`); greyed with none open or no session |
| **Review** (popup toolbar) | nothing yet: opens the review panel — the open comments as ONE markdown document (screen by screen in journey order; each with its decision, the element it is on and its selector, and the paths of its images under the mock-feedback dataset folder), with **📁 Open folder** (the mock row's `folder`, shown in Finder / Explorer through the compute node), **⧉ Copy** and **Send ▶** |
| **Send to <session> ▶** | (like ▶ Execute, it then opens the session's tab) uploads **that same markdown** as a file into the mock's `session` input folder and SUBMITS one line pointing at it (`submit`: types it, then a discrete Enter — a queued or multi-line prompt can sit unsent in a terminal session's input box); `Send again` re-delivers the already-sent markdown the same way. Then, for new comments, `putMany` the open rows to `submitted` (with their versions) and the mock row to `status: submitted` |

A comment on an element shows as a numbered **bubble** at that element (at its saved spot when the selector no
longer finds it; grey once submitted); a click on the bubble opens the comment and outlines the element.

The bar reads the mock's comments in one query (`match: {input.mock: <ref>}`) — the badge counts the
`open` ones, the panel lists this screen's — and reads again on `onRowsChanged`, never on a timer or a
step change.

## Controls

**Restart** goes to the first screen. **Back / Next** and ←/→ follow the **main path** (branches are
skipped; from a branch Next rejoins the path); ☰ reaches every screen (branches as "↳ when — title");
browser Back/Forward walk the screens visited; arrows are ignored while typing. Every panel (screens, feedback) closes with its ✕ or Esc;
the comment typed so far stays until Save, and a successful Save closes the panel
back to the clean bar (the comment shows as its bubble and in ▶ Execute (n)). Drag by ⋮⋮ (kept on
screen, panels open upward when the bar sits low); – minimises to `🎯 · n of N` (+ restores). Position
and minimised state are kept for the session (sessionStorage, guarded). The bar **contrasts with the screen behind
it** (it samples the real background: light bar on a dark screen, dark on a light one), re-checked on
every step, drag and resize. Hidden `[data-step]` sections stay hidden even if styled `display:flex`.
`mockifyGo('<id>')` moves the journey from an in-screen button (an unknown id warns, stays put). Under
640px wide the labels and app trail drop. The bar lives in a shadow root: the mock's CSS never restyles it.


## Existing vs new — the UI diff (v4)

Every screen carries a tag, on the screen (top centre) and in the bar's title: **EXISTING** (`path` absent or
`today`; `EXISTING · N changes` when it has some) or **NEW** (`path: "suggested"`). A NEW screen shows no changes,
even if its step lists some (the validator refuses that).

A step's `changes` (`mockify.change`) on an EXISTING screen are drawn as a diff. The screen carries, per change, the
today element `[data-change="<id>"]` and its suggested version `<template data-change-after="<id>">` next to it
(empty = removal; an `.mk-anchor` today element = addition). The view, global and kept for the session:
- **Diff** (default): the template is cloned in after the today element; today is outlined red, the clone green
  (a removal: red, struck through). Each side carries a small circle in its colour with the change's number in git-diff notation — `−2` on today, `+2` on the suggestion;
  its tooltip says the whole thing — `Change 2 · 3 elements removed — <title>`, `… 1 element instead — …`,
  `… added — …`, then the note and the verdict. A rejected change's circles get a red ✕. A block-level
  changed element gets room above it (`.mk-roomy`) so its label covers nothing; labels never sit on each other.
- **Today**: the screen as it is. **After**: the screen as it would ship. Both are CLEAN — no outlines, no labels
  (the EXISTING / NEW tag stays); only **Diff** is annotated.
- A `screen` change: a green `+n ↗` circle on the control that leads there (tooltip: `Change n · opens a NEW screen — <title>`).
- **The label is the verdict**: a click opens the card — the change (title, type, note), **Approved / Rejected**
  (approved by default; a rejected label gets a red ring), options to pick, a comment, Save → a `mockify.feedback`
  row with `change`, `vote`, `choice`. A screen change's card has **Open the new screen ↗**.
- **Changes out of view**: "↓ N changes below" / "↑ N changes above" scrolls to the nearest one; the `N changes`
  counter walks them one by one. Execute sends the rows; a change with no row is approved.
  Next and Back walk the EXISTING screens; a NEW screen is reached through its change's card or a `data-next`.
