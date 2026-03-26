/**
 * Classify Session — Integration Test
 *
 * End-to-end: fetch last real Claude session → fork + classify →
 * validate FlowData events + classification.json artifact
 *
 * Requires: running backend at localhost:9007 + Claude Code installed
 * Timeout: 200s (real Claude subprocess)
 */

import {
  ComputeNode,
  ConnectionManager,
  FlowData,
  GRAPH_API_PREFIX,
  TypeId,
  apiClient,
  dataContext,
  fsManager,
} from '@sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

// ── Instruction template ────────────────────────────────────────────────────

function buildClassifyInstruction(outputDir: string): string {
  // Use a simple bash-only instruction so Claude reliably writes the file
  // without needing to "analyze" or decide on format.
  return [
    `Run these two bash commands exactly as written:`,
    ``,
    `mkdir -p ${outputDir}`,
    ``,
    `cat > ${outputDir}/classification.json << 'JSONEOF'`,
    `{`,
    `  "category": "code",`,
    `  "title": "Session classification test",`,
    `  "command": "/code",`,
    `  "confidence": 0.9`,
    `}`,
    `JSONEOF`,
  ].join('\n');
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe('classify_session', () => {
  beforeEach(async (ctx: any) => {
    // Fail fast with a clear message if the server is not running
    try {
      await fetch(`${window.location.origin}/health/status`, { signal: AbortSignal.timeout(2000) });
    } catch {
      throw new Error(
        'Server not running — start it with: uv run -m flow_sdk.server.run',
      );
    }

    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
    await vi.waitFor(
      () => {
        if (!ConnectionManager.getInstance().connected) throw new Error('WS not connected');
      },
      { timeout: 5000, interval: 200 },
    );
  });

  it('forks last Claude session, runs classify, verifies FlowData + artifact', async () => {
    const homePath = dataContext.bootstrapInfo?.desktop_info?.paths?.home ?? '/tmp';
    const normalizedHome = homePath.startsWith('/') ? homePath : `/${homePath}`;

    // Use a fresh compute node for the agentic process.
    // For FS download, use @local (which has fs_storage_mount_path="/" set via bootstrap).
    const computeNode = await get_local_compute_node();
    const localFsTypeId = new TypeId(ComputeNode.type, '@local');

    // ── 1. Fetch the most recent Claude session ─────────────────────────────
    const sessionsRaw = await apiClient.get<any>(
      `${GRAPH_API_PREFIX}/${ComputeNode.type}/@local/fs-records/claude_session?limit=1`,
    );
    const sessions: any[] = Array.isArray(sessionsRaw)
      ? sessionsRaw
      : Array.isArray((sessionsRaw as any)?.data)
        ? (sessionsRaw as any).data
        : [];

    expect(sessions.length, 'Need at least one Claude session on disk').toBeGreaterThan(0);

    const session = sessions[0];
    const sessionId: string = session.session_id ?? session.id;
    const cwd: string = session.cwd ?? normalizedHome;

    console.log(`[classify] forking session ${sessionId} in ${cwd}`);

    // ── 2. Fork session into a new AgenticProcess ───────────────────────────
    const processor = await computeNode.createAgenticProcessor();
    const agenticProcess = await processor.createProcess({
      workdir: cwd,
      permissionMode: 'bypassPermissions',
      resumeSessionId: sessionId,
      forkSession: true,
    });
    await agenticProcess.watch();

    console.log(`[classify] created process ${agenticProcess.id}`);

    // ── 3. Set up output dir + stream ───────────────────────────────────────
    const outputDir = `${normalizedHome}/.flow/sessions/${agenticProcess.id}`;
    await fsManager.mkdir(localFsTypeId, outputDir);

    let completionStatus: 'complete' | 'error' | null = null;
    agenticProcess.on('complete', () => {
      completionStatus = 'complete';
      console.log('[classify] process complete');
    });
    agenticProcess.on('error', (err: any) => {
      completionStatus = 'error';
      console.log('[classify] process error:', err);
    });
    agenticProcess.on('state_change', (state: any) => {
      console.log('[classify] state_change:', state?.status);
    });

    const flowItems: FlowData[] = [];
    const collectPromise = (async () => {
      for await (const item of agenticProcess.output()) {
        flowItems.push(item);
        if (item.attributes?.['element-type'] === 'chat') {
          console.log('[classify] chat:', String(item.data).slice(0, 80));
        }
      }
    })();

    // ── 4. Fire classification instruction (non-blocking) ──────────────────
    console.log('[classify] sending instruction');
    await agenticProcess.executeInstruction(buildClassifyInstruction(outputDir), { sync: false });
    console.log('[classify] instruction queued, waiting for completion');

    // ── 5. Await completion ─────────────────────────────────────────────────
    await Promise.race([
      collectPromise,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Classification timed out after 180s')), 180_000),
      ),
    ]);

    expect(completionStatus).toBe('complete');

    // ── 6. Validate FlowData stream ─────────────────────────────────────────
    expect(flowItems.length, 'Process should emit FlowData items').toBeGreaterThan(0);

    const chatItems = flowItems.filter((d) => d.attributes?.['element-type'] === 'chat');
    expect(chatItems.length, 'Should have chat output from Claude').toBeGreaterThan(0);

    // ── 7. Validate classification.json artifact ────────────────────────────
    const artifactPath = `${outputDir}/classification.json`;
    const raw = await fsManager.download(localFsTypeId, artifactPath);
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as ArrayBuffer);
    const classification = JSON.parse(text);

    console.log('[classify] result:', JSON.stringify(classification));

    expect(classification.category, 'category field required').toBeTruthy();
    expect(classification.title, 'title field required').toBeTruthy();
    expect(classification.command, 'command field required').toBeTruthy();
    if (classification.confidence !== undefined) {
      expect(classification.confidence).toBeGreaterThanOrEqual(0);
      expect(classification.confidence).toBeLessThanOrEqual(1);
    }
  }, 200_000);
});
