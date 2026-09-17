/**
 * An agent session must answer AS THE AGENT, not as vibe.
 *
 * Real path, both halves the product runs when a user opens an agent
 * (the "Use" button and the project auto-launch redirect share it):
 *
 *   agent.use(projectId)             POST /agent/<id>/use → Deployment.use()
 *                                    → context_data.instructions = system_prompt
 *   prepareAgentSession(processId)   embedVibeSubagent(proc, { asPersona: false })
 *                                    → vibe embedded as a layer, no process_persona_path
 *   first turn                       CLAUDE.md = agent prompt + persona block
 *
 * Reported on an e2b box: a mail-assistant agent auto-launched and replied as
 * vibe, because the rendered CLAUDE.md ends in "# You are the 'vibe' agent …
 * Adopt the persona … for every reply", which overrides the agent's own prompt.
 *
 * Asserts on the CLAUDE.md the worker is actually launched with — the file the
 * backend materializes on the first turn — not on the persona field alone.
 *
 * Requires: a live backend (FLOW_INSTANCE=<name>) + Claude Code installed.
 */

import { Agent, AgenticProcess, Project } from '@sdk';
import apiClient from '@sdk/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { prepareAgentSession } from '@src/components/agents/use-agent-launcher';
import { purgeTracked, trackForCleanup, trackTypeId } from '../_cleanup';
import { apiTestSetup, fetchRow, getTestSignupInfo } from '../utils/test-utils';

const TIMEOUT = 120_000;
const AGENT_MARKER = 'You are MAILBOT_PROBE, an email assistant.';

async function waitForFile(file: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf-8');
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`${file} was never written`);
}

// flowpad:capsule tag
// version: 1
// data:
//   tags:
//     breadcrumb.test.agent_session_persona.rules: FAILING? an agent session must keep
//       the AGENT as its identity - prepareAgentSession embeds vibe with asPersona:false.
//       Read this tag's rules before touching embedVibeSubagent or set_ap_persona.
// flowpad:endcapsule tag
describe('agent session persona', () => {
  let project: Project;
  let agent: Agent;

  beforeAll(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.name);
    const mount = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-persona-'));
    project = trackForCleanup(
      await new Project({ name: `agent-persona-${Date.now()}`, fs_storage_mount_path: mount }).save([]),
    );
    const created = await apiClient.post<{ id: string }>(`/api/v1/graph/project/${project.id}/agent`, {
      type: 'agent',
      name: `Mail Probe ${Date.now()}`,
      system_prompt: AGENT_MARKER,
    });
    trackTypeId('agent', created.id);
    agent = (await Agent.getById<Agent>(created.id))!;
  }, TIMEOUT);

  afterAll(async () => {
    await purgeTracked();
  });

  it(
    'a used agent is launched with its own prompt as the identity, not the vibe persona',
    async () => {
      const { process_id } = await agent.use(project.id);
      trackTypeId('agentic_process', process_id);

      const proc = await prepareAgentSession(process_id);
      expect(proc, 'prepareAgentSession must resolve the used process').not.toBeNull();

      // The first turn is what materializes CLAUDE.md for the worker.
      const row = await fetchRow('agentic_process', process_id);
      const claudeMd = path.join(row.exe_folder.path, 'assets', 'CLAUDE.md');
      await proc!.executeInstruction('Reply with the single word: ok', { sync: false });
      const rendered = await waitForFile(claudeMd, 60_000);
      await proc!.cancelPrompt().catch(() => {});

      // The agent's prompt reached the worker ...
      expect(rendered).toContain(AGENT_MARKER);
      // ... and nothing after it claims a different identity.
      expect(rendered).not.toContain("# You are the 'vibe' agent");
    },
    TIMEOUT,
  );
});
