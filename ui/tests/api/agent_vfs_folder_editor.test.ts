/**
 * Regression: opening an agent by its FOLDER vfs URL
 *   /dock/assets/editor/agent/vfs/compute_node-@local/<project>/agentic-assets/agent/<name>
 * rendered "Request failed with status code 404".
 *
 * The router handed the pointer's path to AgentProfileEditor as the agent's main
 * file. That held while an agent was a single `agent.md`; once agents became
 * folders (`agent.json` + `system_prompt.md`), the editor asked
 * `GET …/fs/document/<folder>` and the backend answered "Document not found".
 *
 * Real path, real registry, real backend — the agent's layout comes from the
 * bootstrap TypeInfo, so a future layout change is caught here, not hard-coded.
 */
import { Agent, dataManager, Project } from '@sdk';
import apiClient from '@sdk/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { vfsEditorTarget, vfsOccurrenceRef } from '@src/components/assets/editor/AssetEditorRouter';
import { AssetDocPointer } from '@src/navigation/AssetDocPointer';
import { AssetEditor } from '@src/navigation/asset-doc-types';
import { purgeTracked, trackForCleanup, trackTypeId } from '../_cleanup';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const PROMPT = 'reply with "hello world"';

describe('agent editor on a folder vfs url', () => {
  let agent: Agent;

  beforeAll(async (suite: { name: string }) => {
    await apiTestSetup(getTestSignupInfo(), suite.name);
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-vfs-folder-'));
    const project = trackForCleanup(
      await new Project({ name: `agent-vfs-folder-${Date.now()}`, fs_storage_mount_path: mount }).save([]),
    );
    const created = await apiClient.post<{ id: string }>(`/api/v1/graph/project/${project.id}/agent`, {
      type: 'agent',
      name: `agent-vfs-${Date.now()}`,
      system_prompt: PROMPT,
    });
    trackTypeId('agent', created.id);
    agent = (await Agent.getById<Agent>(created.id))!;
  });

  afterAll(async () => {
    await purgeTracked();
  });

  it('reads the agent document, not the folder', async () => {
    const ptr = AssetDocPointer.forVfs(AssetEditor.AGENT, agent.bundleDirectory!);
    const { mainFileRef } = vfsEditorTarget(vfsOccurrenceRef(ptr)!, 'agent', dataManager.getTypeInfo('agent')?.shape);

    const document = await mainFileRef.readDocument();

    expect(document.body).toContain(PROMPT);
  });
});
