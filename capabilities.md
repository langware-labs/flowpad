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
