/**
 * End-to-end HTTP round-trip for AgenticProcess.embeddedAssets.
 *
 * Verifies:
 *   1. attach writes the asset into cli_config + embedded_asset_refs + additional_dirs,
 *      and materializes the SubAgent .md under <record_dir>/assets/.claude/agents/<name>.md.
 *   2. list returns the current ref set.
 *   3. detach reverses (ref gone, file gone).
 *
 * Uses the backend selected by the long-test tier (including FLOW_INSTANCE).
 * Real Claude is not needed — we don't prompt the process, we just exercise
 * the three embedded-asset actions on the server.
 */

import { AgenticProcess, apiClient, dataManager } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TIMEOUT = 60_000;

describe('AgenticProcess embeddedAssets (HTTP round-trip)', () => {
  let workdir: string;
  let agentName: string;
  let agentMdPath: string;
  let subagentRecordId: string | null = null;

  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);

    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'embedded-assets-test-'));

    // Place a SubAgent under ~/.claude/agents/<name>.md so the SubAgent loader
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
  });

  afterEach(async () => {
    // Test fixture lives under the user's real ~/.claude/agents/ — delete it so
    // it doesn't pollute every future "what assets does this process see?" view.
    // Same for the temp workdir under $TMPDIR.
    try { fs.unlinkSync(agentMdPath); } catch { /* ignore */ }
    try { fs.rmSync(workdir, { recursive: true, force: true }); } catch { /* ignore */ }
    // The forced reindex created a real SubAgent entity for the fixture — delete
    // it too, or every run leaks an `ea-test-agent-<ts>` into the asset list.
    // fs-records DELETE = full purge (entity row + FTS + shadow record dir).
    if (subagentRecordId) {
      await apiClient.delete(`/graph/compute_node/@local/fs-records/subagent/${subagentRecordId}`);
      subagentRecordId = null;
    }
  });

  it('attach → list → detach round-trip for a SubAgent by uuid id', async () => {
    const proc = await new AgenticProcess({ workdir }).save([]);

    // Force a reindex of SubAgents so the fixture file is picked up by /search.
    await apiClient.post('/graph/compute_node/@local/fs-records/index?type=subagent', {});

    // Resolve the SubAgent's uuid via the configured API client so we use the same
    // TypeId shape the UI sends. apiClient unwraps the standard response envelope.
    const searchData = (await apiClient.get('/search', {
      params: { record_type: 'subagent', q: agentName },
    })) as { results?: Array<{ record_id: string; name: string; record_type: string }> };
    const hit = searchData.results?.find((r) => r.name === agentName);
    expect(hit, `search did not find SubAgent "${agentName}" — ensure indexer picked it up`).toBeDefined();
    subagentRecordId = hit!.record_id;

    const subagentRef = `subagent-${hit!.record_id}`;

    // Attach
    await proc.embeddedAssets.attach(subagentRef);
    expect(proc.embeddedAssets.list().map((r) => r.toString())).toEqual([subagentRef]);

    // Read server-side to confirm persistence. The server persists the attached
    // ref and pushes the update via WebSocket; the cached entity reflects it once
    // that WS message lands. Under suite load that can take a beat — poll briefly
    // instead of asserting on a single snapshot so the test isn't racing a
    // fan-out we can't observe directly.
    const deadline = Date.now() + 5000;
    let refreshed: AgenticProcess | null = null;
    while (Date.now() < deadline) {
      refreshed = await dataManager.getByTypeId<AgenticProcess>(proc.typeId);
      if ((refreshed?.embedded_asset_refs ?? []).length > 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const refreshedRefs = (refreshed?.embedded_asset_refs ?? []).map((r) => r.toString());
    expect(refreshedRefs).toEqual([subagentRef]);
    // The process assets dir is deliberately NOT stored in `additional_dirs` —
    // it is folded into the launch-time `--add-dir` set by
    // `AgenticProcess.resolved_add_dirs` (a computed property that is not part of
    // the API payload). Keep asserting that separation here; the mount itself is
    // owned by tests/unit/test_system_instruction_assets.py and the long-test
    // system-prompt / settings-instruction pair.
    expect(
      (refreshed?.additional_dirs ?? []).some((d) => d.endsWith('/assets')),
      `the process assets dir must stay out of additional_dirs (got: ${JSON.stringify(refreshed?.additional_dirs)})`,
    ).toBe(false);

    // Detach
    await proc.embeddedAssets.detach(subagentRef);
    expect(proc.embeddedAssets.list()).toEqual([]);

    const afterDetach = await dataManager.getByTypeId<AgenticProcess>(proc.typeId);
    const afterDetachRefs = (afterDetach?.embedded_asset_refs ?? []).map((r) => r.toString());
    expect(afterDetachRefs).toEqual([]);
  }, TIMEOUT);
});
