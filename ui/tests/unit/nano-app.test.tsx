/**
 * A nano-app is one `.html` file with slots. Inside the file, `nano.start()` mounts the slot the host asked
 * for and tells the host how tall it is; around it, `NanoAppFrame` sizes the frame and opens the page in a tab —
 * for its own frame only.
 */
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fsManager } from '@sdk';
import { NANO_OPEN_MESSAGE, NANO_SIZE_MESSAGE, nano } from '@sdk/apps/nano';
import { NANO_BLOCK_MAX_HEIGHT, NanoAppFrame } from '@src/components/nano-app/NanoAppFrame';

const nav = { openDock: vi.fn() };
vi.mock('@sdk/main', () => ({ initSdk: vi.fn(() => Promise.resolve()) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ resolvedTheme: 'dark' }) }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: nav }) }));

const FILE = `<template data-slot="header">h</template><template data-slot="block"><p id="block">block</p></template>
<main data-slot="page"><p id="page">page</p></main>`;

describe('nano.start() inside the file', () => {
  const post = vi.fn();
  beforeEach(() => {
    document.body.innerHTML = FILE;
    vi.stubGlobal('ResizeObserver', class { observe() {} });
    vi.spyOn(window, 'parent', 'get').mockReturnValue({ postMessage: post } as unknown as Window);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    post.mockClear();
    window.history.replaceState(null, '', '/');
  });

  it('mounts the block slot, hides the page, and tells the host its height', async () => {
    window.history.replaceState(null, '', '/app.html?slot=block');
    const app = await nano.start();
    expect(app.slot).toBe('block');
    expect(document.querySelector('[data-slot-mounted="block"] #block')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('[data-slot="page"]')!.hidden).toBe(true);
    expect(post).toHaveBeenCalledWith({ type: NANO_SIZE_MESSAGE, height: expect.any(Number) }, '*');
    app.open('page');
    expect(post).toHaveBeenCalledWith({ type: NANO_OPEN_MESSAGE, slot: 'page' }, '*');
  });

  it('shows the page when no slot is asked for, and reports no size', async () => {
    const app = await nano.start();
    expect(app.slot).toBe('page');
    expect(document.querySelector<HTMLElement>('[data-slot="page"]')!.hidden).toBe(false);
    expect(post.mock.calls.some(([message]) => message.type === NANO_SIZE_MESSAGE)).toBe(false);
  });
});

describe('NanoAppFrame around the file', () => {
  const say = (source: unknown, data: unknown) =>
    act(() => void window.dispatchEvent(new MessageEvent('message', { data, source: source as MessageEventSource })));
  beforeEach(() => {
    vi.spyOn(fsManager, 'getServeUrl').mockReturnValue('http://backend/fs/serve/app.html');
    nav.openDock.mockClear();
  });
  afterEach(() => vi.restoreAllMocks());

  it('asks for the slot and the input, and is as tall as the app says, up to the cap', () => {
    render(<NanoAppFrame path="/tmp/app.html" input="/tmp/x.value.json" />);
    const frame = screen.getByTestId<HTMLIFrameElement>('nano-app-frame');
    expect(frame.src).toContain('slot=block');
    expect(frame.src).toContain('input=%2Ftmp%2Fx.value.json');
    say(frame.contentWindow, { type: NANO_SIZE_MESSAGE, height: 120 });
    expect(frame.style.height).toBe('120px');
    say(frame.contentWindow, { type: NANO_SIZE_MESSAGE, height: 5000 });
    expect(frame.style.height).toBe(`${NANO_BLOCK_MAX_HEIGHT}px`);
  });

  it('opens the page in a tab for its own frame, and ignores every other window', () => {
    render(<NanoAppFrame path="/tmp/app.html" />);
    const frame = screen.getByTestId<HTMLIFrameElement>('nano-app-frame');
    say(window, { type: NANO_OPEN_MESSAGE, slot: 'page' });
    say(window, { type: NANO_SIZE_MESSAGE, height: 300 });
    expect(nav.openDock).not.toHaveBeenCalled();
    expect(frame.style.height).toBe('0px');
    say(frame.contentWindow, { type: NANO_OPEN_MESSAGE, slot: 'page' });
    expect(nav.openDock).toHaveBeenCalledTimes(1);
  });
});
