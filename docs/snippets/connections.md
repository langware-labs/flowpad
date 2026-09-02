# Connections — Python SDK and CLI

Connections are the OAuth providers published by this instance. Python, the
CLI and the Connections screen read the same catalogue; a Hub plugin therefore
appears in all three without being added to an SDK list.

Pinned by `tests/unit/test_connections.py` and
`tests/unit/test_connections_cli.py`.

## Connect from a Python REPL

Start an async-capable standard Python REPL:

```console
$ python -m asyncio
asyncio REPL ...
>>> from flow_sdk.connections import get_connections
>>> connections = await get_connections()
>>> [(c.provider, c.connected) for c in connections]
[('anthropic', False), ('github', True), ('slack', False)]
>>> slack = next(c for c in connections if c.provider == "slack")
>>> slack = await slack.connect()
>>> slack.connected
True
>>> (await slack.test()).ok
True
```

`connect()` opens the provider's standard browser or device flow. If the local
Flowpad service is already healthy, it is borrowed and left unchanged. If it is
down, the SDK starts it for the callback and verification, then restores it to
down. A Hub-owned provider also runs the standard Flowpad sign-in first when
this instance is not logged in. The returned `Connection` is a new immutable
row; the original object is not mutated.

`connected` means a usable credential is held. `test()` makes the read-only
provider call that proves it still works.

## Connect from the CLI

```console
$ flow connections list
github         connected       GitHub
slack          not connected   Slack

$ flow connections connect slack
{"ok": true, "provider": "slack", "connected": true, "identity": "me"}
```

Use `--json` for a machine-readable list or error. Browser instructions and
progress use stderr; credentials, tokens and callback state are never printed.

## Require and use a held connection

```python
from flow_sdk.connections import NotConnected, TokenUnavailable, require

try:
    slack = await require("slack")
except NotConnected:
    slack = next(c for c in await get_connections() if c.provider == "slack")
    slack = await slack.connect()

try:
    token = await slack.token()
except TokenUnavailable:
    token = None  # Use the SDK driver/block; this provider keeps its token on the Hub.
```

`require()` is intentionally a cheap credential gate for blocks and drivers;
it does not call the provider. A provider that works through the Hub but does
not permit raw-token export raises `TokenUnavailable` from `token()` rather
than pretending it is disconnected.
