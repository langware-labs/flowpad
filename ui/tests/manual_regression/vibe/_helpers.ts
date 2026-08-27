import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apiBase } from '../_shared/api';

export const API = apiBase();

export interface VibeFixture {
  root: string;
  projectId: string;
  processId: string;
}

async function successfulData(
  response: Awaited<ReturnType<APIRequestContext['post']>>,
): Promise<Record<string, unknown>> {
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.status).toBe('SUCCESS');
  expect(body.data).toBeTruthy();
  return body.data as Record<string, unknown>;
}

export async function createVibeFixture(
  request: APIRequestContext,
  label: string,
): Promise<VibeFixture> {
  const root = mkdtempSync(path.join(tmpdir(), `flowpad-${label}-`));
  const project = await successfulData(
    await request.post(`${API}/api/v1/graph/project`, {
      data: { name: path.basename(root), fs_storage_mount_path: root },
    }),
  );
  const process = await successfulData(
    await request.post(`${API}/api/v1/graph/agentic_process`, {
      data: {
        name: `${label} process`,
        project_id: project.id,
        workdir: root,
        worker_type: 'claude_code',
        visible: false,
        pty_mode: false,
      },
    }),
  );
  return { root, projectId: String(project.id), processId: String(process.id) };
}

export async function destroyVibeFixture(
  request: APIRequestContext,
  fixture: VibeFixture,
): Promise<void> {
  await request.delete(`${API}/api/v1/graph/agentic_process/${fixture.processId}`).catch(() => undefined);
  await request.delete(`${API}/api/v1/graph/project/${fixture.projectId}`).catch(() => undefined);
  rmSync(fixture.root, { recursive: true, force: true });
}

export async function showPath(
  request: APIRequestContext,
  processId: string,
  filePath: string,
): Promise<Record<string, unknown>> {
  return successfulData(
    await request.post(`${API}/api/v1/graph/agentic_process/${processId}/show`, {
      data: { path: filePath },
    }),
  );
}

export async function showTypeId(
  request: APIRequestContext,
  processId: string,
  typeid: string,
): Promise<Record<string, unknown>> {
  return successfulData(
    await request.post(`${API}/api/v1/graph/agentic_process/${processId}/show`, {
      data: { typeid },
    }),
  );
}

export async function showPort(
  request: APIRequestContext,
  processId: string,
  port: number,
): Promise<Record<string, unknown>> {
  return successfulData(
    await request.post(`${API}/api/v1/graph/agentic_process/${processId}/show`, {
      data: { port },
    }),
  );
}

export async function openVibe(page: Page, processId: string): Promise<void> {
  await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
  await page.goto(`/dock/shell/agentic_process-${processId}?viewMode=vibe`);
  await expect(page).toHaveURL(/\/dock\/shell\/agentic_process-.*viewMode=vibe/);
  await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();
  await expect(page.getByTestId('workspace-display-tab')).toBeVisible();
}

/**
 * Seed a chat the Vibe rail can RESUME, and scope its project. `lastVibeChatQuery`
 * matches project_id (the SCOPED project) + process_type=chat + a non-null
 * last_active_at; none of those come from create alone, and with no resumable
 * chat the rail's Chats icon lands on the home hero — no `VibeDisplay` ever
 * mounts. `openVibe` is load-bearing: visiting the process is what puts its
 * project in scope for the later rail click.
 */
export async function seedLastVibeChat(
  request: APIRequestContext,
  page: Page,
  label: string,
): Promise<VibeFixture> {
  const fixture = await createVibeFixture(request, label);
  await request.put(`${API}/api/v1/graph/agentic_process/${fixture.processId}`, { data: { process_type: 'chat' } });
  await request.post(`${API}/api/v1/graph/agentic_process/${fixture.processId}/activate`, { data: {} });
  await openVibe(page, fixture.processId);
  return fixture;
}
