---
id: 3f8618bb-02a2-48c1-905e-47f10f0a7329
name: chartit
description: 'Builds an interactive HTML chart the user steers by commenting on it
  — the chart is drawn from a typed row, a feedback toolbar lets the reviewer click
  any element (a box, an arrow), leave a comment (text + image) and Submit; the comments
  come back to this session, you edit the row, and the open chart redraws live. The
  chart and its feedback are typed data (kinds chartit.chart / chartit.feedback, built
  with the data-management skill). Chart types: sequence (a network flow / message
  flow between participants, with self-calls). Use for "chart this flow", "draw the
  network flow", "sequence diagram of X", "a chart I can comment on", or when feedback
  on a chart arrives. NOT for a clickable UX journey (mockify), a static report or
  dashboard (html-builder), or slides (decker).'
---

# chartit — a chart the user steers by commenting on it

A chart is **data plus a renderer**. Its content is a `chartit.chart` row in the project's `charts`
dataset; the page only draws that row and redraws whenever it changes. Every comment is a
`chartit.feedback` row in `chart-feedback` (text, optional image, optional `target` = the element id,
status). **You never edit the chart's HTML to change the chart — you edit the row.** Every data step
follows the **data-management** skill — load it and obey its ground rules (rows only through `dm_ctl`
/ the SDK). `DM` below is its `dm_ctl` shell function.

| type | data field | template |
|---|---|---|
| `sequence` — network / message flow | `sequence: {participants, messages}` | `templates/sequence/` |

## 0. Once per project: the kinds and datasets

```bash
python3 -I <this skill>/scripts/install_data.py <project root>      # prints the next commands
flow schema apply <project>/agentic-assets/data_schema               # exit 0, every status ok
flow record index <project>/agentic-assets/dataset/charts --types dataset
flow record index <project>/agentic-assets/dataset/chart-feedback --types dataset
```

No `ns` yet: data-management `schema` mode, Gate 1.

## 1. Write the chart row

From the user's description, picture or text, write the data. A sequence chart:

- `participants` left to right: `{id, label, note?}` — `label` may carry a second line after `\n`
  (`"TranslatorAPI\n(GoogleTranslatorAPI)"`).
- `messages` top to bottom: `{id, from, to, label, style?, note?}` — ids `m1, m2…` (what comments
  target); `from == to` is a self-call (a loop on the lifeline); `style: "dashed"` for a reply.
- Copy labels exactly as given (typos included — ask before "fixing" them).

```bash
DM check '--<ns>--.chartit.chart' '{"title": "…", "type": "sequence", "status": "draft",
  "session": "<this process id>", "sequence": {"participants": […], "messages": […]}}'
DM ds-put <project>/agentic-assets/dataset/charts <slug> '{"input": {…same value…}}'
```

`session` is YOUR agentic process id (`flow context`) — where Submit sends the feedback.

## 2. The page — copy the template, never hand-draw

Copy `templates/<type>/` to `<project>/agentic-assets/webapp/chart-<slug>/`, fill `webapp.json`, set
`CHARTIT.key = '<slug>'`, and paste `assets/feedback-toolbar.js` inline into the last `<script>`.
Nothing else changes in the page. Then:

```bash
flow app serve "Chart — <title>"      # from the chart's webapp folder; the URL it prints is app_url
DM ds-put <charts dataset> <slug> '{"input": {…, "app_url": "<url>", "status": "in_review"}}'
```

Served by Flowpad, the page reaches the SDK at `/sdk/flowpad-sdk.js` — feedback saves. Opened as a bare
file it still draws from `CHARTIT.chart` (an optional offline copy of the row's input); feedback is off.

## 3. The feedback toolbar (contract)

`feedback-toolbar.js` reads the chart row by `CHARTIT.key` (`Dataset.forKind('chartit.chart')`), calls
`window.chartitRender(input)` on load and on every row change, and gives the reviewer:
**CHART · <picked element> · 💬 Feedback (n) · Submit (n)**.

| reviewer does | the toolbar writes |
|---|---|
| clicks a box / arrow (any `[data-target]`) | picks it (glow); clicking it again picks the whole chart |
| 💬 → text (+ 📎 / pasted image) → **Save** | `append` a `chartit.feedback` row: `chart` = the row's `ref`, `target?`, `text`, `screenshot?`, `status: open`, `created` |
| ✕ on an open comment | `deleteRow(key, {expected: version})` |
| **Submit (n)** | queues one prompt to `session` (`AgenticProcess.enqueue`), then sets the rows and the chart to `submitted` |

A new renderer (a new chart type) must only draw from the value and mark every commentable element with
`data-target="<id>"` and `data-label="<short name>"` — the toolbar does the rest.

## 4. Verify, then present

In a browser (Chrome tools or `real-browser`, your own tab): load the served URL, screenshot, compare to
what the user gave you (every participant, every arrow, in order, self-calls on the right lifeline);
click one arrow, save a comment and delete it again (`DM ds-rows` shows it come and go). Never report a
chart you have not looked at. Then `flow show webapp` and reply with one line: "Click any box or arrow,
press 💬 to comment, and **Submit** when done — it comes back to me and the chart redraws here."

## 5. Reading feedback (when a Submit prompt arrives)

```bash
DM ds-rows <project>/agentic-assets/dataset/chart-feedback \
  --match '{"input.chart": "<chart ref>", "input.status": "submitted"}'
```

Each row: `target` (a participant or message id; none = whole chart), `text`, `screenshot` (on disk as
`<row folder>/input/screenshot.<ext>` — open it). Then:

1. Say per comment what you will change and what not, and why.
2. `DM ds-put` the chart row with the new data and `status: revised` — the open page redraws by itself.
3. Set each comment you acted on to `addressed` (`DM ds-put-many` with their versions); set the chart
   back to `in_review`.
4. Look at it again (§4).
