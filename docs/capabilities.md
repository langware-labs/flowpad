---
id: 1fedc3a4-8d44-5567-9e52-47b078b113cf
---

# Capabilities

Capabilities describe local system features that FlowPad can use, such as CLI
harnesses or authenticated browser access. They are backend-owned entities:
the frontend reflects their state and calls backend actions, but does not
implement availability logic itself.

## Model

`Capability` is a system entity with:

- `name`: human-readable label, for example `Claude CLI`.
- `kind`: dot-separated ontology key, for example `harness.claude.cli`.
- `description`: short explanation for UI surfaces.
- `dependent_capability_kinds`: leaf kinds that must be available first.
- `last_check`, `last_install`, `last_test`: persisted action results.

Kinds are hierarchical. A caller can ask for a broad branch or an exact leaf:

```ts
useCapability('harness'); // any harness capability, Claude or Codex
useCapability('harness.claude'); // any Claude harness capability
useCapability('harness.claude.cli'); // exact leaf
```

The current built-in leaf capabilities are:

- `harness.claude.cli`
- `harness.codex.cli`
- `browsing.chrome.authenticated`

## MCP-server capabilities (dynamic)

This is about `MCP_SERVER` — the read-only scan of servers already configured in
a vendor's own files — not the `MCP` asset an Agent attaches (see
`docs/glossary.md`). Discovery produces capabilities; attaching does not.

Every indexed MCP server is also exposed as a capability under the kind
`<service>.mcp.<worker_type>`, for example `gmail.mcp.claude_code`. The kind is
**service-first** so the same prefix matching resolves a query at any level:

```ts
useCapability('gmail');                 // any worker that has a Gmail MCP
useCapability('gmail.mcp');             // same — all gmail.mcp.* leaves
useCapability('gmail.mcp.claude_code'); // exact leaf
```

`<service>` is a best-effort normalization of the server's name (vendor prefix
stripped, lowercased, non-alphanumerics dropped — `claude.ai Gmail` → `gmail`).
`<worker_type>` is the owning agent (the `worker_type` on the MCP_SERVER
record). Servers that normalize to the same `(service, worker_type)` merge into
one capability.

Unlike the static leaves above, these are **derived from indexed records**, so
they're managed by `reconcile_mcp_capabilities` (`flow_sdk/core/capabilities/mcp.py`)
rather than `get_default_capability_specs`. Reconcile registers a runner +
upserts a system `Capability` row per kind, and prunes kinds whose backing
config disappeared. It runs at server start, after every MCP index (indexing
refreshes the capability list), and on a manual `check` of an MCP kind. For
these capabilities `check` = configured (a record exists) and `install` is a no-op (MCP
servers are configured, not installed). `test` reports the same "is it configured" answer as
`check` — it does not dial the server. The probe that actually connects and lists tools is
`probe_mcp` (`flow_sdk/builtin/mcp.py`), which takes an `McpSpec` rather than an entity so a
scanned `MCP_SERVER` row can reach it through `McpSpec.from_record`.

## Backend Contract

The backend capability infrastructure lives under `flow_sdk/core/capabilities`.
Each capability has a runner that implements:

- `check()`: returns whether the capability is available on this machine.
- `install()`: starts a headless install `AgenticProcess` and returns its
  `process_id` immediately. The worker is selected by resolving the default
  `harness` capability to a concrete leaf such as `harness.claude.cli` or
  `harness.codex.cli`.
- `test()`: validates that the installed capability actually works. For
  harness CLI kinds the result's `details.auth` also carries the CLI's login
  state (`logged_in` / `logged_out` / `unknown`, with `verified` true only
  when the vendor CLI itself confirmed it), probed through the worker
  driver's `auth_probe()`.

The entity actions are exposed on `capability`:

```http
POST /api/v1/graph/capability/<id>/check
POST /api/v1/graph/capability/<id>/install
POST /api/v1/graph/capability/<id>/test
```

### Device login (harness CLIs)

Harness CLI capabilities also drive their vendor's link(+code) sign-in flow
through the entity. The vendor differences are a `DeviceLoginSpec` trait on
each `WorkerDriver` (login argv, verification-URL / one-time-code regexes,
whether the browser shows a code the user pastes back); a single generic
engine (`cli_drivers/device_login.py`) runs the CLI under a PTY, scrapes the
URL and code, and re-probes with `auth_probe()` on exit before declaring
success. It never trusts process exit alone, and pre-probes so an
already-authenticated CLI short-circuits without minting a fresh code.

```http
POST /api/v1/graph/capability/<id>/device-login        # start / restart the flow
POST /api/v1/graph/capability/<id>/device-login-code    # {code} — paste-back vendors (claude)
POST /api/v1/graph/capability/<id>/device-login-cancel
GET  /api/v1/graph/capability/<id>/auth-status          # cheap login probe (no version run)
```

Live progress rides the entity's runtime-only `login_state` / `login_url` /
`login_code` / `login_accepts_code` / `login_message` fields (`Persist.FALSE`,
broadcast over WebSocket, never persisted). The frontend watches the entity and
renders them — it never polls. `auth-status` is the startup gate's cheap check,
scheduled after primary content readiness; an explicitly opened login flow
can probe immediately.
`worker_type_for_kind(kind)` on the registry resolves a harness kind to its
driver.

`Capability` rows are seeded as system entities. Query them with:

```http
GET /api/v1/graph/capability?include_system=true
```

## Frontend Usage

Use the SDK hook for React surfaces:

```ts
const { available, capability, check, install, test, activeProcess } =
  useCapability('harness.claude');
```

`available` is true when any matching descendant capability has a successful
backend result. `activeProcess` is populated when a capability action returns
an `AgenticProcess` id, such as an install run or the authenticated Chrome
browsing probe.

For non-React code, use the singleton manager:

```ts
import { capabilityManager } from '@sdk';

const snapshot = await capabilityManager.ensureChecked('harness');
if (snapshot.available) {
  // At least one harness capability is available.
}
```

`CapabilityManager` owns the live capability projection, prefix resolution and
deduplication of checks/actions. Shared reads belong to the SDK lazy registry:
`load()` delegates to `LazyAsset.Capabilities`, and `getSummary()` delegates to
`LazyAsset.CapabilitySummary`. Their invalidating variants refresh the same
entries, so SDK callers and React consumers join any pending read. Available
bootstrap/info summaries seed that cache; a deferred seed cannot replace a
newer summary or an active summary fetch.

`useCapability(..., { autoCheck: false })` loads metadata in the background after
primary content readiness. The default auto-check path demands metadata before
checking. The capabilities view demands its summary and renders loading,
failure/retry or an empty result locally. These reads never gate the router or
remount an editor. See [the shared lazy resource contract](boot.md#7-shared-lazy-resources-ts_sdksrclazy).

## Adding A Capability

1. Add a `CapabilitySpec` and runner under `flow_sdk/core/capabilities`.
2. Register the runner in the default capability registry.
3. Ensure dependent capabilities are listed by exact leaf kind.
4. Add or update backend tests for `check`, `install`, and `test`.
5. Add a frontend row only if the capability should appear in the built-in
   capabilities view. Other consumers can still call `useCapability(kind)`.
