/**
 * Launch restores the last view: the place the main window last loaded, or Home
 * when the user had left every tab for Home. Only a launch (a document opened at
 * a bare `/`, on its first home load) restores — a reload or Home never does.
 */
import { Layout } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';

import { DockPointer } from '@src/navigation/DockPointer';
import {
  endLaunch,
  forgetLastPlace,
  lastPlaceRestoreRedirect,
  rememberLastPlace,
  resetLastPlaceRestoreForTests,
} from '@src/tabs/last-tab-restore';

const LAUNCH_DOCUMENT = 'http://flowpad.local/';
/** The home loader's resolver pass, after it canonicalized the bare launch URL. */
const HOME = new Request('http://flowpad.local/?viewMode=standard');
const SHELL = DockPointer.forShell('agentic_process-22222222-2222-4222-8222-222222222222');
const SHELL_URL = '/dock/shell/agentic_process-22222222-2222-4222-8222-222222222222?viewMode=vibe&scope-mode=project';

/** One home-loader resolver pass: the resolver, then the launch ends. */
async function homeLoad(): Promise<string | null> {
  const response = await lastPlaceRestoreRedirect(HOME);
  endLaunch();
  return response?.headers.get('Location') ?? null;
}

beforeEach(() => {
  localStorage.clear();
  resetLastPlaceRestoreForTests(LAUNCH_DOCUMENT);
});

describe('last place restore', () => {
  it('a launch reopens the place the main window last loaded, as loaded', async () => {
    rememberLastPlace(SHELL, SHELL_URL);

    expect(await homeLoad()).toBe(SHELL_URL);
  });

  it('a launch stays on Home when the user had left the tab for Home', async () => {
    rememberLastPlace(SHELL, SHELL_URL);
    forgetLastPlace();

    expect(await homeLoad()).toBeNull();
  });

  it('a launch stays on Home when no tab was ever opened', async () => {
    expect(await homeLoad()).toBeNull();
  });

  it('a document opened anywhere but a bare `/` is not a launch (a reload)', async () => {
    rememberLastPlace(SHELL, SHELL_URL);
    resetLastPlaceRestoreForTests('http://flowpad.local/?viewMode=standard');

    expect(await homeLoad()).toBeNull();
  });

  it('restores once: Home after the launch stays Home', async () => {
    rememberLastPlace(SHELL, SHELL_URL);
    expect(await homeLoad()).toBe(SHELL_URL);

    expect(await homeLoad()).toBeNull();
  });

  it('only the home load restores, not a dock load running the same resolver chain', async () => {
    rememberLastPlace(SHELL, SHELL_URL);

    expect(await lastPlaceRestoreRedirect(new Request('http://flowpad.local/dock/project/p'))).toBeNull();
  });

  it('a pop-out window does not speak for the main window', async () => {
    const popout = new DockPointer(SHELL.viewType, SHELL.pointer, SHELL.options, Layout.WIN);
    rememberLastPlace(popout, `/win/shell/${SHELL.pointer}`);

    expect(await homeLoad()).toBeNull();
  });
});
