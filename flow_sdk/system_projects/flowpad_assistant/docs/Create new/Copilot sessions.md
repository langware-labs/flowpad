---
id: 4536205e-b7f7-44b2-9495-767fc94597c3
title: Copilot sessions
---

# Copilot sessions

A **Copilot session** is an interactive terminal running GitHub's `copilot`
CLI, opened as a tab in Flowpad. Clicking the tile starts it immediately —
there is no form to fill in first.

Everything about how a session is homed works the same as a
[[Claude Code sessions|Claude Code session]]: it runs in the active
[[Flowpad project]]'s folder, it can see the project's
[[Context folders|context folders]], and [[Project secrets]] bound to the
project arrive as environment variables. Without an active project the session
still starts, unhomed, in the Global scope.

## Differences from Claude Code

- **No auto-naming.** Claude names a session from its opening prompt; Copilot
  doesn't. A Copilot session keeps a placeholder name until you rename it, so
  it's worth naming the ones you intend to come back to.
- **No forking.** Asking Copilot to fork a session quietly resumes it instead —
  you get one continuing session, not a copy.
- **Folder trust is pre-answered.** Flowpad launches Copilot with its
  folder-trust gate already satisfied, so the prompt doesn't swallow your first
  message.

## Good to know

- **Sessions start in full-access mode.** The agent won't stop to ask before
  each tool call. Start it in a folder you're comfortable letting it change.
- **You need the CLI installed.** Flowpad looks for `copilot` on your PATH; if
  it isn't there, the session fails to start. Login is not checked — an
  installed-but-logged-out CLI shows its own login screen inside the tab, and
  because it exits quickly, Flowpad marks the session failed rather than
  retrying. Log in, then start it again.
- **Stopping keeps the history.** Closing a session stops the worker but keeps
  the session itself, so it stays searchable and you can resume it.
