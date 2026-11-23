import { afterEach, describe, expect, it, vi } from 'vitest';
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { connectionManager } from '@sdk';

import { StalePageIndicator } from '@src/components/top-nav-bar/StalePageIndicator';
import { entryScriptOf } from '@src/components/update-ready/stale-page';

const shell = (script: string) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/${script}"></script></head></html>`;

/** This page loaded `mine`; after the restart the server's shell names `served`. */
async function reconnect(mine: string, served: string) {
  document.head.innerHTML = `<script type="module" src="/assets/${mine}"></script>`;
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(shell(served), { status: 200 }))),
  );
  render(<StalePageIndicator />);
  await act(async () => {
    (connectionManager as unknown as { emit: (e: string) => void }).emit('on_reconnected');
    await new Promise((r) => setTimeout(r, 0));
  });
}

afterEach(() => {
  cleanup();
  document.head.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('a page that outlived its server', () => {
  it('reads the entry script a built shell names, and none from a dev shell', () => {
    expect(entryScriptOf(shell('index-BCIx97L4.js'))).toBe('/assets/index-BCIx97L4.js');
    expect(entryScriptOf('<script type="module" src="/src/main.tsx"></script>')).toBeNull();
  });

  it('offers a reload once the server serves another build', async () => {
    await reconnect('index-BCIx97L4.js', 'index-DqYoux05.js');
    expect(screen.getByTestId('top-nav-stale-page')).toBeInTheDocument();
  });

  it('stays quiet when the server came back with the same build', async () => {
    await reconnect('index-BCIx97L4.js', 'index-BCIx97L4.js');
    expect(screen.queryByTestId('top-nav-stale-page')).not.toBeInTheDocument();
  });
});
