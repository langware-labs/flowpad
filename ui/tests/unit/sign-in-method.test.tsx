import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { methodForOAuthFlow, SignInMethodIcon } from '@src/components/connections-manager/sign-in-method';

describe('SignInMethodIcon', () => {
  afterEach(() => cleanup());

  it.each([
    ['oauth', 'OAuth'],
    ['device', 'Device login'],
    ['api_key', 'API key'],
  ] as const)('names %s as %s', (method, label) => {
    render(<SignInMethodIcon method={method} testId="m" />);
    expect(screen.getByTestId('m').getAttribute('aria-label')).toBe(label);
  });

  it('carries the specifics, skipping the empty ones', () => {
    render(<SignInMethodIcon method="device" lines={['Anthropic account · Max', '', null, 'a@b.co']} testId="m" />);
    expect(screen.getByTestId('m').getAttribute('aria-label')).toBe('Device login — Anthropic account · Max — a@b.co');
  });

  it('treats only the device grant as a device login', () => {
    expect(methodForOAuthFlow('device')).toBe('device');
    expect(methodForOAuthFlow('code')).toBe('oauth');
    expect(methodForOAuthFlow('loopback')).toBe('oauth');
    expect(methodForOAuthFlow('manual')).toBe('oauth');
  });
});
