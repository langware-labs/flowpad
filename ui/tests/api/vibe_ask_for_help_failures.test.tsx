/**
 * The three failures the "Ask someone for help" stress run found (2026-10-05), each on the real
 * path against a real hub-logged-in backend (run with FLOW_INSTANCE=<instance_ctl instance>).
 *
 * 1. A new conversation's first message never reaches the hub. `share` pushes the conversation
 *    and `Entity.share()` flips `remote` in MEMORY, so `share_entity`'s "persist remote=True"
 *    guard (`if remote is not True`) skips the save. The row only turns remote when the hub's WS
 *    echo lands; an `add_message` that reads the row first (`is_remote_send` false) saves the
 *    message locally and never pushes it. Here the echo is taken away for real — the backend's
 *    hub WS is disconnected — so the race is lost every time instead of ~1 in 20.
 * 2. Two picked files with the same name: the second is silently dropped (`uploadFilesToTask`
 *    skips a name already uploaded). Asserted on the sender's task plus the hub's file-name
 *    rule — a proxy for the recipient, who only gets what the hub accepted.
 * 3. A taken title is assigned as "<title> (2)", but the message still says "<title>".
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { apiClient, createAndSendConversation, dataContext, Project, Task, TaskKind } from '@sdk';
import { cloudManager } from '@sdk/services/cloud_login';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadFilesToTask } from '@src/components/assets/editor/task/task-attachment-upload';
import { VibeAssignTaskDialog } from '@src/pages/flow-page/VibeAssignTaskDialog';
import { apiTestSetup, getTestSignupInfo, trackCreatedRows } from '../utils/test-utils';

const HELPER = 'helper@local.test';

describe('Ask someone for help — stress-run failures', () => {
  const signupInfo = getTestSignupInfo();
  const projectDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'askfail'));
  const { created: cleanupProjects } = trackCreatedRows(Project.type);
  const { created: cleanupTasks } = trackCreatedRows(Task.type);
  let projectId = '';

  beforeEach(async (ctx: { task: { name: string } }) => {
    await apiTestSetup(signupInfo, ctx.task.name);
    // The app's boot reads the hub login (main.ts → cloudManager); the tier's setup does not.
    await cloudManager.refreshStatus();
    expect(dataContext.cloudLoginAvailable, 'needs a hub-logged-in backend (FLOW_INSTANCE=…)').toBe(true);
    if (!projectId) {
      projectId = (await new Project({ name: projectDir }).save([])).id;
      cleanupProjects.push(projectId);
    }
  });
  afterEach(() => cleanup());
  afterAll(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  const png = (name: string, size: number) => new File([new Uint8Array(size)], name, { type: 'image/png' });

  it('1. the first message of a new conversation reaches the hub without the hub WS echo', async () => {
    const task = await Task.createWithFreeTitle({ title: `msg reaches hub ${Date.now()}` }, []);
    cleanupTasks.push(task.id);
    await apiClient.post('/cloud/ws/disconnect');
    try {
      const { conversation_id } = await createAndSendConversation(
        { project_id: null, participants: [{ email: HELPER }], title: task.title },
        { text: task.title, assetReferences: [task.typeId.toString()], sharedContextEntities: [task.typeId.toString()] },
      );
      const conv = await apiClient.get<{ remote?: boolean }>(`/graph/conversation/${conversation_id}`);
      expect(conv.remote, 'the shared conversation must be hub-bound before its first message').toBe(true);
    } finally {
      await apiClient.post('/cloud/ws/connect');
    }
  });

  it('2. two picked files with the same name both reach the task', async () => {
    const task = await Task.createWithFreeTitle({ title: `same name ${Date.now()}` }, []);
    cleanupTasks.push(task.id);
    const failed: string[] = [];
    const entries = await uploadFilesToTask(task.typeId, [png('dup.png', 10), png('dup.png', 20)], [], (f) =>
      failed.push(f.name),
    );
    expect(failed).toEqual([]);
    expect(entries.map((e) => e.label)).toHaveLength(2);
    // And under names that travel: the hub refuses these in any file path
    // (hub fs_api `_SHELL_INJECTION_CHARS`), so "dup (2).png" stayed on this machine.
    for (const { label } of entries) expect(label).not.toMatch(/[;|&$`<>()\n\r]/);
  });

  it('3. a taken title is told in the message as the title the task got', async () => {
    const title = `taken title ${Date.now()}`;
    cleanupTasks.push((await Task.createWithFreeTitle({ title, kind: TaskKind.VIBE }, [])).id);

    const onAssigned = vi.fn();
    const { container } = render(
      <VibeAssignTaskDialog open onOpenChange={() => {}} projectId={null} sessionTypeId={null} onAssigned={onAssigned} />,
    );
    const dialog = container.ownerDocument.querySelector('[role="dialog"]') as HTMLElement;
    const by = (id: string) => dialog.querySelector(`[data-testid="${id}"]`) as HTMLElement;
    fireEvent.change(by('vibe-assign-person'), { target: { value: HELPER } });
    fireEvent.blur(by('vibe-assign-person'));
    fireEvent.change(by('vibe-assign-title'), { target: { value: title } });
    fireEvent.click(by('vibe-assign-submit'));
    await waitFor(() => expect(onAssigned).toHaveBeenCalled(), { timeout: 15000 });
    const taskId = onAssigned.mock.calls[0][0] as string;
    cleanupTasks.push(taskId);

    const task = await apiClient.get<{ title: string; parent_type_id?: string }>(`/graph/task/${taskId}`);
    expect(task.title).toBe(`${title} (2)`);
    // The conversation the task was asked in is its hub parent.
    const convId = task.parent_type_id!.replace(/^conversation-/, '');
    const messages = await apiClient.get<{ text?: string }[]>(`/graph/conversation/${convId}/flow_message`);
    expect(messages.map((m) => m.text)).toEqual([expect.stringContaining(task.title)]);
  });
});
