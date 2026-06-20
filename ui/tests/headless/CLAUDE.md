# Headless tests

**Headless = the full app booted in jsdom + React Testing Library against a LIVE backend, with NO mocks.** This is the in-process E2E tier: it sits between the component-level `react` project (isolated components, no backend) and the Playwright/browser-MCP matrices (real browser). It mounts the production tree exactly like `main.tsx` — `<RouterProvider router={router}>` — so the real react-router root loader runs `initSdk()`, bootstraps over HTTP/WS, writes context, and the real views mount off it. Nothing is mocked; the only jsdom additions (`_setup.ts`) are browser primitives jsdom omits (a real `WebSocket`, `IntersectionObserver`, canvas, `scrollTo`).

How it works with zero mocks: the SDK resolves its backend from `globalThis.__FLOWPAD_API_URL__` (`ts_sdk/src/config/load_config.ts`) *before* the module graph is imported, and Electron's `initDesktopBackend` no-ops without `window.electronAPI`. Each test sets the override, `vi.resetModules()`, then imports `@src/router` fresh — the same realm-per-instance trick the `hub` project uses (`tests/hub/_instances.ts`).

**Run:** `cd ui && npm run test:vitest:headless` (project `headless`).

**Prereq:** a live backend — either the default dev server (`uv run -m flow_sdk.server.run`, port from `.env.local` `LOCAL_SERVER_PORT`) **or** an isolated instance (`scripts/instance_ctl.sh launch dev-1`, preferred). `_backend.ts` health-pings `/health/status` and the suite **self-skips** (does not fail) when neither is reachable. A skip is not a pass — in the e2e-qa cycle (Phase 8) bring the backend up and re-run.

**Process isolation:** the project uses `pool: 'forks'` (not threads). Each full-app boot leaves a live SDK realm behind (open WebSocket + `initSdk` timers) that a reused worker can't reap and that starves the next file's boot; a fresh child process per file kills those OS handles.

**jsdom ceiling:** jsdom has no layout engine or canvas/WebGL. So `getBoundingClientRect()` is all-zeros and canvas surfaces don't paint — **xterm terminals, the Excalidraw whiteboard, and timeline/DockPointer geometry are out of scope here** and stay in the Playwright/browser-MCP matrices. Headless covers routing, loaders, context, bootstrap/auth, data flow, panels, modals, and entity round-trips through the SDK.

## Authoring a new headless test

Add a `*.test.tsx` file in this directory. Reuse the shared harness (`_harness.ts`) — don't re-roll the realm/boot dance:

```ts
import { describe, expect, it, vi } from 'vitest';
import { setupLiveBackend, bootApp } from './_harness';

const backend = setupLiveBackend('[my-feature]'); // resolves a live backend once; registers cleanup()

describe('my feature (no mocks)', () => {
  it('does the thing', async () => {
    if (!backend.current) return;                  // soft-skip when no backend is up — ALWAYS first

    // Point the realm at the backend, then re-evaluate the module graph.
    (globalThis as any).__FLOWPAD_API_URL__ = backend.current.apiUrl;
    vi.resetModules();

    // (Optional) need the SDK BEFORE the app mounts — e.g. to seed an entity?
    // Import it AFTER resetModules so it binds to this realm; bootApp() then
    // imports the router from the SAME realm (it does not reset again):
    //   const sdk = await import('@sdk'); await sdk.initSdk();
    //   const skill = await sdk.Skill.create('x');

    const { container, router } = await bootApp();  // mounts the real app, waits for loadRoot
    // await act(async () => { await router.navigate('/dock/...'); });  // drive the UI
    // ...assert via @testing-library/react (screen/findByTestId/fireEvent)...
  });
});
```

Rules of the tier:
- **Soft-skip first** (`if (!backend.current) return;`) so a missing backend never reds the suite.
- **Order matters:** set `__FLOWPAD_API_URL__` → `vi.resetModules()` → (optional `import('@sdk')`) → `bootApp()`. A reset *between* the `@sdk` import and `bootApp` splits them into two realms (the entity you seed won't be the one the UI edits).
- **Edit through real UI controls** (testids, `fireEvent`), then read back through the SDK — that's what makes it E2E. See `skill_edit_roundtrip.test.tsx`.
- **Stay under the ceiling:** assert on DOM/state/data, not pixel geometry or canvas. If your feature needs real layout/canvas, it's a Playwright test, not a headless one.
- **Never raise the per-test/`waitFor` timeouts** to pass — fix the slow path (project `CLAUDE.md` non-negotiable).
- **Clean up** anything you create on the backend (e.g. `await created.delete()` in `finally`).
