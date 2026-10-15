/** The line above a running app: up or not, its port, and Restart / Stop — read from the project's app-ports. */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { Project, type ProjectAppPort } from '@sdk';
const openFile = vi.hoisted(() => vi.fn());
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: { openFile } }) }));

import { AppStatusLine } from '@src/components/webapp-display/AppStatusLine';

const row = (over: Partial<ProjectAppPort>): ProjectAppPort => ({
  app: 'spora-admin', process: 'page', declared: 3300, required: false, state: 'running', port: 50211, pid: 1, note: '', ...over,
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function line() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AppStatusLine projectId="p1" app="spora-admin" /></QueryClientProvider>);
}

it('says the app is running and on which port', async () => {
  vi.spyOn(Project, 'appPorts').mockResolvedValue([row({ app: 'other', port: 1 }), row({})]);
  line();
  expect(await screen.findByTestId('app-status-state')).toHaveTextContent('running');
  expect(screen.getByTestId('app-status-port')).toHaveTextContent(':50211');
});

it('Restart restarts THAT app', async () => {
  vi.spyOn(Project, 'appPorts').mockResolvedValue([row({})]);
  const stop = vi.spyOn(Project, 'stopApp').mockResolvedValue({ ok: true, detail: '' });
  line();
  fireEvent.click(await screen.findByRole('button', { name: 'Restart' }));
  await waitFor(() => expect(stop).toHaveBeenCalledWith('p1', 'spora-admin', true));
});

it('shows nothing for an app the project does not run', async () => {
  vi.spyOn(Project, 'appPorts').mockResolvedValue([row({ app: 'other' })]);
  line();
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.queryByTestId('app-status-line')).toBeNull();
});

it('Logs opens the log the running app writes', async () => {
  vi.spyOn(Project, 'appPorts').mockResolvedValue([row({ log: '/logs/app-open/spora-admin-50211.log' })]);
  line();
  fireEvent.click(await screen.findByRole('button', { name: 'Logs' }));
  expect(openFile).toHaveBeenCalledWith('/logs/app-open/spora-admin-50211.log');
});
