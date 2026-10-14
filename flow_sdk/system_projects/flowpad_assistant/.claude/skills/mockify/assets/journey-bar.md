# Journey bar — contract (v2)

`journey-bar.js` is pasted inline, last in `<body>`, in every mock. It is the reviewer's control strip:

**⟲ Restart · ‹ Back · <step title / app trail · n of N> · Next › · ☰ screens · 💬 feedback (n) · Submit (n) · –**

## What the page defines (before the script)

```js
window.MOCKIFY = { key: 'github-prs' };   // the mock's row key in the project's `mocks` dataset
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
| ✕ on an open comment | `deleteRow(key, {expected: version})` |
| **Submit (n)** | `putMany` the open rows to `submitted` (with their versions), the mock row to `status: submitted`, then **one prompt queued** to the mock's `session` (`AgenticProcess.enqueue`, works for terminal and chat sessions): the mock ref + a line per screen |

The bar reads the mock's comments in one query (`match: {input.mock: <ref>}`) — the badge counts the
`open` ones, the panel lists this screen's — and reads again on `onRowsChanged`, never on a timer or a
step change.

## Controls

**Restart** goes to the first screen. **Back / Next** and ←/→ follow the **main path** (branches are
skipped; from a branch Next rejoins the path); ☰ reaches every screen (branches as "↳ when — title");
browser Back/Forward walk the screens visited; arrows are ignored while typing. Drag by ⋮⋮ (kept on
screen, panels open upward when the bar sits low); – minimises to `MOCK · n of N` (+ restores). Position
and minimised state survive reloads (sessionStorage, guarded). The bar **contrasts with the screen behind
it** (it samples the real background: light bar on a dark screen, dark on a light one), re-checked on
every step, drag and resize. Hidden `[data-step]` sections stay hidden even if styled `display:flex`.
`mockifyGo('<id>')` moves the journey from an in-screen button (an unknown id warns, stays put). Under
640px wide the labels and app trail drop. The bar lives in a shadow root: the mock's CSS never restyles it.
