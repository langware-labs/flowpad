---
id: 3f8618bb-02a2-48c1-905e-47f10f0a7329
name: chartit
description: 'Builds and edits Flowpad Charts — one entity for every kind of chart,
  opened in Flowpad''s own chart editor: a sequence (message flow between participants,
  with sub-flow blocks that open other charts), a flowchart (a decision flow of short
  questions and outcomes, with state and notes beside it), a C4 architecture diagram
  (context to deployment views), an architecture chart (services, stores and clients in
  grouped boxes), an Excalidraw whiteboard, or a Mermaid diagram. Picks the format, writes
  the chart''s files, indexes it, and shows it. For review comments on charts, show them in
  a mockify mock.
  Use for "chart this flow", "draw the network flow", "sequence diagram of X", "flowchart /
  decision flow of X", "C4 diagram", "software architecture of X", "services / db diagram",
  "make a whiteboard / board / diagram", "mermaid diagram", or converting a chart between
  formats. NOT for a clickable UX journey (mockify), a data dashboard or report with numbers
  (html-builder + dataviz), or slides (decker).'
---

# chartit — every chart is one Chart entity

A **Chart** is a folder asset `<project>/agentic-assets/chart/<name>/`. It is indexed, searchable,
shareable, and opens in Flowpad's chart editor, which draws it by its **`format`**.

The skill is a **base** plus one file per chart type. This file is the base: what every chart is, how
to pick the type, and the rules, checks and steps every type shares. The type's own file adds its data
and its drawing rules — **read that one file before you write the chart**.

