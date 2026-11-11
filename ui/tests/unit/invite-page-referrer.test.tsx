// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@sdk')>()),
  redeemInviteLink: () => Promise.resolve({ redirect_url: 'http://localhost/dock/hub/home' }),
}));

import InvitePage from '@src/pages/entry/InvitePage';

// After the redirect, the next page's `document.referrer` would be this URL, and GTM reads it.
// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.analytics_url_secrets.rules: FAILING? keep the invite token out
//       of the next page's referrer - GA4 sends it as dr. Read this tag's rules before
//       editing
// flowpad:endcapsule tag
describe('invite redirect', () => {
  it('keeps the token out of the next page referrer', async () => {
    i18n.loadAndActivate({ locale: 'en', messages: {} });
    render(
      <I18nProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/invite/secret-token']}>
          <Routes>
            <Route path="/invite/:token" element={<InvitePage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
    });
  });
});
