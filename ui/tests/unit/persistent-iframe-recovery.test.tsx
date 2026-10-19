import '@testing-library/jest-dom/vitest';
import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import PersistentIframe from '@src/components/persistent-iframe';

afterEach(cleanup);

const SRC = 'http://localhost:59123/recovery';
const frame = () => document.querySelector<HTMLIFrameElement>(`iframe[src="${SRC}"]`);

it('a frame remounted under a new key is loaded again, not re-shown as it was parked', () => {
  const first = render(<PersistentIframe src={SRC} cacheKey={0} />);
  const parked = frame();
  expect(parked).not.toBeNull();
  let loads = 0;
  Object.defineProperty(parked, 'src', { get: () => SRC, set: () => { loads += 1; }, configurable: true });

  // The display took the frame down while the app was broken, and brings it back once it works.
  first.unmount();
  render(<PersistentIframe src={SRC} cacheKey={0} />);
  expect(loads).toBe(0);
  cleanup();
  render(<PersistentIframe src={SRC} cacheKey={1} />);
  expect(loads).toBe(1);
});
