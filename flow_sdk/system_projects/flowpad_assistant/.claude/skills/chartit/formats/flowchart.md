# flowchart — a decision flow: short questions, outcomes, state and notes

A chart type of the chartit skill: read `../SKILL.md` first — it sets the folder, the shared rules and how a
chart is indexed, linked, shown and verified. This file adds only what a `flowchart` chart needs.

The file: `flowchart.json`, checked against `chartit.flowchart`. Start from
`templates/flowchart/example.flowchart.json`.

```json
{"title": "Where an order goes",
 "nodes": [
   {"id": "start", "kind": "start", "label": "Customer places an order"},
   {"id": "paid", "kind": "question", "label": "Payment accepted?",
    "state": "The charge's status at the payment provider",
    "note": "A declined card is retried once before this is asked"},
   {"id": "ship", "kind": "outcome", "label": "Ship it", "ref": "order-shipping"},
   {"id": "cancel", "kind": "outcome", "label": "Cancel the order"}],
 "edges": [
   {"from": "start", "to": "paid"},
   {"from": "paid", "to": "ship", "label": "yes"},
   {"from": "paid", "to": "cancel", "label": "no"}],
 "notes": ["Every order is saved before any question is asked"]}
```

Three rules — they are the whole point of this type:

1. **The flow is only questions and outcomes.** A question is one short line a person would ask
   ("Project help desk configured?"); an outcome is one short line ("Ticket to Flowpad support"). No
   ids, file names, endpoints or exceptions in a `label`.
2. **State is `state`.** Every question says which stored fact answers it — a file, a setting, a
   field, an id. The editor numbers the questions and lists each one's state in the **State** panel
   beside the canvas.
3. **Details are notes.** What a reader needs but the flow does not turn on (a default, a retry, a side
   effect, an edge case) is a node's `note` (hover, and the **Notes** panel) or a chart-level entry in
   `notes`. Never an extra node or branch.

- `kind`: `start` (exactly one), `question` (a numbered diamond), `outcome` (where the flow ends),
  `step` (something done on the way, with one exit).
- Every exit of a question has a `label` — the answer it stands for (`yes`, `no`, `help desk`).
- A node with more behind it gets `ref: "<that chart>"` (**Open ↗**) and its `flow dep add` link.
- At most ~6 questions and ~14 nodes; past that, an outcome's `ref` continues in another chart.
- A flowchart has no Convert to Excalidraw.
- Check before you finish — both must pass:
  ```bash
  python3 -I <this skill>/templates/flowchart/check_flowchart.py "$D"
  DM check --<ns>--.chartit.flowchart "$(cat "$D/flowchart.json")"     # the schema; data-management skill
  ```
- Then write the copy that opens anywhere — **one HTML file**, next to `flowchart.json`:
  ```bash
  python3 -I <this skill>/templates/flowchart/export_html.py "$D"     # writes "$D/<name>.html"
  ```
  It holds the flow, the State and Notes panels, hover, zoom and a Table view, in light and dark, with
  nothing loaded from the network — the file to send to someone, or to open where there is no Flowpad.
  Run it again after every change to `flowchart.json`; the file is a copy, never the source, so never
  edit it by hand. Show it with `flow show file "$D/<name>.html"` when the user asks for the file, or
  when this Flowpad cannot draw a `flowchart` chart. It leaves out what needs Flowpad: change requests
  and **Open ↗**. Its positions come from the script's own simple top-down layout, so they can differ
  from the editor's; look at the file once before you hand it over.
