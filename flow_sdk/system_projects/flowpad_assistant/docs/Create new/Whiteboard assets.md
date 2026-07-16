---
id: bc79bab1-21f5-400c-9647-0b5da18be673
title: Whiteboard assets
---

# Whiteboard assets

A **whiteboard** is a drawing canvas — boxes, arrows, freehand, text — for the
things that are faster to sketch than to write: an architecture diagram, a
flow, a rough layout. It opens in an **Excalidraw** editor. Creating one asks
for a name and opens the canvas.

On disk a whiteboard is a folder holding three files: the drawing itself as
`board.json`, a `WHITE_BOARD.md` document with your prose about the board, and
a thumbnail regenerated every time you save.

## The markdown side

`WHITE_BOARD.md` is what makes a whiteboard more than an image. Alongside your
own notes, Flowpad keeps a **mermaid diagram** in that file in sync with the
canvas — a text rendering of what you drew. That's the part an agent can
actually read, so a whiteboard stays useful in a session rather than being an
opaque blob.

## Where it lives

A whiteboard created with a project active belongs to that [[Flowpad project]].
With no project active it goes to your home folder instead.

## Good to know

- **Whiteboards show up in Advanced view.** They're hidden from the asset
  browser in the standard view. If you can't find one you made, check which
  view mode you're in.
- **It's a real folder.** Commit it, open `board.json` in Excalidraw directly,
  or share it into a conversation like any other asset — including
  [[Git sharing]] when it lives in a repository. There's a share button in the
  editor itself, and you can download the drawing.
