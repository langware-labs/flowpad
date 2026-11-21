/**
 * One footer chip that throws while rendering must not take the app with it. On 2026-11-21 a page left open
 * across an update ran the old browser chip against the new server's answer; the throw reached the router's
 * root boundary and replaced the whole app with the error screen.
 */
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { FooterChip } from '@src/components/footer/FooterChip';

function Thrower(): never {
  throw new TypeError("Cannot read properties of undefined (reading 'up')");
}

it('a footer chip that throws disappears; its sibling stays', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(
    <>
      <FooterChip name="browser">
        <Thrower />
      </FooterChip>
      <FooterChip name="live sessions">
        <span>live sessions</span>
      </FooterChip>
    </>,
  );
  expect(screen.getByText('live sessions')).toBeInTheDocument();
});
