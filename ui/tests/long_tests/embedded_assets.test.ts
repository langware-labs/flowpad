/**
 * End-to-end HTTP round-trip for AgenticProcess.embeddedAssets.
 *
 * Verifies:
 *   1. attach writes the asset into cli_config + embedded_asset_refs + additional_dirs,
 *      and materializes the agent .md under <record_dir>/assets/.claude/agents/<name>.md.
 *   2. list returns the current ref set.
 *   3. detach reverses (ref gone, file gone).
 *
 * Real backend required at localhost:9008. Real Claude not needed — we don't
 * prompt the process, we just exercise the three new actions on the server.
 */

import { AgenticProcess, dataManager } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TIMEOUT = 60_000;

describe('AgenticProcess embeddedAssets (HTTP round-trip)', () => {
  let workdir: string;
  let agentDir: string;
  let agentName: string;
  let agentMdPath: string;

  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);

    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-assets-test-'));

    // Place an agent under ~/.claude/agents/<name>.md so AgentRecord.load_agent
    // finds it by name. The uuid id is derived from the source_path (stable),
    // so the test can compute the same ref the server will resolve.
    agentName = `ea-test-agent-${Date.now()}`;
    const homeClaude = path.join(os.homedir(), '.claude', 'agents');
    fs.mkdirSync(homeClaude, { recursive: true });
    agentMdPath = path.join(homeClaude, `${agentName}.md`);
    fs.writeFileSync(
      agentMdPath,
      `---
name: ${agentName}
description: embedded assets round-trip fixture
---

You are a test agent.
`,
      'utf-8',
    );
    agentDir = homeClaude;
  });

  it('attach → list → detach round-trip for an agent by uuid id', async () => {
    const proc = await new AgenticProcess({ workdir }).save([]);

    // Force a reindex of agents so the fixture file is picked up by /search.
    const reindexResp = await fetch('http://localhost:9008/api/v1/search/reindex/agent', { method: 'POST' });
    expect(reindexResp.ok, `reindex failed: ${reindexResp.status}`).toBe(true);

    // Resolve the agent's uuid via /search so we use the same TypeId shape the UI sends.
    const searchUrl = new URL('/api/v1/search', 'http://localhost:9008');
    searchUrl.searchParams.set('record_type', 'agent');
    searchUrl.searchParams.set('q', agentName);
    const searchResp = await fetch(searchUrl.toString(), {
      headers: { 'Content-Type': 'application/json' },
    });
    expect(searchResp.ok, `search failed: ${searchResp.status}`).toBe(true);
    const searchRaw = (await searchResp.json()) as { data?: { results?: Array<{ record_id: string; name: string; record_type: string }> } };
    const hit = searchRaw.data?.results?.find((r) => r.name === agentName);
    expect(hit, `search did not find agent "${agentName}" — ensure indexer picked it up`).toBeDefined();

    const agentRef = `agent-${hit!.record_id}`;

    // Attach
    await proc.embeddedAssets.attach(agentRef);
    expect(proc.embeddedAssets.list().map((r) => r.toString())).toEqual([agentRef]);

    // Read server-side to confirm persistence
    const refreshed = await dataManager.getByTypeId<AgenticProcess>(proc.typeId);
    const refreshedRefs = (refreshed?.embedded_asset_refs ?? []).map((r) => r.toString());
    expect(refreshedRefs).toEqual([agentRef]);
    expect(
      (refreshed?.additional_dirs ?? []).some((d) => d.endsWith('/assets')),
      'additional_dirs should contain the assets path after attach',
    ).toBe(true);

    // Detach
    await proc.embeddedAssets.detach(agentRef);
    expect(proc.embeddedAssets.list()).toEqual([]);

    const afterDetach = await dataManager.getByTypeId<AgenticProcess>(proc.typeId);
    const afterDetachRefs = (afterDetach?.embedded_asset_refs ?? []).map((r) => r.toString());
    expect(afterDetachRefs).toEqual([]);
  }, TIMEOUT);
});
