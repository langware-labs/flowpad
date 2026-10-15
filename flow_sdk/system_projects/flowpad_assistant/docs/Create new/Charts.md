---
id: bc79bab1-21f5-400c-9647-0b5da18be673
title: Charts
---

# Charts

A **chart** is a visual asset — for the things that are faster to see than to
read: a request flow between services, an architecture sketch, a decision
tree. Every chart has a **format**, picked when you create it:

- **sequence** — who calls whom, in order: participants across the top,
  messages flowing down. A step can be a **sub-flow** that opens another chart.
- **excalidraw** — a free drawing canvas: boxes, arrows, freehand, text.
- **mermaid** — a diagram written as mermaid text.

On disk a chart is a folder: a `CHART.md` document (its name, description,
format and your prose), the format's source (`chart.json` for a sequence,
`board.json` for a drawing; a mermaid chart's source is the mermaid block in
`CHART.md`), and a thumbnail regenerated on save.

## The markdown side

`CHART.md` is what makes a chart more than an image. Alongside your own notes,
Flowpad keeps a **mermaid diagram** in that file in sync with the chart — a
text rendering of what it shows, whatever its format. That's the part an agent
can actually read, so a chart stays useful in a session rather than being an
opaque blob.

## Where it lives

A chart created with a project active belongs to that [[Flowpad project]].
With no project active it goes to your home folder instead.

## Good to know

- **Whiteboards became charts.** A whiteboard you made before is now an
  excalidraw chart — same drawing, same id, under `agentic-assets/chart/`.
- **It's a real folder.** Commit it, open `board.json` in Excalidraw directly,
  or share it into a conversation like any other asset — including
  [[Git sharing]] when it lives in a repository.
