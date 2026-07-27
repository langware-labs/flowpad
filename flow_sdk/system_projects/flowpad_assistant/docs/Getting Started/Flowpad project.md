---
id: 5119ff45-d5f7-4def-b42a-57d61f37a9bb
title: Flowpad project
---

# Flowpad project

A **project** is the unit Flowpad organizes your work around. It is backed by a
folder on your computer: opening a folder (or creating one) makes it a project,
and everything you do inside — chats, assets, tabs, agent sessions — is scoped to
it. Switching projects switches that whole context at once.

## What a project holds

- **A working folder.** The project's files live in a real directory on disk;
  agents run there, and edits are ordinary file changes you can inspect, commit,
  or open in any other tool.
- **Assets.** Documents, whiteboards, decks, skills, and other entities you
  create are indexed under the project so they're searchable and linkable.
- **Tabs and sessions.** Open tabs and agent (Claude Code) sessions belong to the
  project, so returning to it restores what you were doing.

## Switching and scope

The projects chip in the footer shows the active project and how many projects
have open tabs. Click it to switch: picking a project resumes its
most-recently-active tab (or its landing page). The scope you're in decides which
assets, tabs, and history you see — work in one project stays out of the others.

Tabs that don't belong to any project run in the **Global** scope instead — a
separate, projectless bucket shown with a violet accent.

## Projects vs. the root folder

A project should point at a specific working folder, not your home or a drive
root. Running a project on a root folder is flagged as not recommended: agents
and indexing would treat an enormous tree as the workspace, which is slow and
easy to make unintended changes in. Pick (or create) a dedicated folder for each
piece of work.

## Creating and opening

- **Open project folder** points Flowpad at an existing directory.
- **Open existing project** reopens one Flowpad already knows about.
- The projects chip's action row can launch a new project folder with an agent
  worker already armed, or reopen a past session from history.

Because a project is just a folder, you can move or back it up like any other
directory, and reopen it in Flowpad later.
