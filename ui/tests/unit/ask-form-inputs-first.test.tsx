/**
 * A question shows what to answer before how to get it: the input and Send come first, and a long
 * setup guide sits collapsed below them — never a page of markdown to scroll past to reach the input.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('@sdk/client', () => ({ default: { get: h.get, post: h.post } }));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {}, currentDock: null }),
}));

import { AskForm } from '@src/components/ask/AskForm';

beforeEach(() => {
  h.get.mockResolvedValue({
    id: 'q1',
    op: 'ask-google-cloud',
    prompt: 'Google Cloud',
    fields: 'string',
    guide: '# Google Cloud\n\nOpen the console, create a key, download it.',
  });
  h.post.mockResolvedValue({});
});

afterEach(() => {
  cleanup();
  h.get.mockReset();
  h.post.mockReset();
});

it('puts the input and Send before the guide, and keeps the guide collapsed', async () => {
  render(<AskForm questionId="q1" />);
  const submit = await screen.findByTestId('ask-submit');
  const guide = screen.getByTestId('ask-guide');

  expect(submit.compareDocumentPosition(guide) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(guide.tagName).toBe('DETAILS');
  expect(guide).not.toHaveAttribute('open');
});
