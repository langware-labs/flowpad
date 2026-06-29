/**
 * RCA repro (rename tab/process ↛ left-menu chat-history row): renaming an
 * agentic-process tab — or the process directly — updates the AgenticProcess
 * name in the backend (proven by tab_rename.test.ts), yet the left-side chat
 * list (ChatsNavigator → ChatHistoryRow) keeps showing the OLD name.
 *
 * Expectation (user): rename session == rename tab == rename process, and the
 * left-menu row must follow — bidirectionally.
 *
 * Faithful, no-mock: a REAL AgenticProcess is created and renamed through the
 * REAL backend (the exact strip action POST /graph/tab/<id>/rename for the tab
 * direction; entity save for the process direction). The component under test —
 * ChatHistoryRow — is rendered for real. The only test data is the
 * `WorkerHistoryEntry` prop, which is exactly the stale snapshot production also
 * holds (the worker-history action is never refetched on rename).
 *
 * Bug (both assertions below fail today): after the process is renamed and the
 * client cache reflects the new name (`displayName === 'new name'`), the row
 * STILL renders the old name, because `pickHistoryTitle` returns the stale
 * `entry.name` and never consults the freshly-renamed `process.displayName`
 * (history-row.tsx:42). Fix: make the row reflect the live backing entity's name
 * over a stale worker-history snapshot.
 */
import '@src/i18n-init';
import { i18n } from '@lingui/core';
import { I18nProvider } from '@lingui/react';
import { AgenticProcess, Tab, dataManager } from '@sdk';
import { ChatHistoryRow } from '@src/components/chats-navigator/ChatHistoryRow';
import type { WorkerHistoryEntry } from '@src/hooks/useWorkerHistory';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

function row(entry: WorkerHistoryEntry) {
  return (
    <I18nProvider i18n={i18n}>
      <ChatHistoryRow
        entry={entry}
        selected={false}
        onSelect={() => {}}
        onToggleFavorite={() => {}}
        onDelete={() => {}}
      />
    </I18nProvider>
  );
}

/** The stale worker-history snapshot the navigator feeds the row: name was the
 *  AgenticProcess name at action-call time, and is NOT refetched on rename. */
function entryFor(processId: string, name: string): WorkerHistoryEntry {
  return {
    worker_type: 'claude',
    worker_id: uuidv4(),
    project_id: null,
    project_name: null,
    project_cwd: null,
    last_active_time: '2026-06-26T20:31:52.385000Z',
    name,
    last_prompt: null,
    git_branch: null,
    message_count: 0,
    agentic_process_id: processId,
  };
}

/** Create the Tab the strip would and rename it through the exact backend action
 *  the strip uses (POST /graph/tab/<id>/rename), which reflects onto the AP. */
async function renameViaTab(processId: string, name: string): Promise<void> {
  const pointer = `dock/${AgenticProcess.type}-${processId}`;
  const created = await Tab.newTab(pointer, { targetType: AgenticProcess.type, targetId: processId });
  const tab = created.find((t) => t.target_id === processId);
  expect(tab).toBeTruthy();
  await Tab.renameById(tab!.id, name);
}

describe('chat-history row follows a tab/process rename (bidirectional)', () => {
  const info = getTestSignupInfo();

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
  });

  it('tab rename → row reflects the new name', async () => {
    const id = uuidv4();
    await new AgenticProcess({ id, name: 'old name', auto_rename: true, worker_type: 'claude_code' } as any).save();

    const stale = entryFor(id, 'old name');
    const view = render(row(stale));
    expect(screen.getByText('old name')).toBeInTheDocument();

    // Rename through the real strip action; pull the committed state into the
    // client cache (production gets this via a WS data-op) — ground truth that
    // the PROCESS is renamed.
    await renameViaTab(id, 'new name');
    await dataManager.clearCache();
    const reloaded = await AgenticProcess.getById(id);
    expect(reloaded!.displayName).toBe('new name'); // process really renamed

    // Re-render the SAME row (stale worker-history prop, as production holds it):
    // the left-menu row must now follow the renamed process. It does not —
    // pickHistoryTitle returns the stale entry.name.
    view.rerender(row(stale));
    await waitFor(() => expect(screen.getByText('new name')).toBeInTheDocument());
  }, 15000);

  it('process rename → row reflects the new name', async () => {
    const id = uuidv4();
    const proc = new AgenticProcess({ id, name: 'old name', auto_rename: true, worker_type: 'claude_code' } as any);
    await proc.save();

    const stale = entryFor(id, 'old name');
    const view = render(row(stale));
    expect(screen.getByText('old name')).toBeInTheDocument();

    proc.name = 'new name';
    await proc.save();
    await dataManager.clearCache();
    const reloaded = await AgenticProcess.getById(id);
    expect(reloaded!.displayName).toBe('new name'); // process really renamed

    view.rerender(row(stale));
    await waitFor(() => expect(screen.getByText('new name')).toBeInTheDocument());
  }, 15000);
});
