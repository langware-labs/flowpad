/**
 * Browser/API regression guards for the independently reproduced Vibe bugs.
 * Source: vibe_bugs.md
 *
 * Model-instruction quality is still exercised by the live-Claude matrix. This
 * file pins the deterministic product contracts each historical failure crossed:
 * project binding, distinct skill identity, file-valued SKILL.md refs, ordered
 * queue persistence, and URL-first rebinding after New.
 */
import { expect, test } from '@playwright/test';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  API,
  createVibeFixture,
  destroyVibeFixture,
  openVibe,
} from './_helpers';

interface QueueEntry {
  id: string;
  prompt: string;
  source: string;
}

test.describe('Vibe Workspace confirmed-bug regressions', () => {
  test('VIBE-001/VIBE-002/VIBE-003: workspace and process stay bound to the selected project', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-project-binding');
    try {
      await openVibe(page, fixture.processId);

      const browserProject = await page.evaluate(() => {
        const project = (window as Window & {
          dataContext?: { project?: { id?: string; fs_storage_mount_path?: string } };
        }).dataContext?.project;
        return {
          id: project?.id ?? null,
          mount: project?.fs_storage_mount_path ?? null,
        };
      });
      expect(browserProject.id).toBe(fixture.projectId);
      expect(realpathSync(String(browserProject.mount))).toBe(realpathSync(fixture.root));

      const processResponse = await request.get(
        `${API}/api/v1/graph/agentic_process/${fixture.processId}`,
      );
      expect(processResponse.status()).toBe(200);
      const process = (await processResponse.json()).data;
      expect(process.project_id).toBe(fixture.projectId);
      expect(realpathSync(process.workdir)).toBe(realpathSync(fixture.root));
      await expect(page.getByTestId('display-empty-state')).toBeVisible();
    } finally {
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VIBE-004/VIBE-007: distinct skill folders keep distinct ids and file-valued refs open once', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-skill-identity');
    try {
      const createSkill = async (name: string) => {
        const response = await request.post(
          `${API}/api/v1/graph/project/${fixture.projectId}/skill`,
          { data: { name } },
        );
        expect(response.status()).toBe(200);
        return (await response.json()).data as { id: string; asset_ref: string };
      };
      const first = await createSkill('vibe-qa-first');
      const second = await createSkill('vibe-qa-second');
      expect(first.id).not.toBe(second.id);
      expect(path.resolve(first.asset_ref)).not.toBe(path.resolve(second.asset_ref));

      const firstDir = first.asset_ref.replace(/\/SKILL\.md$/, '');
      const firstFile = path.join(firstDir, 'SKILL.md');
      mkdirSync(firstDir, { recursive: true });
      writeFileSync(
        firstFile,
        '---\nname: vibe-qa-first\ndescription: File ref regression\n---\n\nVIBE_FILE_REF_READY\n',
        'utf8',
      );
      const patch = await request.patch(`${API}/api/v1/graph/skill/${first.id}`, {
        data: { asset_ref: firstFile },
      });
      expect(patch.status()).toBe(200);

      await page.addInitScript(() => localStorage.setItem('llm-setup-modal-seen', 'true'));
      await page.goto(`/dock/assets/editor/skill/typeid/skill-${first.id}`);
      await expect(page.getByText('VIBE_FILE_REF_READY')).toBeVisible();
      await expect(page.getByText(/File is missing/i)).toHaveCount(0);
      await page.reload();
      await expect(page.getByText('VIBE_FILE_REF_READY')).toBeVisible();
      await expect(page.getByText(/SKILL\.md\/SKILL\.md/)).toHaveCount(0);

      const firstAfter = (await (
        await request.get(`${API}/api/v1/graph/skill/${first.id}`)
      ).json()).data;
      const secondAfter = (await (
        await request.get(`${API}/api/v1/graph/skill/${second.id}`)
      ).json()).data;
      expect(firstAfter.id).toBe(first.id);
      expect(secondAfter.id).toBe(second.id);
      expect(firstAfter.asset_ref).not.toBe(secondAfter.asset_ref);
    } finally {
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VIBE-005: three disabled-queue entries persist once in exact UI order', async ({ request }) => {
    const fixture = await createVibeFixture(request, 'vibe-queue');
    try {
      const disabled = await request.post(
        `${API}/api/v1/graph/agentic_process/${fixture.processId}/set-queue-enabled`,
        { data: { enabled: false } },
      );
      expect(disabled.status()).toBe(200);

      const prompts = [
        'Open the skill you just created.',
        'Run it once.',
        'Open the generated report.',
      ];
      for (const prompt of prompts) {
        const response = await request.post(
          `${API}/api/v1/graph/agentic_process/${fixture.processId}/enqueue`,
          { data: { prompt, source: 'ui' } },
        );
        expect(response.status()).toBe(200);
      }

      const process = (await (
        await request.get(`${API}/api/v1/graph/agentic_process/${fixture.processId}`)
      ).json()).data;
      expect(process.queue.enabled).toBe(false);
      expect(process.queue.entries.map((entry: QueueEntry) => entry.prompt)).toEqual(prompts);
      expect(process.queue.entries.map((entry: QueueEntry) => entry.source)).toEqual([
        'ui',
        'ui',
        'ui',
      ]);
      expect(new Set(process.queue.entries.map((entry: QueueEntry) => entry.id)).size).toBe(3);
    } finally {
      await destroyVibeFixture(request, fixture);
    }
  });

  test('VIBE-006: New rebinds the canonical URL to P1 before its live turn completes', async ({
    page,
    request,
  }) => {
    const fixture = await createVibeFixture(request, 'vibe-new-rebind');
    let newProcessId: string | null = null;
    try {
      await openVibe(page, fixture.processId);
      await page.locator('[data-testid="entity-execution-new"]:visible').click();
      const input = page.locator('[data-testid="entity-execution-input"]:visible');
      await expect(input).toBeVisible();
      await input.fill('Reply with VIBE_NEW_REBOUND and do not create files.');
      await input.press('Enter');

      await expect(page).toHaveURL((url) => {
        const processId =
          url.pathname.match(/\/dock\/shell\/agentic_process-([0-9a-f-]+)/)?.[1] ?? null;
        return (
          processId !== null &&
          processId !== fixture.processId &&
          url.searchParams.get('viewMode') === 'vibe'
        );
      });
      newProcessId =
        page.url().match(/\/dock\/shell\/agentic_process-([0-9a-f-]+)/)?.[1] ?? null;
      expect(newProcessId).toBeTruthy();
      expect(newProcessId).not.toBe(fixture.processId);

      const created = (await (
        await request.get(`${API}/api/v1/graph/agentic_process/${newProcessId}`)
      ).json()).data;
      expect(created.project_id).toBe(fixture.projectId);
      expect(realpathSync(created.workdir)).toBe(realpathSync(fixture.root));
      expect(created.embedded_asset_refs.length).toBeGreaterThan(0);

      await page.reload();
      await expect(page).toHaveURL(
        new RegExp(`/dock/shell/agentic_process-${newProcessId}\\?.*viewMode=vibe`),
      );
    } finally {
      if (newProcessId) {
        await request
          .delete(`${API}/api/v1/graph/agentic_process/${newProcessId}`)
          .catch(() => undefined);
      }
      await destroyVibeFixture(request, fixture);
    }
  });
});
