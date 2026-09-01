/**
 * Restoring the vibe display on a cold landing.
 *
 * The display used to rehydrate from `context_data.last_shown` into pane state on
 * every mount, arbitrated by a freshness baseline. It is an address now, so restore
 * is a REDIRECT — and a redirect has failure modes state never had: a loop, and
 * bouncing the user out of a URL they deliberately navigated to. These pin the
 * guards that prevent both.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgenticProcess, Tab, tabManager } from '@sdk';
import { DockPointer } from '@src/navigation/DockPointer';
import { ViewMode } from '@src/contexts/view-mode-context';

const PROCESS_ID = '853880a0-dd7b-4872-9db2-3bc2b97390dd';
const PROJECT_ID = 'f20cecb9-72e7-4cd4-92f2-61b5c48b45cf';
const HOST = `agentic_process-${PROCESS_ID}`;
const DOC_PATH = '/workspace/content/deliverable.md';
const REQUEST_PATH = `/dock/shell/${HOST}`;

/**
 * Seed the cache the loader reads: a process carrying a display pin, and the
 * active-display Tab row that proves the workspace still HAS a display.
 */
function seed({ lastShown, withDisplayTab = true }: { lastShown: unknown; withDisplayTab?: boolean }) {
  const process = new AgenticProcess({ id: PROCESS_ID, project_id: PROJECT_ID } as never);
  process.context_data = { last_shown: lastShown } as never;
  vi.spyOn(AgenticProcess, 'getByIdFromCache').mockReturnValue(process as never);

  // A REAL Tab row built from the REAL pointer serialization — `tabForDockKey`
  // resolves identity through `Tab.getKey()`, so a hand-shaped object would prove
  // nothing about whether the hashes actually agree.
  const displayDock = DockPointer.forFile(DOC_PATH)
    .withViewMode(ViewMode.Vibe)
    .withHost(HOST)
    .withActiveDisplay(true);
  const row = new Tab({
    id: '2b1d2f45-6f6a-5a3c-9c31-1c3a5f7b9d10',
    pointer: displayDock.toJSON(),
    parent_tab_id: 'process-tab',
  } as never);
  vi.spyOn(tabManager, 'getSnapshot').mockReturnValue((withDisplayTab ? [row] : []) as never);
  return displayDock.tabHash;
}

let restoreDisplayRedirect: (id: string, path: string, carry?: unknown) => string | null;
let resetDisplayRestoreForTests: () => void;

beforeEach(async () => {
  vi.restoreAllMocks();
  const mod = await import('@src/routes/loaders/load-shell');
  restoreDisplayRedirect = mod.restoreDisplayRedirect as typeof restoreDisplayRedirect;
  resetDisplayRestoreForTests = mod.resetDisplayRestoreForTests;
  // The once-per-session set is module state and genuinely session-scoped, so each
  // test starts from the state a hard reload produces.
  resetDisplayRestoreForTests();
});

describe('vibe display restore redirect', () => {
  it('sends a cold vibe landing back to the deliverable', () => {
    seed({ lastShown: { kind: 'vfs', path: DOC_PATH } });
    const url = restoreDisplayRedirect(PROCESS_ID, REQUEST_PATH, { viewMode: ViewMode.Vibe });
    // The full grammar: nested under the host's project, naming the host, flagged
    // as the replaceable active display, and in vibe.
    expect(url).toContain(`/dock/project/${PROJECT_ID}/process/${HOST}/display/`);
    expect(url).toContain('deliverable.md');
    expect(url).toContain('activeDisplay=1');
    expect(url).toContain(`${'viewMode'}=vibe`);
  });

  it('fires at most once per process per session', () => {
    seed({ lastShown: { kind: 'vfs', path: DOC_PATH } });
    expect(restoreDisplayRedirect(PROCESS_ID, REQUEST_PATH, { viewMode: ViewMode.Vibe })).not.toBeNull();
    // The Display home chip navigates to this very URL on purpose, and so does
    // closing a child. A second redirect would make the bare process unreachable.
    expect(restoreDisplayRedirect(PROCESS_ID, REQUEST_PATH, { viewMode: ViewMode.Vibe })).toBeNull();
  });

  it('stays put outside explicit vibe', () => {
    seed({ lastShown: { kind: 'vfs', path: DOC_PATH } });
    // The effective mode is not settled at loader time (a project's own last_mode
    // is applied later), so anything but an explicit vibe param must not redirect.
    expect(restoreDisplayRedirect(PROCESS_ID, REQUEST_PATH, { viewMode: null })).toBeNull();
    resetDisplayRestoreForTests();
    expect(restoreDisplayRedirect(PROCESS_ID, REQUEST_PATH, undefined)).toBeNull();
  });

  it('restores a pin that no browser has displayed yet', () => {
    // The cold landing this exists for: `flow show` arrived while nothing was
    // watching, so no active-display Tab row was ever minted. An earlier version
    // required that row as a "the user still has a display" record and therefore
    // never fired on exactly this case. Once-per-session carries the guard instead.
    seed({ lastShown: { kind: 'vfs', path: DOC_PATH }, withDisplayTab: false });
    expect(restoreDisplayRedirect(PROCESS_ID, REQUEST_PATH, { viewMode: ViewMode.Vibe })).not.toBeNull();
  });

  it('never restores a terminal', () => {
    // A shell target lives on as its own child tab; re-entering it would drag the
    // user back into a terminal on every reload.
    seed({ lastShown: { kind: 'shell', id: '2f0c1f9e-1111-4222-8333-444455556666' } });
    expect(restoreDisplayRedirect(PROCESS_ID, REQUEST_PATH, { viewMode: ViewMode.Vibe })).toBeNull();
  });

  it('stays put when there is no pin at all', () => {
    seed({ lastShown: undefined });
    expect(restoreDisplayRedirect(PROCESS_ID, REQUEST_PATH, { viewMode: ViewMode.Vibe })).toBeNull();
  });

  it('stays put when the target addresses nothing openable', () => {
    // The `dataset` hole: an entity type with no registered editor and no path.
    seed({ lastShown: { kind: 'entity', type: 'dataset', typeid: 'dataset-abc' } });
    expect(restoreDisplayRedirect(PROCESS_ID, REQUEST_PATH, { viewMode: ViewMode.Vibe })).toBeNull();
  });
});
