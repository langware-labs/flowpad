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
these capabilities `check` = configured (a record exists), `test` validates,
and `install` is a no-op (MCP servers are configured, not installed).

## Backend Contract

The backend capability infrastructure lives under `flow_sdk/core/capabilities`.
Each capability has a runner that implements:

- `check()`: returns whether the capability is available on this machine.
- `install()`: starts a headless install `AgenticProcess` and returns its
  `process_id` immediately. The worker is selected by resolving the default
  `harness` capability to a concrete leaf such as `harness.claude.cli` or
  `harness.codex.cli`.
- `test()`: validates that the installed capability actually works.

The entity actions are exposed on `capability`:

```http
POST /api/v1/graph/capability/<id>/check
POST /api/v1/graph/capability/<id>/install
POST /api/v1/graph/capability/<id>/test
```

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

`CapabilityManager` is the central frontend cache. It loads system capability
entities once, resolves prefix queries, and de-duplicates in-flight checks so
multiple callers do not repeatedly ask whether Claude or Codex is installed.

## Adding A Capability

1. Add a `CapabilitySpec` and runner under `flow_sdk/core/capabilities`.
2. Register the runner in the default capability registry.
3. Ensure dependent capabilities are listed by exact leaf kind.
4. Add or update backend tests for `check`, `install`, and `test`.
5. Add a frontend row only if the capability should appear in the built-in
   capabilities view. Other consumers can still call `useCapability(kind)`.
