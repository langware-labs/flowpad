---
id: 78b0d8da-f655-4e60-a92c-203addedff0d
title: Claude Code sessions
---

# Claude Code sessions

A **Claude Code session** is an interactive terminal running Anthropic's
`claude` CLI, opened as a tab in Flowpad. Clicking the tile starts it
immediately — there is no form to fill in first.

The session runs in the active [[Flowpad project]]'s folder, so the agent's
working directory is your project and its edits are ordinary file changes you
can inspect or commit. If no project is active, the session still starts; it
just isn't homed to one, and it lands in the Global scope. A session's project
and working directory are fixed once it has a session id — they can't be
re-homed later.

The tab is a real terminal, not a transcript view. You type into the `claude`
TUI exactly as you would in your own shell.

## What it can see

Beyond the project folder, the agent also gets every [[Context folders|context
folder]] attached to the project, and any [[Project secrets]] bound to it
arrive as environment variables.

## Good to know

- **Sessions start in full-access mode.** A session launched from this tile
  runs with permissions bypassed — the agent won't stop to ask before each
  tool call. Start it in a folder you're comfortable letting it change.
- **You need the CLI installed.** Flowpad looks for `claude` on your PATH. If
  it isn't there, the session fails to start. Flowpad does *not* check whether
  you're logged in — an installed-but-logged-out CLI will just show its own
  login screen inside the tab.
- **Naming happens later.** A new session has no name until Claude summarizes
  your opening prompt; the tab then takes that as its title. Rename it yourself
  and the name sticks.
- **Stopping keeps the history.** Closing a session stops the worker but keeps
  the session itself, so it stays searchable and you can resume it.
