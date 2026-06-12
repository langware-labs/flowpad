---
id: 6db114ca-da89-5322-9491-4406f7e4bbc2
---

- PRECONDITION: switch the app to Advanced view (footer view pill or `window.setView('advanced')` / localStorage `viewMode=advanced`) — the process toolbar (Restart / Open Terminal / Fork / Worktree / Session Info / Transcript) and side-ribbon panels only exist in Advanced view; the default Standard view shows the simple-chat header without them
test 1: Session Info popover opens only when a session exists and shows all expected rows
- navigate to {APP_URL}/dock/shell/new_terminal
- wait for the plain shell tab; do NOT click Start Claude
- validate the Info icon is NOT rendered in the process toolbar (gated on hasSession)
- click Start Claude and wait for the banner
- validate the Info icon is now visible; click it
- a Popover titled "Session Details" opens
- validate the following row labels are all present and non-empty (value is the copy target):
  - Process ID, Status, CLI worker status, Started, Last message, Working Dir,
    Session ID, PTY ID, Permission, Chrome, Debug, Worktree, Model, Command
- close the popover (click outside)

test 2: CopyRow copy button copies the value and shows a transient check-icon confirmation
- continue from test 1 (popover has been opened at least once)
- open the Info popover
- click the Session ID row
- validate the row's copy button (aria-label "Copy <label>") swaps its icon to a green check, then back to the copy icon within ~1.5s (the value text itself never changes — CopyRow redesign)
- read the clipboard (e.g. via navigator.clipboard.readText when permitted) and validate it matches the session UUID
- repeat for the PTY ID row and validate clipboard matches the PTY UUID

test 3: Command row reflects current CLI flags
- from a running Claude session, open CLI Options and ensure Chrome and Debug and Full Trust are all OFF (apply if needed; verify pty respawns)
- open the Info popover; validate the "Command" row starts with `cd '<workdir>' && claude` and contains `--resume <uuid>` with no extra flags (ignoring --model if set). The session is already running, so `--resume <uuid>` is correct (not `--session-id`).
- close popover; open CLI Options; toggle Chrome ON; Apply and wait for respawn
- open Info popover; validate the Command row now contains `--chrome`
- parameterize: Full Trust -> `--dangerously-skip-permissions`; Debug -> `--debug`
