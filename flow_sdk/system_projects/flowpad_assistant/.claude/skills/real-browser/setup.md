# Setup — the agent profile

> Ground rules (inline by design): start on the agent profile — it holds none
> of the user's accounts — and attach to the user's own Chrome only when they
> ask, for that session. Find a Chrome window by its pid: several Chromes share
> one app name, so a lookup by name lands on an arbitrary one. Never type into
> whatever app is in front — a focus request can fail silently, and keys that
> land in a chat or form can send something that cannot be taken back; ask the
> user to switch windows instead.

The agent profile is the user's installed browser — Chrome, or Edge when Chrome
is not installed (the usual case on Windows) — running on a separate profile
under `~/.flow/instances/$FLOW_INSTANCE/browser/profile`. It is a real,
visible window, but it holds none of the user's cookies or logins, so nothing
the agent does there can touch their accounts. Logins made inside it persist
for later sessions on the same instance.

Chrome refuses to expose its default profile to automation (since Chrome 136),
which is why this mode always uses its own profile directory.

## Start

```bash
browser start
```

Prints `launched …` or `reusing …`, then `session=<id> ready`. Calling it again
reuses the running browser, so run it whenever unsure instead of checking first.

| Exit / message              | Meaning and next move                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `NO_BROWSER` (2)            | Neither Chrome nor Edge is installed. Run `flow wizard run browser-setup`; any other Chromium browser works via `CHROME_BIN=<path>`. |
| `NEEDS_SETUP` (8)           | The chrome-devtools CLI is not installed. Run `flow wizard run browser-setup`, then start again.                   |
| `BROWSER_DID_NOT_START` (3) | The agent profile is already open in a browser this script no longer tracks. Ask the user to close that window, then start again. |
| `DAEMON_FAILED` (6)         | The chrome-devtools CLI's background service did not start; its output follows.                                   |

## Show it to the user

Several Chrome processes can be running at once (the user's own, this one,
others), all under the same app icon. Bring this one forward by pid:

```bash
browser front
```

`front` only requests focus — macOS can leave a full-screen app on screen —
so confirm with the user in words which window it is ("the new Chrome window
with no bookmarks"), and ask them to switch to it if they don't see it.

## Stop

```bash
browser stop
```

Ends the session and closes Chrome only when this script launched it. Stop when
the user is done with the browser; leave it running between steps of one task.

`browser status` prints the mode, pid, port and session.
