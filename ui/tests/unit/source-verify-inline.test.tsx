/**
 * Verify answers where it was pressed: the row's status line reads "Verifying…" while the check runs, then the
 * verdict's sentence under the status word — no toast. A toast beside a row that still reads "Setup required"
 * is a notification out of order; the status line is the one place the press and its answer meet.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeSource } from './fake-source';

const notify = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), info: vi.fn() }));
vi.mock('@src/notifications', () => ({ notify }));
vi.mock('@src/components/setup-wizard/SetupStagesButton', () => ({ SetupStagesButton: () => null }));
vi.mock('@src/components/data-sources/SourceMenu', () => ({ SourceMenu: () => null }));
vi.mock('@src/components/data-sources/ChannelRouteControl', () => ({ ChannelRouteControl: () => null }));
vi.mock('@src/components/data-sources/SourceSetupButton', () => ({ SourceSetupButton: () => null }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: {} }) }));

import { DataSourceRow } from '@src/components/data-sources/DataSourceRow';

const noop = () => {};

describe('Verify on a source row', () => {
  afterEach(cleanup);

  it('shows Verifying… on the status line, then the verdict under the status word, and toasts nothing', async () => {
    const source = fakeSource('v', 'slack', { status: 'setup' });
    let answer: (v: { ready: boolean; detail: string }) => void = () => {};
    source.verify = vi.fn(() => new Promise((resolve) => { answer = resolve; })) as never;
    render(<DataSourceRow source={source} onEdit={noop} onReplay={noop} onDelete={noop} />);
    const status = () => screen.getByTestId(`source-status-${source.id}`);
    expect(status().textContent).toBe('Setup required');

    await act(async () => {
      screen.getByTestId(`source-verify-${source.id}`).click();
    });
    expect(status().dataset.verifying).toBe('true');
    expect(status().textContent).toContain('Verifying');
    expect((screen.getByTestId(`source-verify-${source.id}`) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      answer({ ready: false, detail: 'Slack refused the credential (invalid_auth).' });
    });
    expect(status().dataset.verifying).toBeUndefined();
    expect(screen.getByTestId(`source-verdict-${source.id}`).textContent).toBe('Slack refused the credential (invalid_auth).');
    expect(status().textContent).toContain('Setup required');
    expect(notify.info).not.toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('a check that did not run says so in place too', async () => {
    const source = fakeSource('w', 'slack', { status: 'setup' });
    source.verify = vi.fn(() => Promise.reject(new Error('backend away'))) as never;
    render(<DataSourceRow source={source} onEdit={noop} onReplay={noop} onDelete={noop} />);
    await act(async () => {
      screen.getByTestId(`source-verify-${source.id}`).click();
    });
    expect(screen.getByTestId(`source-verdict-${source.id}`).textContent).toContain('backend away');
    expect(notify.error).not.toHaveBeenCalled();
  });
});
