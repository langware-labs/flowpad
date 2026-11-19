/**
 * `PageAllowGate` — a page runs only with a state key. A page its opener minted a key for opens at
 * once; one a link points at asks the user first, in its own place, before anything of it mounts.
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

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    currentDock: h.dock,
    navigation: {
      replaceDock: (dock: unknown) => {
        h.replaced.push(dock);
        h.dock = dock;
      },
    },
  }),
}));
vi.mock('@src/hooks/use-preference', () => ({ usePreference: () => [h.trusted, h.setTrusted] }));

const { PageAllowGate } = await import('@src/components/page-allow/PageAllowGate');

const PAGE = 'editor/html/vfs/compute_node-@local/Users/me/page.html';
const KEY = 'k'.repeat(32);
const answer = (enforced: boolean, probed: { context: Record<string, string> } | null) => ({
  enforced,
  state: null,
  probed,
});

let posted: unknown[];
/** The local server: what it asks for, which keys it knows, and the key it mints. */
function server(opts: { enforced: boolean; known?: Record<string, Record<string, string>> }) {
  vi.spyOn(apiClient, 'get').mockImplementation(async (_url: string, config?: { params?: { probe?: string } }) => {
    const probe = config?.params?.probe;
    const context = probe ? opts.known?.[probe] : undefined;
    return answer(opts.enforced, context ? { context } : null);
  });
  vi.spyOn(apiClient, 'post').mockImplementation(async (_url: string, body: unknown) => {
    posted.push(body);
    opts.known = { ...opts.known, minted: (body as { context: Record<string, string> }).context };
    return { key: 'minted' };
  });
}

const ui = (installed = false) => (
  <PageAllowGate title="page.html" installed={installed}>
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
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
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

  it('mints a key for the session on Allow, writes it into the address, and runs the page', async () => {
    server({ enforced: true });
    render(ui());

    fireEvent.click(await screen.findByTestId('page-allow-accept'));

    const page = await screen.findByTestId('page');
    expect(posted).toEqual([{ title: 'page.html', context: { process: 'agentic_process-proc-1' } }]);
    expect((h.replaced[0] as DockPointer).options?.[STATE_KEY_PARAM]).toBe('minted');
    expect(page.getAttribute('data-key')).toBe('minted');
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
    server({ enforced: true });
    render(ui());

    expect(await screen.findByTestId('page')).toBeTruthy();
    expect(screen.queryByTestId('page-allow-card')).toBeNull();
  });

  describe('an installed app (its address names an app, so nothing is asked)', () => {
    it('mints a key silently, writes it into the address, and runs the app with it', async () => {
      server({ enforced: true });
      render(ui(true));

      const page = await screen.findByTestId('page');

      expect(screen.queryByTestId('page-allow-card')).toBeNull();
      expect(posted).toEqual([{ title: 'page.html', context: { process: 'agentic_process-proc-1' } }]);
      expect((h.replaced[0] as DockPointer).options?.[STATE_KEY_PARAM]).toBe('minted');
      expect(page.getAttribute('data-key')).toBe('minted');
    });

    it('mints nothing on a server that asks for no key', async () => {
      server({ enforced: false });
      render(ui(true));

      await screen.findByTestId('page');

      expect(posted).toEqual([]);
    });

    it('loads the app without a key when the server cannot be asked or will not mint — it says why itself', async () => {
      vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('down'));
      render(ui(true));
      expect(await screen.findByTestId('page')).toBeTruthy();
      cleanup();

      server({ enforced: true });
      vi.spyOn(apiClient, 'post').mockRejectedValue(new Error('refused'));
      render(ui(true));
      expect((await screen.findByTestId('page')).getAttribute('data-key')).toBe('');
    });
  });
});
