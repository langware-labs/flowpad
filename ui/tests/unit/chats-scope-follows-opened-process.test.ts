/**
 * RCA capture + fix verification (test mode): opening a chat must scope the side
 * menu to the OPENED PROCESS's project, not to whatever project was ambiently
 * active when the dock URL's scope was seeded.
 *
 * Live repro: dock URL points at AgenticProcess `de2d24af` (project_id =
 * `dd682350…` = the oss checkout) yet carries `scope-activeProjectId=72fac107…`
 * (= sapora-streams, ambient at click). The Chats navigator reads
 * `currentDock.scopeFilter`, so it lists sapora-streams' chats while an oss chat
 * is open.
 *
 * Invariant (user-stated): the opened entity's `project_id` wins over all — it is
 * the project loaded, the project in context, AND the scope filter. Enforced at
 * LOAD (so deep-links / refresh / back-forward are covered, not just clicks).
 *
 * Layer: the real `loadShellRoute` (the stable route surface — exists before and
 * after the fix). Only external IO is stubbed — the WS gate, the process load,
 * and the cache lookup. The scope-reconcile logic under test runs for real, as
 * does the dock-URL scope serialization. Before the fix: no redirect (scope stays
 * A) → the rejects-with-redirect expectation fails (red). After: redirect carries
 * scope B (green).
 */
import { AgenticProcess, dataManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { projectScope } from '@src/lib/scope-filter';
import { loadShellRoute } from '@src/routes/loaders/load-shell';
import * as loadProcessModule from '@src/routes/loaders/load-process';
import { connectionManager } from '@sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Two distinct, valid entity ids (UUID v4 — the dock-URL codec validates
// `activeProjectId` on decode and drops anything that isn't v4/v5).
const AMBIENT_PROJECT_A = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa'; // sapora-streams analog (active at click → seeded on URL)
const PROCESS_PROJECT_B = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb'; // the opened chat's own project (oss analog)
const PROCESS_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function redirectLocation(err: unknown): string | null {
  return err instanceof Response ? err.headers.get('Location') : null;
}

describe('opening a chat scopes the side menu to the chat\'s project', () => {
  afterEach(() => vi.restoreAllMocks());

  function arrange() {
    window.history.pushState({}, '', '/dock/shell');
    const process = new AgenticProcess({ id: PROCESS_ID, project_id: PROCESS_PROJECT_B });
    vi.spyOn(connectionManager, 'waitForConnected').mockResolvedValue(undefined as any);
    // The process loads successfully (entity + context already handled by loadProcess).
    vi.spyOn(loadProcessModule, 'loadProcess').mockResolvedValue({ process, shell: null } as any);
    // reconcile reads the opened process out of the cache.
    vi.spyOn(dataManager, 'getByTypeIdFromCache').mockImplementation((typeId: any) =>
      typeId?.id === PROCESS_ID ? (process as any) : null,
    );
    return process;
  }

  it('redirects the URL scope to the opened process\'s project when it diverges from ambient', async () => {
    const process = arrange();
    const pointer = process.terminalDockPointer.pointer;

    // Navigate to the process while the URL scope is the (ambient) project A.
    let caught: unknown;
    try {
      await loadShellRoute(pointer, '/dock/shell', { scope: projectScope(AMBIENT_PROJECT_A) });
    } catch (e) {
      caught = e;
    }

    const location = redirectLocation(caught);
    expect(location, 'loader must redirect to align the URL scope to the process project').toBeTruthy();
    const scope = DockPointer.fromUrl(location!).scopeFilter;
    expect(scope?.activeProjectId).toBe(PROCESS_PROJECT_B); // the opened entity's project wins
  });

  it('does NOT redirect when the URL scope already matches the process project', async () => {
    const process = arrange();
    const pointer = process.terminalDockPointer.pointer;

    // Already aligned → no redirect-loop.
    await expect(
      loadShellRoute(pointer, '/dock/shell', { scope: projectScope(PROCESS_PROJECT_B) }),
    ).resolves.toBeUndefined();
  });

  it('still aligns the scope when the PTY runtime soft-fails (entity + project are known)', async () => {
    // The chat belongs to its project regardless of runtime health. A reattach
    // failure (PTY died / backend restart) must NOT leave the side menu scoped
    // to the ambient project — this was the live gap the success-only reconcile
    // missed. loadProcess throws a SOFT ProcessLoadError but the entity is in
    // cache, so its project_id is authoritative.
    const process = arrange();
    const pointer = process.terminalDockPointer.pointer;
    vi.spyOn(loadProcessModule, 'loadProcess').mockRejectedValue(
      new loadProcessModule.ProcessLoadError('pty_attach_failed', PROCESS_ID, null),
    );

    let caught: unknown;
    try {
      await loadShellRoute(pointer, '/dock/shell', { scope: projectScope(AMBIENT_PROJECT_A) });
    } catch (e) {
      caught = e;
    }

    const location = redirectLocation(caught);
    expect(location, 'soft-failed load must still align the URL scope to the process project').toBeTruthy();
    expect(DockPointer.fromUrl(location!).scopeFilter?.activeProjectId).toBe(PROCESS_PROJECT_B);
  });
});
