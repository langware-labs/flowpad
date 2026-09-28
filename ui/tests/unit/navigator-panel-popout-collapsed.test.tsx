/**
 * The navigator follows its host's collapse policy: a `win/` popout (ContentPanel
 * provides POPOUT_NAVIGATOR_POLICY) starts collapsed, and toggling it there never
 * rewrites the main window's persisted choice.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NavigatorCollapsePolicyContext,
  NavigatorPanel,
  POPOUT_NAVIGATOR_POLICY,
} from '@src/components/navigator-panel/NavigatorPanel';

const descriptor = { id: 'probe', roots: [], header: { title: 'Chats' } } as never;
const KEY = 'navigator:probe:collapsed';

beforeEach(() => window.localStorage.clear());
afterEach(() => cleanup());

describe('NavigatorPanel — collapse policy', () => {
  it('opens as stored (expanded) under the default policy', () => {
    window.localStorage.setItem(KEY, '0');
    render(<NavigatorPanel descriptor={descriptor} />, { wrapper: MemoryRouter });

    expect(screen.getByTestId('navigator-collapse-probe')).toBeTruthy();
  });

  it('starts collapsed under the popout policy and does not persist its toggle', async () => {
    window.localStorage.setItem(KEY, '0');
    render(
      <NavigatorCollapsePolicyContext.Provider value={POPOUT_NAVIGATOR_POLICY}>
        <NavigatorPanel descriptor={descriptor} />
      </NavigatorCollapsePolicyContext.Provider>,
      { wrapper: MemoryRouter },
    );

    await userEvent.click(screen.getByTestId('navigator-expand-probe'));
    await userEvent.click(screen.getByTestId('navigator-collapse-probe'));

    expect(screen.getByTestId('navigator-expand-probe')).toBeTruthy();
    expect(window.localStorage.getItem(KEY)).toBe('0');
  });
});
