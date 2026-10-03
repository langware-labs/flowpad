/**
 * Launch restores the last view: the tab the main window was on, or Home when
 * the user had left every tab for Home. Only a launch (a bare `/`, the first
 * home load of the document) restores — a reload or the Home button never does.
 */
import { Layout, Tab, tabManager, type TabRow } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockPointer } from '@src/navigation/DockPointer';
import {
  endLaunch,
  forgetLastTab,
  lastTabRestoreRedirect,
  noteHomeLoad,
  rememberLastTab,
  resetLastTabRestoreForTests,
} from '@src/tabs/last-tab-restore';

const PROC_ID = '22222222-2222-4222-8222-222222222222';
const TAB_ID = '90000000-0000-4000-8000-000000000003';
const LAUNCH = new URL('http://flowpad.local/');
const CANONICAL_HOME = new URL('http://flowpad.local/?viewMode=standard');

const shellDock = DockPointer.forShell(`agentic_process-${PROC_ID}`);

/** One instance for the file: the entity store refuses a second Tab with the same id. */
const SHELL_TAB = new Tab({
  id: TAB_ID,
  pointer: shellDock.toJSON() ?? '',
  target_type: 'agentic_process',
  target_id: PROC_ID,
  parent_tab_id: null,
  project_id: null,
  name: null,
  icon_key: null,
  worktree: false,
  tab_order: 0,
  last_active_at: 1784000000000,
  status: null,
  is_disabled: false,
} as TabRow);

/** What the home loader does: note the URL on each pass, run the resolver on the canonical pass. */
async function launchAt(url: URL): Promise<string | null> {
  noteHomeLoad(url); // bare pass — the loader canonicalizes and re-runs
  noteHomeLoad(CANONICAL_HOME);
  const response = await lastTabRestoreRedirect();
  endLaunch();
  return response?.headers.get('Location') ?? null;
}

let listAll: ReturnType<typeof vi.spyOn<typeof Tab, 'listAll'>>;

beforeEach(() => {
  localStorage.clear();
  resetLastTabRestoreForTests();
  listAll = vi.spyOn(Tab, 'listAll').mockResolvedValue([SHELL_TAB]);
});

afterEach(() => {
  vi.restoreAllMocks();
  tabManager.resetForTests();
});

describe('last tab restore', () => {
  it('a launch reopens the tab the main window was on', async () => {
    rememberLastTab(shellDock, TAB_ID);

    const location = await launchAt(LAUNCH);

    expect(location).toContain('/dock/shell/');
    expect(location).toContain(PROC_ID);
    expect(location).toContain('viewMode=');
  });

  it('a launch stays on Home when the user had left the tab for Home', async () => {
    rememberLastTab(shellDock, TAB_ID);
    forgetLastTab(); // landed on Home afterwards

    expect(await launchAt(LAUNCH)).toBeNull();
  });

  it('a launch stays on Home when no tab was ever opened', async () => {
    expect(await launchAt(LAUNCH)).toBeNull();
  });

  it('a remembered tab that has since been closed restores nothing', async () => {
    rememberLastTab(shellDock, TAB_ID);
    listAll.mockResolvedValue([]);

    expect(await launchAt(LAUNCH)).toBeNull();
  });

  it('a reload of Home (a URL that states its mode) is not a launch', async () => {
    rememberLastTab(shellDock, TAB_ID);

    noteHomeLoad(CANONICAL_HOME);
    expect(await lastTabRestoreRedirect()).toBeNull();
  });

  it('restores once: Home after the launch stays Home', async () => {
    rememberLastTab(shellDock, TAB_ID);
    expect(await launchAt(LAUNCH)).not.toBeNull();

    noteHomeLoad(CANONICAL_HOME);
    expect(await lastTabRestoreRedirect()).toBeNull();
  });

  it('a launch another redirect took does not restore on a later Home click', async () => {
    rememberLastTab(shellDock, TAB_ID);
    noteHomeLoad(LAUNCH);
    noteHomeLoad(CANONICAL_HOME);
    endLaunch(); // e.g. an agent auto-launch won the resolver chain

    expect(await lastTabRestoreRedirect()).toBeNull();
  });

  it('a pop-out window landing on a tab does not speak for the main window', async () => {
    const popout = new DockPointer(shellDock.viewType, shellDock.pointer, shellDock.options, Layout.WIN);
    rememberLastTab(popout, TAB_ID);

    expect(await launchAt(LAUNCH)).toBeNull();
  });
});
