---
id: 73d3d935-2a3c-579d-9f5b-7f26291bfda9
---

# Headless tests

**Headless = the full app booted in jsdom + React Testing Library against a LIVE backend, with NO mocks.** This is the in-process E2E tier: it sits between the component-level `react` project (isolated components, no backend) and the Playwright/browser-MCP matrices (real browser). It mounts the production tree exactly like `main.tsx` — `<RouterProvider router={router}>` — so the real react-router root loader runs `initSdk()`, bootstraps over HTTP/WS, writes context, and the real views mount off it. Nothing is mocked; the only jsdom additions (`_setup.ts`) are browser primitives jsdom omits (a real `WebSocket`, `IntersectionObserver`, canvas, `scrollTo`).

How it works with zero mocks: `createSdkRealm(live.apiUrl)` scopes the SDK's test-only runtime backend override to module evaluation, resets the module graph, and returns the fresh realm plus its disposal handle. Electron's `initDesktopBackend` no-ops without `window.electronAPI`. The test then imports `@src/router` fresh from that same realm — the same realm-per-instance trick the `hub` project uses (`tests/hub/_instances.ts`) without leaking the override or socket into another file.

**Run:** `cd ui && FLOW_INSTANCE=<disposable-name> npm run test:vitest:headless` (project `headless`).

**Prereq:** an explicitly selected, disposable instance launched from this checkout: `scripts/instance_ctl.sh launch <disposable-name>`. `_backend.ts` accepts only the matching `FLOW_INSTANCE`: its generated `.env.<name>.local`, launcher name/port/live backend PID, and ready bootstrap must all agree. There is no developer-instance or `.env.local` fallback. Missing or mismatched infrastructure fails the suite, so Phase 8 can never turn an outage into a false pass.

For complete Claude-filesystem isolation, pass the same absolute temporary directory while launching the instance and running Vitest:

```bash
FLOWPAD_CLAUDE_HOME=/tmp/<cycle-owned-claude-home> CLAUDE_CONFIG_DIR=/tmp/<cycle-owned-claude-home> scripts/instance_ctl.sh launch <disposable-name>
cd ui
FLOW_INSTANCE=<disposable-name> FLOWPAD_CLAUDE_HOME=/tmp/<cycle-owned-claude-home> CLAUDE_CONFIG_DIR=/tmp/<cycle-owned-claude-home> npm run test:vitest:headless
```

Only kill the disposable instance that the current run launched. Never select, restart, clear, or kill a user-owned instance.

**Process isolation:** the project uses `pool: 'forks'` (not threads), and the
`test:vitest:headless` command uses `--no-file-parallelism` because all files
share one writable backend. Serialization belongs to the root CLI invocation:
Vitest does not honor `fileParallelism` or worker counts inside an extended
project config. `_setup.ts` explicitly disposes every file-owned SDK realm; a
fresh isolated child per file remains a second boundary for app-owned timers
and browser globals that are not part of the SDK realm.

**jsdom ceiling:** jsdom has no layout engine or canvas/WebGL. So `getBoundingClientRect()` is all-zeros and canvas surfaces don't paint — **xterm terminals, the Excalidraw whiteboard, and timeline/DockPointer geometry are out of scope here** and stay in the Playwright/browser-MCP matrices. Headless covers routing, loaders, context, bootstrap/auth, data flow, panels, modals, and entity round-trips through the SDK.

## Authoring a new headless test

Add a `*.test.tsx` file in this directory. Reuse the shared harness (`_harness.ts`) — don't re-roll the realm/boot dance:

```ts
import { describe, expect, it } from 'vitest';
import { setupLiveBackend, bootApp } from './_harness';
import { createSdkRealm } from '../_sdk_realm';

const backend = setupLiveBackend('[my-feature]'); // resolves a live backend once; registers cleanup()

describe('my feature (no mocks)', () => {
  it('does the thing', async () => {
    const live = backend.current;
    if (!live) throw new Error('headless backend preflight did not resolve FLOW_INSTANCE');

    // Bind a fresh, file-owned realm to the backend. _setup.ts disposes it.
    const { sdk } = await createSdkRealm(live.apiUrl);

    // (Optional) need the SDK BEFORE the app mounts — e.g. to seed an entity?
    // Use the returned SDK; bootApp() imports the router from the SAME realm:
    //   await sdk.initSdk(); const skill = await sdk.Skill.create('x');

    const { container, router } = await bootApp(); // mounts the real app, waits for loadRoot
    // await act(async () => { await router.navigate('/dock/...'); });  // drive the UI
    // ...assert via @testing-library/react (screen/findByTestId/fireEvent)...
  });
});
```

Rules of the tier:

- **Explicit instance only:** set `FLOW_INSTANCE` to a disposable instance launched by the current run. The harness hard-fails when identity/readiness checks do not pass; never return early for missing infrastructure.
- **Order matters:** `createSdkRealm(live.apiUrl)` → optional SDK seeding → `bootApp()`. Do not reset modules between the realm creation and `bootApp()`; that would split the entity you seed from the realm the UI edits.
- **Edit through real UI controls** (testids, `fireEvent`), then read back through the SDK — that's what makes it E2E. See `skill_edit_roundtrip.test.tsx`.
- **Stay under the ceiling:** assert on DOM/state/data, not pixel geometry or canvas. If your feature needs real layout/canvas, it's a Playwright test, not a headless one.
- **Never raise the per-test/`waitFor` timeouts** to pass — fix the slow path (project `CLAUDE.md` non-negotiable).
- **Clean up** anything you create on the backend (prefer `trackForCleanup`, which full-purges file-backed entities).