| format | when | the chart's content | read |
|---|---|---|---|
| `sequence` | who calls whom, in order: protocols, auth flows, request paths, integrations | `chart.json` (kind `chartit.sequence`) | `formats/sequence.md` |
| `flowchart` | a decision flow: which way a request goes and what decides it | `flowchart.json` (kind `chartit.flowchart`) | `formats/flowchart.md` |
| `c4` | software architecture: people, systems, containers, stores, components, and how they talk — at one C4 level per chart | `c4.json` (kind `chartit.c4`) | `formats/c4.md` |
| `architecture` | the real deployment in one picture: services, databases, clients and where each runs, with numbered steps of one request | `architecture.json` (kind `chartit.architecture`) | `formats/architecture.md` |
| `excalidraw` | a free sketch: architecture boxes, a layout, a rough idea | `board.json` (Excalidraw scene) | `formats/excalidraw.md` |
| `mermaid` | a state machine, ER or class diagram, gantt — anything Mermaid draws well | the ```` ```mermaid ```` block in `CHART.md` | `formats/mermaid.md` |

Every chart folder has `CHART.md`: frontmatter `name`, `description`, `format`, `session` (your agentic
process id — `flow context`) and a short prose note. The editor's **Update CHART.md** writes a Mermaid
copy of a `sequence`, `flowchart`, `c4`, `architecture` or `excalidraw` chart into it — that is how any
chart reads as text. Never write `thumbnail.svg`; the editor makes it.

## 1. Pick the format

**One request → ONE chart.** Pick the single format that answers it and put everything in that chart
(a sequence can carry state changes as self-calls, an architecture chart its steps). Never add a
second chart "to complement" the first. More than one only when the person asks for several, or a
sequence set's repeated sub-flow is real.

- Several actors exchanging messages over time → `sequence`.
- Which way something goes and what decides it (routing, eligibility, a fallback chain) → `flowchart`.
- What a system is made of and what it talks to → `c4` (a request walking through it, numbered → `c4`
  with `level: dynamic`).
- The real deployment in one picture — which services, stores and clients run where, and the steps of
  one request through them → `architecture`.
- Free layout → `excalidraw`. A state machine, ER, class diagram or gantt → `mermaid`.

## 2. The base: what every chart type shares

Every native type (`sequence`, `flowchart`, `c4`, `architecture`) has the sequence chart's look and
feel: the same tokens, the same controls, the same behaviour. A chart type adds its canvas, nothing else, so:

- **The file holds facts only** — never a colour, a size or a position. The editor owns the look:
  shared tokens with their own dark set, hairline and recessive structure, colour for identity only
  while text stays in ink. A review asking for a colour or a layout is answered by changing the data.
- **Labels are short; detail is a `note`.** A note shows on hover, never on the canvas. Where the facts
  come from code, cite `file:line` in the note. Copy names exactly as the source has them (typos
  included — ask before fixing).
- **Numbers link things.** Steps, questions and badges are numbered by the editor; side panels and the
  Table view use the same numbers. Never write a number into a label.
- **Every type has the same controls**: Diagram / Table (the table carries every value), zoom and Fit,
  hover, and click an element (or **Change chart**) → say what to change → Execute. When such a request
  reaches you, edit the source file, run the type's check, and leave the rest as it is.
- **`ref` opens another chart** (drawn **Open ↗**), any format to any format, and every `ref` gets its
  `flow dep add` link (§3).
- **Icons must resolve.** Where a type takes an `icon`:
  - It is an icon tag (`<pack>.<icon>`) that MUST resolve, from an icon pack that exists: the
    built-in `brands.*` (`brands.slack`) and `lucide.*` (`lucide.database`, `lucide.server`,
    `lucide.user`, `lucide.app-window`, `lucide.cloud`), or an icon pack ASSET in any scope —
    `<scope>/agentic-assets/icon_pack/<name>/` (`icon_pack.json` + SVGs), e.g. the project's own
    `acme-vendors.sonos`. Use an existing pack's tags first.
  - A vendor's mark missing: add it to the PROJECT's icon pack asset (create
    `agentic-assets/icon_pack/<project>-vendors/` if there is none) — the SVG under `assets/`, a
    single-colour mark with no `<script>`, no `on*` handlers and no external `href`/`url()`; its
    manifest entry `{"kind": "<vendor>", "asset": "assets/<vendor>.svg", "color": "#hex", "source":
    "<where it came from + license>"}`. Never edit Flowpad's built-in packs from a project.
  - Check before you finish: `flow icons check <tag> … --path <chart folder>` must print `ok` for every
    tag and every pack (exit 0). An index of the chart also records unresolved icons on the chart's
    `problems`. Never leave an unresolved tag — the card would show a fallback glyph.
- **Size**: past a type's limit, split by `ref` — never shrink the text.

### Write it

A chart lives in `<project>/agentic-assets/chart/<name>/` by default. When it documents a part of the
project, it may instead live with the docs: `<project>/docs/<area>/<name>/` (a folder holding `CHART.md`)
— it is the same Chart entity, and the project tree shows it as `docs › <area> › <name>`. Names stay
unique per project either way (`ref` resolves by name).

```bash
D=<project>/agentic-assets/chart/<name>        # or <project>/docs/<area>/<name>; name unique in the project
mkdir -p "$D"
cat > "$D/CHART.md" <<'EOF'
---
name: <name>
description: "<2–3 sentences: what this flow is, when it runs, what it ends with — shown under the title; keep the quotes, a colon inside breaks indexing otherwise>"
format: sequence
session: <your agentic process id>
---
<one or two sentences of context: what system, what it is for>
EOF
```

Then write the type's source file as its `formats/<format>.md` says, run that file's check, and index
and show the chart:

```bash
flow record index "$D" --types chart        # prints the chart-<uuid> TypeId
flow show entity chart-<uuid>
```

## 3. A chart is an asset — link it both ways

A chart is a folder asset like any other, so it takes part in Flowpad's asset links: an optional
`flow.json` in an asset's folder names other assets **by id** (`docs/snippets/asset-dependencies.md`).
Never invent a second link format.

- **A chart's children** — the assets the chart is about or is made of: the sub-flow charts it opens,
  and the real assets on its lanes (a data source, a credential, a webapp, a skill). Write them into the
  CHART's `flow.json`:
  ```bash
  flow dep add chart-<sub-flow uuid>       --asset chart-<this uuid> --label "Token refresh"
  flow dep add data_source-<uuid>          --asset chart-<this uuid> --label "Hue connector"
  ```
  Every message with `ref` MUST have its chart listed here — `ref` (the name) draws the block, the
  dependency is what makes the link real (share and include bring it along; a missing one reads
  `not_found`).
- **Charts of another asset** — an asset that HAS charts (a data source documented by its auth flow, a
  project by its architecture) lists them in ITS `flow.json`:
  ```bash
  flow dep add chart-<uuid> --asset data_source-<uuid> --label "Auth flow"
  ```
- A participant that IS an asset carries its id in `note` (`"note": "data_source-<uuid> · server.js:211"`)
  so a reader can jump to it.
- A **chart set** (an overview with sub-flows) is a tree: the overview chart depends on each flow chart,
  each flow chart on the shared sub-flow charts it opens. Shared sub-flows are leaves many charts point
  to — draw each once.
- `flow dep list` (from the project folder) shows every link and its state; run it before reporting.

## 4. Review

Charts carry no comment bar. To get comments on charts, show them in a **mockify** mock (one screen per
chart, captured from the chart editor): the reviewer comments per screen there and Execute sends the
comments to this session. A review asking for a colour or layout change is answered by changing the data.

## 5. Converting

The editor's **Convert to Excalidraw** turns a sequence or mermaid chart into an editable whiteboard (a
new chart, `<name>-board`). To go the other way, read the synced Mermaid block in `CHART.md` and write a
new `sequence` / `mermaid` chart from it.

## 6. Verify before you report

Open the chart (`flow show entity`) and look at it — every participant and arrow present, in order,
self-calls on the right lane, each Open ↗ reaching its chart. For a C4 chart: every box inside its
boundary, no label sitting on a line, each Open ↗ reaching the chart one level down. For a flowchart:
the three rules of `formats/flowchart.md` hold on screen. Never report a chart you have not seen.
