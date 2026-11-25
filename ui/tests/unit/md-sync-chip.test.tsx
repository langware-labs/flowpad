/**
 * The footer's MD chip: there only when syncmd reports something to do; its popover lists the
 * stale files and the unsynced sources, and Sync / Add call the backend.
 */
import '@testing-library/jest-dom/vitest';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { createSyncmdNotFoundWarning, mdSyncService, MdSyncState, refreshMdSync, type MdSyncStatus } from '@sdk';
import { MdSyncChip } from '@src/components/footer/MdSyncChip';

i18n.loadAndActivate({ locale: 'en', messages: {} });

const status = (over: Partial<MdSyncStatus> = {}): MdSyncStatus => ({
  state: MdSyncState.OK,
  version: '0.2.0',
  stale: [],
  unsynced: [],
  install_hint: '',
  detail: '',
  ...over,
});
const drifted = status({
  stale: [{ name: 'instructions', kind: 'claude_md', source: 'CLAUDE.md', targets: ['AGENTS.md'] }],
  unsynced: [{ source: 'cursor', paths: ['.cursorrules'] }],
});

async function show(answer: MdSyncStatus, project: string) {
  vi.spyOn(mdSyncService, 'status').mockResolvedValue(answer);
  await refreshMdSync(project);
  render(
    <I18nProvider i18n={i18n}>
      <MdSyncChip />
    </I18nProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('is not there when everything is in sync, or syncmd is missing', async () => {
  await show(status(), 'in-sync');
  expect(screen.queryByTestId('footer-md-sync-chip')).toBeNull();
  cleanup();
  await show(status({ state: MdSyncState.UNAVAILABLE, install_hint: 'npm install -g syncmd' }), 'no-tool');
  expect(screen.queryByTestId('footer-md-sync-chip')).toBeNull();
});

it('lists what is out of sync, and Sync and Add act on it', async () => {
  await show(drifted, 'drifted');
  const sync = vi.spyOn(mdSyncService, 'sync').mockResolvedValue(status({ unsynced: drifted.unsynced, written: 1 }));
  const add = vi.spyOn(mdSyncService, 'addSource').mockResolvedValue(status());

  fireEvent.click(screen.getByTestId('footer-md-sync-chip'));
  expect(screen.getByTestId('md-sync-stale-instructions')).toHaveTextContent('AGENTS.md· behind CLAUDE.md');

  fireEvent.click(screen.getByTestId('md-sync-run'));
  expect(await screen.findByTestId('md-sync-done')).toHaveTextContent('1 file updated');
  expect(sync).toHaveBeenCalledWith('drifted');
  expect(screen.queryByTestId('md-sync-stale-instructions')).toBeNull();

  fireEvent.click(screen.getByTestId('md-sync-add-cursor'));
  await vi.waitFor(() => expect(screen.queryByTestId('md-sync-source-cursor')).toBeNull());
  expect(add).toHaveBeenCalledWith('drifted', 'cursor');
});

it('a missing syncmd is an informational warning that carries the command', () => {
  const warning = createSyncmdNotFoundWarning({ version: '', install_hint: 'npm install -g syncmd' });
  expect(warning.diagnosable).toBe(false);
  expect(warning.description).toContain('npm install -g syncmd');
});
