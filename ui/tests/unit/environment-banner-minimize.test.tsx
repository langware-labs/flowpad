/**
 * The environment banner's minimize behaviour.
 *
 * The banner is a safety signal — on a cloud sandbox or an agent's box it is
 * how you know whose machine you are looking at — so "close" must never mean
 * "gone". It hands the color to the rail's Home icon and comes back on the next
 * restart. These tests pin all three halves of that contract: the store's
 * lifetime, the banner's response, and the tint the rail picks up.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { RuntimeKind } from '@sdk';

vi.mock('@src/notifications', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));

// The banner's other collaborators are irrelevant here — it is the close button
// under test, not the wiki route.
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: { openDock: vi.fn() } }),
}));

// Literal, not `RuntimeKind.SANDBOX`: `vi.hoisted` runs before the imports are
// initialized, so referencing the enum here is a TDZ error.
const runtimeKind = vi.hoisted(() => ({ current: 'sandbox' as string }));
vi.mock('@src/hooks/useContext', () => ({
  useContext: () => ({ runtimeKind: runtimeKind.current }),
}));

import { EnvironmentBanner } from '@src/components/environment-banner/EnvironmentBanner';
import {
  minimizeBanner,
  restoreBanner,
  useBannerMinimized,
} from '@src/components/environment-banner/use-banner-minimized';
import { RUNTIME_CLASS } from '@src/components/environment-banner/runtime-appearance';

beforeEach(() => {
  restoreBanner();
  runtimeKind.current = RuntimeKind.SANDBOX;
});

afterEach(cleanup);

describe('the banner', () => {
  it('shows its runtime label and color by default', () => {
    render(<EnvironmentBanner />);
    const banner = screen.getByTestId('environment-banner');

    expect(banner.getAttribute('data-runtime')).toBe(RuntimeKind.SANDBOX);
    expect(banner.textContent).toContain('Cloud Sandbox');
  });

  it('disappears when closed', async () => {
    render(<EnvironmentBanner />);
    await userEvent.click(screen.getByTestId('environment-banner-close'));

    expect(screen.queryByTestId('environment-banner')).toBeNull();
  });

  it('does not nest a button inside a button', () => {
    // The root used to BE the wiki button; adding close inside it would be
    // invalid HTML that React warns about and screen readers mis-announce.
    render(<EnvironmentBanner />);
    const banner = screen.getByTestId('environment-banner');

    expect(banner.tagName).toBe('DIV');
    expect(banner.querySelectorAll('button button')).toHaveLength(0);
  });
});

describe('the minimized store', () => {
  function Probe() {
    return <span data-testid="probe">{String(useBannerMinimized())}</span>;
  }

  it('starts visible and flips for every subscriber at once', async () => {
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('false');

    minimizeBanner();
    await screen.findByText('true');
  });

  it('survives a remount — a route change must not resurrect the banner', () => {
    minimizeBanner();
    const first = render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('true');

    first.unmount();
    render(<Probe />);
    expect(screen.getByTestId('probe').textContent).toBe('true');
  });

  it('is session-scoped, so a restart brings the banner back', () => {
    minimizeBanner();
    expect(window.sessionStorage.getItem('flowpad.environment-banner.minimized')).toBe('1');
    // Nothing is written to localStorage: that would outlive the restart the
    // user was promised, permanently silencing a safety signal.
    expect(window.localStorage.getItem('flowpad.environment-banner.minimized')).toBeNull();
  });
});

describe('the color table', () => {
  // The banner and the rail share ONE table, so they cannot drift — there is no
  // "do the two agree" test to write. What is still worth pinning is coverage
  // and the forced foreground, both of which fail silently in the browser.
  it('covers every runtime kind', () => {
    for (const kind of Object.values(RuntimeKind)) {
      expect(RUNTIME_CLASS[kind], kind).toBeTruthy();
    }
  });

  it('forces a foreground, so the tinted rail icon stays legible', () => {
    // The rail button sets its own text color for active/hover and wins at equal
    // specificity; without `!` the near-black glyph sits on green-700.
    for (const kind of Object.values(RuntimeKind)) {
      expect(RUNTIME_CLASS[kind], kind).toMatch(/!text-/);
    }
  });

  it('spells every class as a source literal', () => {
    // Tailwind generates CSS by scanning source text. A class assembled at
    // runtime is never emitted, and the failure is invisible to these tests —
    // the strings stay right while the CSS goes missing.
    const source = readFileSync(
      resolve(__dirname, '../../src/components/environment-banner/runtime-appearance.ts'),
      'utf8',
    );
    for (const cls of Object.values(RUNTIME_CLASS).flatMap((c) => c.split(' '))) {
      expect(source, cls).toContain(cls);
    }
  });
});
