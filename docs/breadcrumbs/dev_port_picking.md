---
title: Dev port picking for agent-started servers
tags:
- breadcrumb.test.dev_port_picking.rules
description: An agent that types a port collides with a sibling build — and on Windows the second http.server binds silently; the picker's probe sees only listeners and takes no lease.
---

# Dev port picking for agent-started servers

> Ground truth. Proven by RCA on 2026-08-18. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.dev_port_picking.rules
sites:
  - rel_path: "tests/cli/test_app_free_dev_port.py"
    line: 60
    note: "FAILING? read this tag's rules first - one probe per invocation, or the backlog is spent"
```

## Expected behavior

An agent that starts its own dev server (`python3 -m http.server`, a framework
dev server) must **ask** for a port rather than choose one:

```bash
PORT=$(flow app free-dev-port --bare)
```

Two builds running on the same machine then land on different ports, and
`flow show webapp --port "$PORT"` shows the app that agent actually built.

## Internals

* `free_dev_port` (`flow_sdk/cli/commands/app_cmd.py:156`) is a thin exposure of
  `_choose_static_port` (`app_cmd.py:426`) — the picker `flow app open` already
  uses for static apps. Same band, same probe, so a port it prints is one `open`
  would have picked. `--bare` prints only the number, for `PORT=$(...)`; without
  it the command emits the `_ok` JSON envelope with `port` and `in_range`.

* The band is `_STATIC_PORT_RANGE = range(8000, 8100)` (`app_cmd.py:405`). When
  every port in it looks taken, `_find_free_port` (`app_cmd.py:433`) binds port
  `0` and returns whatever the OS assigns — outside the band, which is why the
  JSON carries `in_range` rather than promising 8000-8099.

* The probe is `_port_open` (`app_cmd.py:439`): a real
  `socket.create_connection(("127.0.0.1", port), timeout=0.5)`. It answers "is
  someone **listening** here", not "is this port free" — see both blind spots
  below.

* Why the persona files matter as much as the command: `standard.md` and
  `vibe.md` are the only place an agent learns which port to use. They used to
  say "pick a port in 8000-8099 (check with `lsof`)" and `flow show webapp
  --port 3000`. `lsof` is POSIX-only and absent on Windows, so the check silently
  did nothing and the literal stood.

## Invariants

* **The port is asked for, never typed.** A literal port in a persona, skill, or
  generated command is the bug, even when it happens to be free today.

* **`--bare` prints one integer and nothing else.** It is consumed by
  `PORT=$(...)`; a banner or a log line on stdout becomes part of the port.

* **The band is a preference, not a guarantee.** Callers read `in_range` (or
  accept an OS-assigned port) instead of asserting 8000-8099.

* **The caller binds immediately.** The picker takes no lease (below).

## No lease — concurrent pickers get the same port

`_choose_static_port` reserves nothing. Two agents that call it before either
binds both receive the lowest free port: measured, two consecutive calls with
nothing bound both returned `8000`. The window is between the call and the
caller's `bind()`, so bind immediately and treat the returned port as advice.
Closing this window needs a lease, which is deliberately out of scope for this
step.

Also invisible to the probe: a socket that is **bound but never listening**.
`_port_open` returned `False` for such a port and the picker handed it straight
out.
