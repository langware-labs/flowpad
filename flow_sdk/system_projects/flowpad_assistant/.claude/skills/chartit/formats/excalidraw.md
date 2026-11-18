# excalidraw — a free whiteboard

A chart type of the chartit skill: read `../SKILL.md` first — it sets the folder, the shared rules and how a
chart is indexed, linked, shown and verified. This file adds only what a `excalidraw` chart needs.

The file: `board.json` `{"kind": "excalidraw", "version": 1, "data": {"elements": [...], "appState": {}}}`;
elements `rectangle` / `ellipse` / `diamond` / `arrow` / `text` with `id`, `type`, `x`, `y`, `width`,
`height` (text: `text`, `fontSize`); on a grid, nothing overlapping.
