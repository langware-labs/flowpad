/**
 * The identity block at the top of the user menu.
 *
 * Three independently-optional lines, and the rules between them are the part
 * worth pinning: a missing title must not leave a blank row, and the email must
 * never be printed twice when it is already standing in for a missing name.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';

import { UserMenuHeader } from '@src/pages/flow-page/content-panel/user-dropdown/user-menu-header';

afterEach(cleanup);

const q = (id: string) => screen.queryByTestId(id)?.textContent ?? null;

describe('UserMenuHeader', () => {
  it('shows name, title and email as three lines', () => {
    render(<UserMenuHeader name="Eran Shlomo" title="Founder & CEO" email="eran@langware.ai" />);

    expect(q('user-menu-name')).toBe('Eran Shlomo');
    expect(q('user-menu-title')).toBe('Founder & CEO');
    expect(q('user-menu-email')).toBe('eran@langware.ai');
  });

  it('skips the title line when there is no title', () => {
    // The common case today: `title` is a base-entity field nobody has set yet.
    // It must collapse, not render an empty row that pushes the email down.
    render(<UserMenuHeader name="Eran Shlomo" email="eran@langware.ai" />);

    expect(screen.queryByTestId('user-menu-title')).toBeNull();
    expect(q('user-menu-name')).toBe('Eran Shlomo');
    expect(q('user-menu-email')).toBe('eran@langware.ai');
  });

  it('does not print the email twice when it stands in for a missing name', () => {
    render(<UserMenuHeader email="eran@langware.ai" />);

    expect(q('user-menu-name')).toBe('eran@langware.ai');
    expect(screen.queryByTestId('user-menu-email')).toBeNull();
  });

  it('still renders a title under an email-only identity', () => {
    // An agent principal has a title and often no human-style name.
    render(<UserMenuHeader email="joe@agents.local" title="Support Agent" />);

    expect(q('user-menu-name')).toBe('joe@agents.local');
    expect(q('user-menu-title')).toBe('Support Agent');
    expect(screen.queryByTestId('user-menu-email')).toBeNull();
  });

  it('falls back to a generic label when there is no identity at all', () => {
    render(<UserMenuHeader />);

    expect(q('user-menu-name')).toBe('Signed in');
    expect(screen.queryByTestId('user-menu-title')).toBeNull();
    expect(screen.queryByTestId('user-menu-email')).toBeNull();
  });

  it('uses the picture as the blurred backdrop', () => {
    render(<UserMenuHeader name="X" pictureUrl="https://example.test/a.png" />);
    const backdrop = screen.getByTestId('user-menu-header').firstElementChild as HTMLElement;

    expect(backdrop.style.backgroundImage).toContain('https://example.test/a.png');
    expect(backdrop.style.filter).toContain('blur');
  });

  it('does not let a crafted picture url inject CSS', () => {
    // `picture` comes off the wire, and a bare url() would let a crafted value
    // close the function and append declarations. Asserted as the property that
    // matters — no injected declaration takes effect — rather than on the
    // escaping itself, which jsdom discards along with the whole value.
    render(<UserMenuHeader name="X" pictureUrl={'https://x/a.png"); background: red; ("'} />);
    const backdrop = screen.getByTestId('user-menu-header').firstElementChild as HTMLElement;

    expect(backdrop.style.backgroundColor).toBe('');
    expect(backdrop.getAttribute('style') ?? '').not.toContain('red');
  });
});
