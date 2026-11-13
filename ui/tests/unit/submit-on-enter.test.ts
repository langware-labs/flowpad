import { afterEach, expect, it, vi } from 'vitest';
import { submitOnEnter } from '@src/hooks/use-mobile';
import { mockMobile } from '../utils/test-utils';

afterEach(() => vi.restoreAllMocks());

const press = (key: string, shiftKey = false) => ({ key, shiftKey });

it('on a desktop plain Enter sends; Shift+Enter and other keys do not', () => {
  mockMobile(false);
  expect(submitOnEnter(press('Enter'))).toBe(true);
  expect(submitOnEnter(press('Enter', true))).toBe(false);
  expect(submitOnEnter(press('a'))).toBe(false);
});

it('on a phone Enter is the newline key — the send button sends', () => {
  mockMobile(true);
  expect(submitOnEnter(press('Enter'))).toBe(false);
});
