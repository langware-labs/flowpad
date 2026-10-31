/**
 * A pooled app view lives as long as its tab (I6): closing the tab drops the view's key and frees
 * its frame in the iframe registry; a view whose tab stays open is kept even while not shown.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ open: new Set<string>(), released: [] as string[] }));

vi.mock('@src/tabs/use-tab-manager', () => ({ useOpenTabHashes: () => h.open }));
vi.mock('@src/components/persistent-iframe', async (orig) => ({
  ...(await orig<typeof import('@src/components/persistent-iframe')>()),
  releaseFrame: (src: string) => h.released.push(src),
}));
vi.mock('@src/pages/flow-page/app-display-viewer', () => ({
  AppDisplayViewer: ({ endpointId, onFrameSrc }: { endpointId: string; onFrameSrc?: (s: string) => void }) => {
    useEffect(() => onFrameSrc?.(`http://localhost/${endpointId}/`), [endpointId, onFrameSrc]);
    return <p data-testid={`viewer-${endpointId}`} />;
  },
}));

const { tabManager } = await import('@sdk');
const { AppPool } = await import('@src/components/app-pool/AppPool');
const { appPool } = await import('@src/components/terminal/terminal-pool');

beforeEach(() => {
  h.open = new Set(['tab-a', 'tab-b']);
  h.released = [];
  vi.spyOn(tabManager, 'isHydrated').mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  appPool.resetForTests();
  vi.restoreAllMocks();
});

const viewer = (id: string) => ({ viewer: { artifactId: null, endpointId: id }, tabHash: `tab-${id}` });

it('closing the tab drops its view and frees its frame; an open tab keeps its view', async () => {
  const view = render(<AppPool />);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const slotA = Symbol('a');
  const slotB = Symbol('b');
  await act(async () => {
    appPool.show(slotA, 'key-a', host, viewer('a'));
    appPool.show(slotB, 'key-b', host, viewer('b'));
  });
  await act(async () => {
    appPool.hide(slotA);
    appPool.hide(slotB);
  });
  expect(appPool.getSnapshot().mounted).toEqual(new Set(['key-a', 'key-b']));

  h.open = new Set(['tab-b']);
  view.rerender(<AppPool />);
  await act(async () => {});

  expect(appPool.getSnapshot().mounted).toEqual(new Set(['key-b']));
  expect(h.released).toEqual(['http://localhost/a/']);
  expect(document.querySelector('[data-testid="viewer-a"]')).toBeNull();
  expect(document.querySelector('[data-testid="viewer-b"]')).not.toBeNull();
  host.remove();
});
