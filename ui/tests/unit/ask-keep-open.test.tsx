/**
 * A question on screen keeps its op waiting: the form says "I show it" at once and every 20 s, so a
 * person looking for a key file is never cut off at the op's 60 s. Gone from screen, it stops saying so.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {}, currentDock: null }),
}));

import { AskForm } from '@src/components/ask/AskForm';
import { KEEP_OPEN_MS } from '@src/components/ask/use-ask-question';

beforeEach(() => {
  vi.useFakeTimers();
  h.get.mockResolvedValue({ id: 'q1', op: 'ask-google-cloud', prompt: 'Google Cloud', fields: 'string' });
  h.post.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  h.get.mockReset();
  h.post.mockReset();
});

const seen = () => h.post.mock.calls.filter(([path]) => path === '/api/v1/ask/q1/seen').length;

it('says the question is on screen at once and every 20 s while it is shown, and stops once it is not', async () => {
  const shown = render(<AskForm questionId="q1" />);
  expect(seen()).toBe(1);
  await act(async () => {
    vi.advanceTimersByTime(KEEP_OPEN_MS * 3);
  });
  expect(seen()).toBe(4);

  shown.unmount();
  await act(async () => {
    vi.advanceTimersByTime(KEEP_OPEN_MS * 3);
  });
  expect(seen()).toBe(4);
});

it('two screens showing one question send one heartbeat between them', async () => {
  const first = render(<AskForm questionId="q1" />);
  const second = render(<AskForm questionId="q1" />);
  await act(async () => {
    vi.advanceTimersByTime(KEEP_OPEN_MS);
  });
  expect(seen()).toBe(2);
  first.unmount();
  await act(async () => {
    vi.advanceTimersByTime(KEEP_OPEN_MS);
  });
  expect(seen()).toBe(3);
  second.unmount();
  await act(async () => {
    vi.advanceTimersByTime(KEEP_OPEN_MS * 2);
  });
  expect(seen()).toBe(3);
});
