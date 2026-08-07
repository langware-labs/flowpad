---
id: 2d168c8c-9d7d-4859-9ab7-b36960aa02eb
title: Duplicate assets
---

# Duplicate assets

## What

A duplicate is the same asset — a skill, an agent, a document — existing as
more than one copy. Every copy carries the same **id**, so Flowpad treats them
as one asset and reads only one of them: the **live** copy.

## So what

**A fix in one copy does not reach the others.** Everything using the asset
keeps loading whichever copy Flowpad picked, so the same skill or agent can
behave differently depending on which copy is in play — and edits you make to
an ignored copy never show up in Flowpad at all.

## Which action

Two intents. Pick the one that matches what you actually meant.

### Clone — "I want my own copy"

A deliberate copy that goes its own way. It gets a **new id** and becomes a
separate asset: both are indexed, both are editable, and they evolve
independently from here.

Choose this when you meant to branch off and don't care what the original does
next.

*Today:* delete the `id:` line from the copy's frontmatter. Flowpad mints a
fresh id the next time it indexes.

### Merge — "there was only ever one"

You never intended to run two. Keep the original as it is and drop the extra
copy, so everything using the asset resolves to the same file again.

Choose this when the second copy was an accident.

*Today:* delete the extra copy. The warning clears at the next index.

## Copies that aren't yours to resolve

Some duplicates are a byproduct of how files got onto the machine, not
something you did:

- a copy inside an installed package (`site-packages`) or a dependency folder
  (`node_modules`, `.venv`)
- a second checkout of the same repository

Leave these alone. The panel labels them so you can tell at a glance.

## Reading the panel

Each entry is one file on disk.

- **Live** — the copy Flowpad reads.
- **Ignored** — a copy Flowpad knows about but does not index. Still on disk,
  still untouched, simply not what the app reads.

Under each path: **In Git since**, **Created**, and **First indexed** — shown
only when that signal exists for that file. The header says which of them
decided the live copy; Flowpad prefers the oldest evidence so the choice stays
stable between indexes.

Related: [[Where your assets live]].
