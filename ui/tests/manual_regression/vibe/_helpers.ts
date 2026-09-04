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
  await page.addInitScript(() => {
    try {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    } catch {
      /* sandboxed frame (mcp-ui): no storage, and nothing there needs the flag */
    }
  });
  await page.goto(`/dock/shell/agentic_process-${processId}?viewMode=vibe`);
  // Deliberately NOT asserting the URL stayed on the process dock. The display is
  // an address now, so a cold landing on a process that already has a pin is
  // redirected to that pin (`restoreDisplayRedirect`) — which is the point. What
  // must hold either way is that the workspace mounted.
  await expect(page.locator('[data-testid="entity-execution-new"]:visible')).toBeVisible();
  await expect(page.getByTestId('workspace-display-tab')).toBeVisible();
}

/** The process's own dock URL — where the square Display header navigates. */
export function processUrlRe(processId: string): RegExp {
  return new RegExp(`/dock/shell/agentic_process-${processId}\\?.*viewMode=vibe`);
}

/** The address a shown target takes inside a workspace. */
export function displayUrlRe(projectId: string, processId: string, tail = ''): RegExp {
  return new RegExp(
    `/dock/project/${projectId}/process/agentic_process-${processId}/display/${tail}`,
  );
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

/**
 * Register a web app the way an agent does: an Artifact plus a local Deployment on
 * `port`, then a `kind: "app"` show.
 *
 * The distinction this exercises is the point of `ViewType.APP`: `showPort` pins a
 * bare port, which is a different (and weaker) address — the artifact survives a
 * restart, a rebuild, and a switch from a dev server to built output; the port does
 * not. Returns the created artifact id.
 */
export async function registerWebappArtifact(
  request: APIRequestContext,
  processId: string,
  artifactPath: string,
  port: number,
  name: string,
): Promise<string> {
  const data = await successfulData(
    await request.post(`${API}/api/v1/graph/agentic_process/${processId}/register-webapp-artifact`, {
      data: { path: artifactPath, port, name, show: true },
    }),
  );
  return String((data.artifact as { id: string }).id);
}

/** `flow show app <artifact-id>` over the wire. */
export async function showApp(
  request: APIRequestContext,
  processId: string,
  artifactId: string,
): Promise<Record<string, unknown>> {
  return successfulData(
    await request.post(`${API}/api/v1/graph/agentic_process/${processId}/show`, {
      data: { artifact_id: artifactId },
    }),
  );
}

/**
 * The tab-identity hash of a workspace's ACTIVE DISPLAY.
 *
 * Mirrors `ACTIVE_DISPLAY_HASH_NS` (`ui/src/navigation/DockPointer.ts`). Spelled
 * once here because the namespace's whole design note is that it must not be
 * respelled — and because a test filtering on the bare namespace would also count
 * rows left by other fixtures on a shared instance.
 */
export function activeDisplayHash(processId: string): string {
  return `workspaceActive|agentic_process-${processId}`;
}
