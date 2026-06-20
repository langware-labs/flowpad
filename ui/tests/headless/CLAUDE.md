# Headless tests

**Headless = the full app booted in jsdom + React Testing Library against a LIVE backend, with NO mocks.** This is the in-process E2E tier: it sits between the component-level `react` project (isolated components, no backend) and the Playwright/browser-MCP matrices (real browser). It mounts the production tree exactly like `main.tsx` — `<RouterProvider router={router}>` — so the real react-router root loader runs `initSdk()`, bootstraps over HTTP/WS, writes context, and the real views mount off it. Nothing is mocked; the only jsdom additions (`_setup.ts`) are browser primitives jsdom omits (a real `WebSocket`, `IntersectionObserver`, canvas, `scrollTo`).

How it works with zero mocks: the SDK resolves its backend from `globalThis.__FLOWPAD_API_URL__` (`ts_sdk/src/config/load_config.ts`) *before* the module graph is imported, and Electron's `initDesktopBackend` no-ops without `window.electronAPI`. Each test sets the override, `vi.resetModules()`, then imports `@src/router` fresh — the same realm-per-instance trick the `hub` project uses (`tests/hub/_instances.ts`).

**Run:** `cd ui && npm run test:vitest:headless` (project `headless`).

**Prereq:** a live backend — either the default dev server (`uv run -m flow_sdk.server.run`, port from `.env.local` `LOCAL_SERVER_PORT`) **or** an isolated instance (`scripts/instance_ctl.sh launch dev-1`, preferred). `_backend.ts` health-pings `/health/status` and the suite **self-skips** (does not fail) when neither is reachable. A skip is not a pass — in the e2e-qa cycle (Phase 8) bring the backend up and re-run.

**Process isolation:** the project uses `pool: 'forks'` (not threads). Each full-app boot leaves a live SDK realm behind (open WebSocket + `initSdk` timers) that a reused worker can't reap and that starves the next file's boot; a fresh child process per file kills those OS handles.

**jsdom ceiling:** jsdom has no layout engine or canvas/WebGL. So `getBoundingClientRect()` is all-zeros and canvas surfaces don't paint — **xterm terminals, the Excalidraw whiteboard, and timeline/DockPointer geometry are out of scope here** and stay in the Playwright/browser-MCP matrices. Headless covers routing, loaders, context, bootstrap/auth, data flow, panels, modals, and entity round-trips through the SDK.
