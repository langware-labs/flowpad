/**
 * The OS window title mirrors the address bar: project and leaf only, with
 * the app name in front, and the bare app name whenever nothing is addressed.
 */
import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useDocumentTitle, windowTitleFor } from '@src/navigation/window-title';

const crumb = (label: string, kind: 'project' | 'ancestor' | 'current') => ({ label, kind });

describe('windowTitleFor', () => {
  it.each([
    ['an asset inside a project', [crumb('Acme', 'project'), crumb('plan.md', 'current')], 'Flowpad: Acme / plan.md'],
    [
      'ancestors dropped',
      [crumb('Acme', 'project'), crumb('docs', 'ancestor'), crumb('plan.md', 'current')],
      'Flowpad: Acme / plan.md',
    ],
    ['a view with no project', [crumb('Assets', 'current')], 'Flowpad: Assets'],
    ['a blank project label', [crumb('  ', 'project'), crumb('Home', 'current')], 'Flowpad: Home'],
    ['no crumbs', [], 'Flowpad'],
  ])('%s', (_name, crumbs, expected) => {
    expect(windowTitleFor(crumbs)).toBe(expected);
  });
});

describe('useDocumentTitle', () => {
  const original = document.title;
  afterEach(() => {
    document.title = original;
  });

  it('owns the title while mounted and hands it back after', () => {
    const { rerender, unmount } = renderHook(({ title }) => useDocumentTitle(title), {
      initialProps: { title: 'Flowpad: Acme / plan.md' },
    });
    expect(document.title).toBe('Flowpad: Acme / plan.md');

    rerender({ title: 'Flowpad: Acme / Home' });
    expect(document.title).toBe('Flowpad: Acme / Home');

    unmount();
    expect(document.title).toBe('Flowpad');
  });
});
