/**
 * `PageAllowGate` — a page runs only on a dock carrying a key the server knows. A page its opener minted
 * a key for opens at once; one a link points at asks the user first, in its own place, before anything
 * of it mounts. Allow writes the app's own key into the address — the gate never mints.
 */
import { apiClient } from '@sdk';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DockPointer, STATE_KEY_PARAM } from '@src/navigation/DockPointer';
import { ViewType } from '@src/types/ViewType';

const h = vi.hoisted(() => ({
  dock: null as unknown,
  replaced: [] as unknown[],
  trusted: [] as string[],
  setTrusted: vi.fn(),
}));

vi.mock('@src/navigation/useDockNavigation', async () => {
  const { useState } = await import('react');
  return {
    // Reactive like the real hook: replacing the dock re-renders whoever reads it.
    useDockNavigation: () => {
      const [, redraw] = useState(0);
      return {
        currentDock: h.dock,
        navigation: {
          replaceDock: (dock: unknown) => {
            h.replaced.push(dock);
            h.dock = dock;
            redraw((n) => n + 1);
          },
        },
      };
    },
  };
});
vi.mock('@src/hooks/use-preference', () => ({ usePreference: () => [h.trusted, h.setTrusted] }));

const { PageAllowGate } = await import('@src/components/page-allow/PageAllowGate');

const PAGE = 'editor/html/vfs/compute_node-@local/Users/me/page.html';
const KEY = 'k'.repeat(32);
/** The app's own key: the one the server wrote into the app's page at startup. */
const APP_KEY = 'a'.repeat(32);
const answer = (enforced: boolean, probed: { context: Record<string, string> } | null) => ({
  enforced,
  state: null,
  probed,
});

let posted: unknown[];
/** The local server: what it asks for and which keys it knows. A mint is recorded — the gate must make none. */
function server(opts: { enforced: boolean; known?: Record<string, Record<string, string>> }) {
  vi.spyOn(apiClient, 'get').mockImplementation(async (_url: string, config?: { params?: { probe?: string } }) => {
    const probe = config?.params?.probe;
    const context = probe ? opts.known?.[probe] : undefined;
    return answer(opts.enforced, context ? { context } : null);
  });
  vi.spyOn(apiClient, 'post').mockImplementation(async (_url: string, body: unknown) => {
    posted.push(body);
    return { key: 'minted' };
  });
}

const ui = () => (
  <PageAllowGate title="page.html">
    {({ stateKey, context }) => (
      <div data-testid="page" data-key={stateKey ?? ''} data-process={context.process ?? ''} />
    )}
  </PageAllowGate>
);

beforeEach(() => {
  h.dock = new DockPointer(ViewType.ASSETS, PAGE).withHost('proc-1');
  h.replaced = [];
  h.trusted = [];
  h.setTrusted.mockReset();
  posted = [];
  (globalThis as { __FLOWPAD_STATE_KEY__?: string }).__FLOWPAD_STATE_KEY__ = APP_KEY;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete (globalThis as { __FLOWPAD_STATE_KEY__?: string }).__FLOWPAD_STATE_KEY__;  window.sessionStorage.clear(); // the key is remembered for a reload: do not hand it to the next test file
});

describe('PageAllowGate', () => {
  it('runs a page at once on a server that asks for no key', async () => {
    server({ enforced: false });

    render(ui());

    expect(await screen.findByTestId('page')).toBeTruthy();
    expect(screen.queryByTestId('page-allow-card')).toBeNull();
  });

  it('runs a page its opener minted a key for, and hands it what the key names', async () => {
    server({ enforced: true, known: { [KEY]: { process: 'agentic_process-1' } } });
    h.dock = (h.dock as DockPointer).withOption(STATE_KEY_PARAM, KEY);

    render(ui());

    const page = await screen.findByTestId('page');
    expect(page.getAttribute('data-key')).toBe(KEY);
    expect(page.getAttribute('data-process')).toBe('agentic_process-1');
  });

  it('asks first when a link names the page, and mounts nothing of it', async () => {
    server({ enforced: true });

    render(ui());

    expect(await screen.findByTestId('page-allow-card')).toBeTruthy();
    expect(screen.getByTestId('page-allow-title').textContent).toContain('page.html');
    expect(screen.queryByTestId('page')).toBeNull();
  });

  it('asks again for a key the server never minted', async () => {
    server({ enforced: true, known: {} });
    h.dock = (h.dock as DockPointer).withOption(STATE_KEY_PARAM, 'z'.repeat(32));

    render(ui());

    expect(await screen.findByTestId('page-allow-card')).toBeTruthy();
  });

  it("writes the app's own key into the address on Allow, mints nothing, and runs the page", async () => {
    server({ enforced: true, known: { [APP_KEY]: {} } });
    render(ui());

    fireEvent.click(await screen.findByTestId('page-allow-accept'));

    const page = await screen.findByTestId('page');
    expect(posted).toEqual([]);
    expect((h.replaced[0] as DockPointer).options?.[STATE_KEY_PARAM]).toBe(APP_KEY);
    expect(page.getAttribute('data-key')).toBe(APP_KEY);
  });

  it('does not run a page the user refuses', async () => {
    server({ enforced: true });
    render(ui());

    fireEvent.click(await screen.findByTestId('page-allow-deny'));

    expect(screen.getByText(/has not run/)).toBeTruthy();
    expect(screen.queryByTestId('page')).toBeNull();
    expect(posted).toEqual([]);
  });

  it('remembers a page the user always allows, and runs it without asking next time', async () => {
    server({ enforced: true });
    render(ui());
    fireEvent.click(await screen.findByTestId('page-allow-always'));
    await waitFor(() => expect(h.setTrusted).toHaveBeenCalledWith([`${ViewType.ASSETS}|${PAGE}`]));
    cleanup();

    h.trusted = [`${ViewType.ASSETS}|${PAGE}`];
    h.dock = new DockPointer(ViewType.ASSETS, PAGE);
    server({ enforced: true, known: { [APP_KEY]: {} } });
    render(ui());

    expect(await screen.findByTestId('page')).toBeTruthy();
    expect(screen.queryByTestId('page-allow-card')).toBeNull();
    expect(posted).toEqual([]);
  });
});
