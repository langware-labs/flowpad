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
 * 3. A title already taken in the project (the user's original report: Assign → a bare
 *    "Request failed with status code 409", and every retry the same) assigns as "<title> (2)",
 *    screenshot and all, and the message names that title.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { apiClient, createAndSendConversation, Project, Task, TaskKind, TypeId } from '@sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { uploadFilesToTask } from '@src/components/assets/editor/task/task-attachment-upload';
import { askForHelp, hubLoggedInSetup, png } from '../utils/ask-for-help';
import { getTestSignupInfo, trackCreatedRows } from '../utils/test-utils';

const HELPER = 'helper@local.test';

describe('Ask someone for help — stress-run failures', () => {
  const signupInfo = getTestSignupInfo();
  const projectDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'askfail'));
  const { created: cleanupTasks } = trackCreatedRows(Task.type);
  let projectId = '';

  beforeEach(async (ctx: { task: { name: string } }) => {
    await hubLoggedInSetup(signupInfo, ctx.task.name);
    // One project for the file: `trackCreatedRows` deletes after EACH test, too early for it.
    if (!projectId) projectId = (await new Project({ name: projectDir }).save([])).id;
  });
  afterEach(() => cleanup());
  afterAll(async () => {
    if (projectId) await apiClient.delete(`/graph/project/${projectId}`).catch(() => {});
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('1. the first message of a new conversation reaches the hub without the hub WS echo', async () => {
    const task = await Task.createWithFreeTitle({ title: `msg reaches hub ${Date.now()}` }, []);
    cleanupTasks.push(task.id);
    await apiClient.post('/cloud/ws/disconnect');
    try {
      const { conversation_id } = await createAndSendConversation(
        { project_id: null, participants: [{ email: HELPER }], title: task.title },
        {
          text: task.title,
          assetReferences: [task.typeId.toString()],
          sharedContextEntities: [task.typeId.toString()],
        },
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

  it('3. a taken title assigns as the next free one, screenshot and all, and the message says so', async () => {
    const title = `taken title ${Date.now()}`;
    const scope = [new TypeId('project', projectId)];
    cleanupTasks.push((await Task.createWithFreeTitle({ title, kind: TaskKind.VIBE }, scope)).id);

    const { taskId, error } = await askForHelp({ projectId, to: HELPER, title, files: [png('shot.png', 4096)] });
    expect(error).toBeUndefined();
    cleanupTasks.push(taskId!);

    const task = await apiClient.get<{ title: string; parent_type_id?: string; artifacts?: { label: string }[] }>(
      `/graph/task/${taskId}`,
    );
    expect(task.title).toBe(`${title} (2)`);
    expect(task.artifacts?.map((a) => a.label)).toEqual(['shot.png']);
    // The conversation the task was asked in is its hub parent.
    const convId = task.parent_type_id!.replace(/^conversation-/, '');
    const messages = await apiClient.get<{ text?: string }[]>(`/graph/conversation/${convId}/flow_message`);
    expect(messages.map((m) => m.text)).toEqual([expect.stringContaining(task.title)]);
  });
});
