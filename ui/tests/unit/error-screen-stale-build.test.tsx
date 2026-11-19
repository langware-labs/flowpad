// @vitest-environment jsdom
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { render, screen } from '@testing-library/react';
import { RouterProvider, createMemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import ErrorScreen from '@src/components/agent-layout/error-screen/error-screen';

function renderWithRouteError(error: Error) {
  const Throw = () => {
    throw error;
  };
  i18n.loadAndActivate({ locale: 'en', messages: {} });
  const router = createMemoryRouter([{ path: '/', element: <Throw />, errorElement: <ErrorScreen /> }]);
  render(
    <I18nProvider i18n={i18n}>
      <RouterProvider router={router} />
    </I18nProvider>,
  );
}

describe('error screen', () => {
  // The exact error prod logged when a chart was opened on a page loaded before an upgrade.
  it('offers a reload when a code chunk of the previous build is gone', () => {
    renderWithRouteError(
      new TypeError(
        'Failed to fetch dynamically imported module: http://localhost:9007/assets/SequenceChartView-dHzQnqoV.js',
      ),
    );

    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy();
    expect(screen.queryByText('Service Unavailable')).toBeNull();
  });

  it('still reports an unreachable backend as an outage', () => {
    renderWithRouteError(new TypeError('Failed to fetch'));

    expect(screen.getByText('Service Unavailable')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull();
  });
});
