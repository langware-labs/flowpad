---
id: e858b952-80f7-40dd-83eb-bd54d65dfa66
title: 'Sandbox preview urls: browser vs server'
tags:
- breadcrumb.test.sandbox_browser_url.rules
description: A dev-server port has TWO correct urls in a cloud box — loopback for
  the server, the public per-port host for the browser — and E2B_SANDBOX_ID is empty
  in the process that must choose.
---

# Sandbox preview urls: browser vs server

> Ground truth. Proven by RCA on 2026-08-26. Do not edit without the user's approval.

```breadcrumb
tag: breadcrumb.test.sandbox_browser_url.rules
sites:
  - rel_path: "tests/unit/test_own_sandbox_id_source.py"
    line: 20
    note: "FAILING? read this tag's rules before editing. The sandbox id does NOT come from E2B_SANDBOX_ID \u2014 it is empty in the server process."
```

## Expected behavior

`flow show webapp --port <p>` registers the dev server as a `proxy`
`ServiceEndpoint` and puts it in the Vibe display. The display's iframe `src`
and its liveness poll are both the endpoint's **`direct-url`**, so whatever that
action returns is the address the **viewer's browser** resolves.

On a desktop the viewer sits at the machine running the dev server, so
`http://localhost:<p>` is right. In a cloud box the viewer is on a different
machine entirely: `localhost` there is the viewer's own laptop, nothing is
listening on it, and the pane renders Chrome's "localhost refused to connect".

`flow show file` is unaffected — it renders same-origin and never asks for a
direct url. A `static` endpoint (built output) is loaded through the `service`
route and is unaffected too.

## Internals

The chain, browser inward:

- `ui/src/components/display-toolbar/use-webapp-health.ts` — the liveness poll.
- `ui/src/hooks/flow-hooks/useAppDisplay.ts` `useDirectUrl` → `ts_sdk/src/entities/service-endpoint.ts` `directUrl()` — asks the endpoint.
- `flow_sdk/builtin/service_endpoint.py` `direct-url` action → `local_direct_url(port)` for an endpoint of this machine (a hub row is asked of the hub).
- `local_direct_url` answers `http://localhost:{port}` — or, when `own_sandbox_id()` says this backend runs in a box, `sandbox_public_url(port, id)`.

Two askers, deliberately:

- `service_endpoint/<id>/probe` — the **server's** view. It dials `127.0.0.1:<port>` from *inside* the box, where loopback is correct and free; so does the MCP client.
- `direct-url` — the **browser's** view, rewritten only when this backend is a box.

`own_sandbox_id` (`flow_sdk/instance_settings/runtime.py`) answers *which* sandbox,
gated on `get_assigned_runtime()` answering *whether*. The id comes from
Firecracker's metadata service (`169.254.169.254`, token handshake then
`/instanceID`), cached for the process lifetime. `sandbox_public_url`
(`flow_sdk/compute/providers/compute_provider.py`) owns the
`https://<port>-<id>.e2b.dev` shape, shared with `E2BComputeProvider.get_host`.

## Invariants

- **A loopback url must never leave the backend as a browser's address in a cloud box.** Only loopback is rewritten; a routable host is left alone.
- **`E2B_SANDBOX_ID` is not a source of truth — ask the metadata service, unconditionally.** Not because the variable is permanently broken, but because *no process can tell which of three states it is in*:
  - **Empty.** E2B fills it in after the template's `start_cmd` (`su user -c "flow start service"`) has already run, so the whole server tree boots without it. Measured: `flow_sdk.server.run` reported `E2B_SANDBOX_ID=` while a terminal in the same sandbox reported `ivshr0pshcpupip2m0pqk`.
  - **Populated by E2B.** True in the interactive shells it spawns.
  - **Populated by us.** `flow_sdk/core/flow/mcp_servers/copy_to_sandbox/shell_mcp.py:86` copies our environment into spawned shells, stripping `E2B_SANDBOX` but **not** `E2B_SANDBOX_ID` — so a child can hold an id we handed down while failing the sandbox gate. A value being present therefore does not mean E2B put it there.
  This is why "use it if set, fall back if empty" is rejected: the fast path never fires in the process that actually asks (always empty there), it costs nothing to skip (`own_sandbox_id` is cached for the process lifetime), and accepting a set value re-opens the failure mode below. The metadata service answers for the process doing the asking and cannot be inherited, copied, or set by a test.
- **Sandbox-ness is the hub's to assign,** via `runtime_kind` in the instance config; an instance must not promote itself by sniffing locally.
- **Server-side callers keep loopback.** Routing the endpoint's `probe` or MCP through the public url sends a local call out to the internet and back.

## Failure modes

- **Reading the env var.** A fix that did this passed its test and changed nothing in production — the test supplied a value the server never has. `test_a_populated_env_var_does_not_make_this_a_sandbox` exists to make that fail loudly.
- **Fixing it in `LocalComputeProvider.get_host`.** Correct for the display, wrong for the probe and MCP, which share that seam.
- **Trusting a green test.** The URL a function returns is a *proxy* for the symptom. Close the loop on the real surface: toggle the lever on a live box and watch the page load, then break again.

### The proof

Live E2B box `ivshr0pshcpupip2m0pqk`, one real `python3 -m http.server 8000` inside it
(measured on the per-process port lookup that `direct-url` replaced; it applies the
same rule, `local_direct_url`):

| lever | the browser was sent to | remote browser fetches it |
|---|---|---|
| unfixed | `307 → http://localhost:8000/` | connection refused |
| fixed | `307 → https://8000-ivshr0pshcpupip2m0pqk.e2b.dev/` | `200`, the page itself |
| reverted | `307 → http://localhost:8000/` | connection refused |
