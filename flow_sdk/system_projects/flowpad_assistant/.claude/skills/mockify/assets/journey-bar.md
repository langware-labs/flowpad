# Journey bar — contract (v2)

`journey-bar.js` is pasted inline, last in `<body>`, in every mock. It is the reviewer's control strip:

**🎯 · ⟲ Restart · ‹ Back · <step title / app trail · n of N> · Next › · ☰ screens · ▶ Execute (n) · –**

Every popup (☰ screens, feedback, review, save) opens with the same toolbar: **💬 Feedback · Review · 💾 Save to repo**.

## What the page defines (before the script)

```js
window.MOCKIFY = { key: 'github-prs',   // the mock's row key in the mock project's `mocks` dataset
                   project: '<id>' };    // the mock project's id (mock_project.py ensure → project_id)
window.mockGo = (id) => { location.hash = id; location.reload(); };   // real mode only
window.MOCK_BAR_AT = 'bottom';            // real mode: start bottom-right (build_mock.py sets it)
```

Everything else comes from the **mock row** (`mockify.mock`, `schema/`): `journey` — the steps in order —
and on each step `id`, `app`, `title`, `note`, `branch_of` + `when` for a branch, `next`, `decisions` (`id`, `question`,
`shown`). Screens are `<section data-step="<id>">` (fast mode; the bar shows/hides them) or drawn on load by
the page's own script (real mode, via `mockGo`). A decision shown on a screen is `data-decision="D2"`.

A control that moves the journey says where it leads: **`data-next="<step id>"`** — and nothing else (no
`onclick`): a click on it moves the journey. Where a screen goes ON is its step's `next`, else the next
main-path screen; Next and the hints follow that one rule. On every screen the bar marks the controls in
the page: the one going on gets `.mk-next` (a soft glow in the bar's accent, a few gentle pulses unless the
reviewer prefers reduced motion), every other one `.mk-path` (a faint ring); with no control going on,
the bar's own Next glows. Both use `box-shadow`, so a screen's own outlines (an open decision) stay. A
`data-next` naming no step warns once in the console. The reviewer can switch hints off at the bottom of
the screens list (remembered for the session).

`MOCKIFY.journey` (same step shape) is an optional OFFLINE copy, used only when the page is not served by
Flowpad: navigation works from it, feedback is off.

## Data, through the Flowpad SDK

The bar imports `/sdk/flowpad-sdk.js` (the page must be served by Flowpad — `flow app serve`), runs
`initSdk()`, resolves the project from its own URL (`resolveAppHost`), and finds the datasets by kind:
`Dataset.forKind('mockify.mock' | 'mockify.feedback', projectId)`. It never computes an id or writes files.

| reviewer does | the bar writes |
|---|---|
| 💬 → text (+ decision chip, + 📎 / pasted image) → **Save** | `append` one `mockify.feedback` row: `mock` = the mock row's `ref`, `step`, `text`, `decision?`, `screenshot?` (a `data:image/…;base64` URL — stored as `input/screenshot.png`), `status: open`, `created`; key `<mock>-<step>-<base36 time>` |
| 🎯 → point at an element (hover outlines it, Esc cancels) → the feedback box opens on it → **Save** | the same row, plus `anchor` (`mockify.anchor`: a `selector` from the screen's `[data-step]` or an id, the element's `label`, its `html`, its position `x y w h`) and `element_shot` (the element drawn through an SVG `foreignObject`, best effort: no picture for a big subtree or a cross-origin image) |
| ✕ on an open comment | `deleteRow(key, {expected: version})` |
| **▶ Execute (n)** on the bar | what **Send to <session>** below does, for the open comments — no review first; greyed with none open or no session |
| **Review** (popup toolbar) | nothing yet: opens the review panel — the open comments as ONE markdown document (screen by screen in journey order; each with its decision, the element it is on and its selector, and the paths of its images under the mock-feedback dataset folder), with **📁 Open folder** (the mock row's `folder`, shown in Finder / Explorer through the compute node), **⧉ Copy** and **Send ▶** |
| **Send to <session> ▶** | uploads **that same markdown** as a file into the mock's `session` input folder and queues ONE line pointing at it ("File <name>.md is available here: <path>" — a multi-line prompt typed into a terminal session sits unsubmitted in its input box); `Send again` re-delivers the already-sent markdown the same way. Then, for new comments, `putMany` the open rows to `submitted` (with their versions) and the mock row to `status: submitted` |

A comment on an element shows as a numbered **bubble** at that element (at its saved spot when the selector no
longer finds it; grey once submitted); a click on the bubble opens the comment and outlines the element.

The bar reads the mock's comments in one query (`match: {input.mock: <ref>}`) — the badge counts the
`open` ones, the panel lists this screen's — and reads again on `onRowsChanged`, never on a timer or a
step change.

## Controls

**Restart** goes to the first screen. **Back / Next** and ←/→ follow the **main path** (branches are
skipped; from a branch Next rejoins the path); ☰ reaches every screen (branches as "↳ when — title");
browser Back/Forward walk the screens visited; arrows are ignored while typing. Every panel (screens, feedback) closes with its ✕ or Esc;
the comment typed so far stays until Save, and a successful Save folds the box
away and shows the saved entry, highlighted, in the panel (＋ New comment brings the box back). Drag by ⋮⋮ (kept on
screen, panels open upward when the bar sits low); – minimises to `🎯 · n of N` (+ restores). Position
and minimised state survive reloads (sessionStorage, guarded). The bar **contrasts with the screen behind
it** (it samples the real background: light bar on a dark screen, dark on a light one), re-checked on
every step, drag and resize. Hidden `[data-step]` sections stay hidden even if styled `display:flex`.
`mockifyGo('<id>')` moves the journey from an in-screen button (an unknown id warns, stays put). Under
640px wide the labels and app trail drop. The bar lives in a shadow root: the mock's CSS never restyles it.
