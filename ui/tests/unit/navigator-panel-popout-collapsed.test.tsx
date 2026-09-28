/**
 * A tab opened in its own window (`win/` layout) starts with the left navigator
 * collapsed — the window is for the content — and toggling it there never
 * rewrites the main window's persisted choice.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let windowMode = false;
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ windowMode }) }));

import { NavigatorPanel } from '@src/components/navigator-panel/NavigatorPanel';

const descriptor = { id: 'probe', roots: [], header: { title: 'Chats' } } as never;
const KEY = 'navigator:probe:collapsed';

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe('NavigatorPanel — popout window', () => {
  it('opens as stored (expanded) in the main window', () => {
    windowMode = false;
    window.localStorage.setItem(KEY, '0');
    render(<NavigatorPanel descriptor={descriptor} />);

    expect(screen.getByTestId('navigator-collapse-probe')).toBeTruthy();
  });

  it('starts collapsed in a win/ popout and does not persist its toggle', async () => {
    windowMode = true;
    window.localStorage.setItem(KEY, '0');
    render(<NavigatorPanel descriptor={descriptor} />);

    await userEvent.click(screen.getByTestId('navigator-expand-probe'));
    await userEvent.click(screen.getByTestId('navigator-collapse-probe'));

    expect(screen.getByTestId('navigator-expand-probe')).toBeTruthy();
    expect(window.localStorage.getItem(KEY)).toBe('0');
  });
});
