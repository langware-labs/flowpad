---
id: 3f8618bb-02a2-48c1-905e-47f10f0a7329
name: chartit
description: 'Builds and edits Flowpad Charts — one entity for every kind of chart,
  opened in Flowpad''s own chart editor: a sequence (network / message flow between
  participants, with sub-flow blocks that open other charts), an Excalidraw whiteboard
  (boxes, arrows, freehand), or a Mermaid diagram. Picks the format, writes the chart''s
  files, indexes it, and shows it; the reviewer clicks any element, comments (text
  + image) and Submits, and the comments come back to this session to revise the chart.
  Use for "chart this flow", "draw the network flow", "sequence diagram of X", "make
  a whiteboard / board / diagram", "mermaid diagram", "a chart I can comment on",
  converting a chart between formats, or when feedback on a chart arrives. NOT for
  a clickable UX journey (mockify), a data dashboard or report with numbers (html-builder
  + dataviz), or slides (decker).'
---

# chartit — every chart is one Chart entity

A **Chart** is a folder asset `<project>/agentic-assets/chart/<name>/`. It is indexed, searchable,
shareable, and opens in Flowpad's chart editor, which draws it by its **`format`**:

| format | when | the chart's content | you edit |
|---|---|---|---|
| `sequence` | who calls whom, in order: protocols, auth flows, request paths, integrations | `chart.json` (kind `chartit.sequence`) | the JSON |
| `excalidraw` | a free sketch: architecture boxes, a layout, a rough idea | `board.json` (Excalidraw scene) | the JSON |
| `mermaid` | a flowchart, state machine, ER or class diagram, gantt — anything Mermaid draws well | the ```` ```mermaid ```` block in `CHART.md` | the block |

Every chart folder has `CHART.md`: frontmatter `name`, `description`, `format`, `session` (your agentic
process id — `flow context` — where feedback goes) and a short prose note. For `sequence` and
`excalidraw` the editor keeps a Mermaid copy in `CHART.md` in sync — that is how any chart reads as text.
Never write `thumbnail.svg`; the editor makes it.

## 1. Pick the format, then cut the flows

- Several actors exchanging messages over time → `sequence`. Free layout → `excalidraw`. A graph of
  states / steps / entities → `mermaid`.
- **Sequence sets: never draw a repeated flow twice.** List every flow first; a run of steps that
  recurs (token refresh, a proxy hop, "select sources") is its own chart, and each place it happens is
  ONE message with `ref: "<that chart's name>"` — a SUB-FLOW block with **Open ↗**. Its output enters
  the calling flow through `returns: "<what comes back>"`.

## 2. Write it

```bash
D=<project>/agentic-assets/chart/<name>        # name: lowercase-dashed, unique in the project
mkdir -p "$D"
cat > "$D/CHART.md" <<'EOF'
---
name: <name>
description: <one line — what the chart shows>
format: sequence
session: <your agentic process id>
---
<one or two sentences of context: what system, what it is for>
EOF
```

**sequence** — `chart.json`, checked against `chartit.sequence` (`DM check`, data-management skill):

```json
{"participants": [{"id": "app", "label": "Acme App", "note": "Flutter — app/frontend"}],
 "messages": [
   {"id": "m1", "from": "app", "to": "tenant", "label": "POST …/oauth/init", "note": "locations-routes.js:182"},
   {"id": "m2", "from": "tenant", "to": "app", "label": "{redirectUrl}", "style": "dashed"},
   {"id": "m3", "from": "conn", "to": "conn", "label": "buildAuthorizeUrl()"},
   {"id": "m4", "from": "conn", "to": "vauth", "label": "Token refresh", "ref": "token-refresh", "returns": "fresh access token"}]}
```

- Participants left to right, initiator first; `label` may carry a second line after `\n`.
- Messages top to bottom, ids `m1, m2…` (what comments target); `from == to` is a self-call;
  `style: "dashed"` for a reply. Labels short (a route or a verb); detail goes in `note` (hover).
- Copy names exactly as the source has them (typos included — ask before fixing).
- Where the facts come from code, cite `file:line` in `note`.

**excalidraw** — `board.json` `{"kind": "excalidraw", "version": 1, "data": {"elements": [...], "appState": {}}}`;
elements `rectangle` / `ellipse` / `diamond` / `arrow` / `text` with `id`, `type`, `x`, `y`, `width`,
`height` (text: `text`, `fontSize`); on a grid, nothing overlapping.

**mermaid** — the diagram goes in one ```` ```mermaid ```` block in `CHART.md` under the prose.

Then index and show it:

```bash
flow record index "$D" --types chart        # prints the chart-<uuid> TypeId
flow show entity chart-<uuid>
```

## 3. Design rules (the editor applies them — don't fight them)

The sequence view follows the `dataviz` skill: participant colours are validated categorical slots in
fixed order (blue, orange, aqua, violet; a 5th+ participant is neutral), never cycled; colour marks
identity on dots and arrows while text stays in ink; lifelines and cards are hairline and recessive;
steps are auto-numbered; replies are dashed; hover lifts one element and recedes the rest; a Table view
carries every value; dark mode is its own token set. Keep a chart under ~25 messages and ≤ 8
participants — past that, cut sub-flows. A comment asking for a colour or style is a data change
(`style`) — never a one-off hex.

## 4. Feedback

Once per project: `python3 -I <this skill>/scripts/install_data.py <project root>` and run the commands
it prints (`flow schema apply`, `flow record index`) — the `chart-feedback` dataset. Without it the
editor's 💬 says why it is off.

The reviewer clicks any box or arrow, presses 💬, writes (text, pasted image) and Saves; **Submit**
sends every open comment to the chart's `session` in one prompt. When it arrives:

```bash
DM ds-rows <project>/agentic-assets/dataset/chart-feedback \
  --match '{"input.chart": "<chart TypeId>", "input.status": "submitted"}'
```

Each row: `target` (participant / message id; none = whole chart), `text`, `screenshot` (on disk as
`<row folder>/input/screenshot.<ext>` — open it). Say per comment what you change and what not, edit the
chart's file, re-index if you renamed anything, set each handled row to `addressed`
(`DM ds-put-many` with versions), and re-show.

## 5. Converting

The editor's **Convert to Excalidraw** turns a sequence or mermaid chart into an editable whiteboard (a
new chart, `<name>-board`). To go the other way, read the synced Mermaid block in `CHART.md` and write a
new `sequence` / `mermaid` chart from it.

## 6. Verify before you report

Open the chart (`flow show entity`) and look at it — every participant and arrow present, in order,
self-calls on the right lane, each Open ↗ reaching its chart. Never report a chart you have not seen.
