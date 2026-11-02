import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '@lingui/react';
import { i18n } from '@lingui/core';
import { WebApp, type WebAppLifecycle } from '@sdk';
import { appInfoRows } from '@src/components/webapp-display/AppInfoPopover';

i18n.loadAndActivate({ locale: 'en', messages: {} });

const record = {
  webapp_id: '0f66c578-d9cb-4058-9175-a1f37f814f33',
  state: 'running',
  detail: '',
  recovery: '',
  ports: { page: 3300, api: 8090 },
  pids: { page: 12072 },
  failure: null,
  attempts: [],
  agent_call: '',
  setup_owed: '',
} as unknown as WebAppLifecycle;

describe('app info', () => {
  it('lists address, folder, ports and pids; hides empty fields', () => {
    const app = new WebApp({ id: '0f66c578-d9cb-4058-9175-a1f37f814f33', name: 'spora-admin', asset_ref: '/ws/webapp/spora-admin' } as never);
    const rows = appInfoRows({ display: { src: 'http://localhost:3300/', runtime: 'dev', available: ['dev'], endpoint: null }, lifecycle: { app, record } });
    render(
      <I18nProvider i18n={i18n}>
        <dl>{rows.map(([label, value], i) => <div key={i}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      </I18nProvider>,
    );
    expect(screen.getByText('http://localhost:3300/')).toBeTruthy();
    expect(screen.getByText('/ws/webapp/spora-admin')).toBeTruthy();
    expect(screen.getByText('page: 3300, api: 8090')).toBeTruthy();
    expect(screen.getByText('page: 12072')).toBeTruthy();
    expect(screen.queryByText('Description')).toBeNull();
    expect(screen.queryByText('Endpoint id')).toBeNull();
  });

  it('prefers the primary on-disk occurrence for the folder', () => {
    const app = new WebApp({ id: '0f66c578-d9cb-4058-9175-a1f37f814f33', asset_occurrences: [{ path: '/primary', first_seen_at: '' }] } as never);
    expect(app.folder).toBe('/primary');
  });
});
