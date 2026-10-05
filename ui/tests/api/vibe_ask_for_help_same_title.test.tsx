/**
 * "Ask someone for help" a second time with the same title must assign, not fail with a bare
 * "Request failed with status code 409" (a production user, 2026-10-05: a screenshot attached,
 * Assign → the red 409 row, and every retry the same).
 *
 * Real path, no mocks: the real dialog on a real, hub-logged-in backend. A task is a folder named
 * by its title, unique in its project, so the second ask of the same title collides on the create
 * (`POST /graph/project/<id>/task` → 409 "An task named '…' already exists in this scope"). The
 * dialog takes the next free title ("… (2)") and assigns, as "Task it" does.
 *
 * Needs a backend logged in to a hub: run with `FLOW_INSTANCE=<an instance_ctl instance>`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { dataContext, Project, Task } from '@sdk';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudManager } from '@sdk/services/cloud_login';
import { VibeAssignTaskDialog } from '@src/pages/flow-page/VibeAssignTaskDialog';
import { apiTestSetup, getTestSignupInfo, trackCreatedRows } from '../utils/test-utils';

describe('Vibe "Ask someone for help", the same title twice', () => {
  const signupInfo = getTestSignupInfo();
  const projectDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'askhelp'));
  const { created: cleanupProjects } = trackCreatedRows(Project.type);
  const { created: cleanupTasks } = trackCreatedRows(Task.type);

  beforeEach(async (ctx: any) => {
    await apiTestSetup(signupInfo, ctx.task.name);
    // The app's boot reads the hub login (main.ts → cloudManager); the tier's setup does not.
    await cloudManager.refreshStatus();
  });
  afterEach(() => cleanup());
  afterAll(() => fs.rmSync(projectDir, { recursive: true, force: true }));

  /** One ask through the dialog: person, title, a screenshot, Assign. Returns the assigned task id or the error row. */
  async function ask(projectId: string, title: string): Promise<{ taskId?: string; error?: string }> {
    const onAssigned = vi.fn();
    const { container, unmount } = render(
      <VibeAssignTaskDialog open onOpenChange={() => {}} projectId={projectId} sessionTypeId={null} onAssigned={onAssigned} />,
    );
    const person = screen.getByTestId('vibe-assign-person');
    fireEvent.change(person, { target: { value: 'helper@local.test' } });
    fireEvent.blur(person);
    fireEvent.change(screen.getByTestId('vibe-assign-title'), { target: { value: title } });
    const shot = new File([new Uint8Array(4096)], 'screenshot-20261005-103833-668.png', { type: 'image/png' });
    fireEvent.change(document.querySelector('input[type="file"]')!, { target: { files: [shot] } });
    await screen.findByText('screenshot-20261005-103833-668.png');

    fireEvent.click(screen.getByTestId('vibe-assign-submit'));
    // The ask ends one of two ways: assigned, or the dialog's error row.
    const errorRow = () => container.ownerDocument.querySelector('p.border-destructive\\/60');
    await waitFor(() => expect(onAssigned.mock.calls.length > 0 || errorRow() !== null).toBe(true));

    const error = errorRow()?.textContent ?? undefined;
    const taskId = onAssigned.mock.calls[0]?.[0] as string | undefined;
    if (taskId) cleanupTasks.push(taskId);
    unmount();
    return { taskId, error };
  }

  it('assigns the second ask too', async () => {
    expect(dataContext.cloudLoginAvailable, 'this test needs a hub-logged-in backend (FLOW_INSTANCE=…)').toBe(true);
    const project = await new Project({ name: projectDir }).save([]);
    cleanupProjects.push(project.id);
    const title = `The admin crashed after pull ${Date.now()}`;

    const first = await ask(project.id, title);
    expect(first.error).toBeUndefined();
    expect(first.taskId).toBeTruthy();

    const second = await ask(project.id, title);
    expect(second.error).toBeUndefined();
    expect(second.taskId).toBeTruthy();
  });
});
