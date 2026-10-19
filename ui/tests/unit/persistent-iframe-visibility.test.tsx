/**
 * A parked frame stays mounted, hidden with CSS — which its guest cannot see (`document.hidden`
 * stays false inside). So the host SAYS it: `flowpad:visibility {hidden}` when the frame is shown
 * and when it is parked, and in answer to a guest that asks (`flowpad:visibility-please`) because
 * it loaded after the first notice. The SDK folds the answer into the guest's `document.hidden`.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { VISIBILITY_MESSAGE, VISIBILITY_PLEASE_MESSAGE } from '@sdk/apps/host';
import { afterEach, expect, it } from 'vitest';
import PersistentIframe from '@src/components/persistent-iframe';

afterEach(cleanup);

const SRC = 'about:blank#visibility';
const frame = () => document.querySelector<HTMLIFrameElement>(`iframe[src="${SRC}"]`)!;
const listen = (iframe: HTMLIFrameElement) => {
  const told: unknown[] = [];
  const guest = { postMessage: (message: unknown) => told.push(message) };
  Object.defineProperty(iframe, 'contentWindow', { get: () => guest, configurable: true });
  return { told, guest };
};
const visibility = (told: unknown[]) =>
  told.filter((m) => (m as { type?: string }).type === VISIBILITY_MESSAGE).map((m) => (m as { hidden: boolean }).hidden);

it('tells the guest when its frame is shown and when it is parked, and answers when asked', () => {
  const view = render(<PersistentIframe src={SRC} />);
  // jsdom never fires the frame's load (a remote src errors instead): say it loaded, so a later
  // mount shows it the way the app does once the guest answered.
  act(() => {
    frame().dispatchEvent(new Event('load'));
  });
  const { told, guest } = listen(frame());

  // Parked: the display went away, the frame stays — and is told it is hidden.
  view.unmount();
  expect(visibility(told).at(-1)).toBe(true);

  // The guest loaded late and asks: answered with the frame's current state, for its own window only.
  told.length = 0;
  window.dispatchEvent(new MessageEvent('message', { data: { type: VISIBILITY_PLEASE_MESSAGE }, source: guest as unknown as Window }));
  expect(visibility(told)).toEqual([true]);
  told.length = 0;
  window.dispatchEvent(new MessageEvent('message', { data: { type: VISIBILITY_PLEASE_MESSAGE }, source: null }));
  expect(visibility(told)).toEqual([]);

  // Shown again (already loaded): told so.
  told.length = 0;
  render(<PersistentIframe src={SRC} />);
  expect(visibility(told).at(-1)).toBe(false);
});
