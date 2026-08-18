/**
 * loadEmbeddedSubagent SubAgent Integration Test
 *
 * Verifies that:
 *   1. loadEmbeddedSubagent records the SubAgent ENTITY ref (subagent-<uuid>) in
 *      embedded_asset_refs (durable across requests) and getAssets() reports
 *      it as an EMBEDDED descriptor
 *   2. executeInstruction on a process with an embedded SubAgent produces CHAT/TEXT FlowData output
 *
 * Uses new AgenticProcess({ workdir }).save([]) pattern — not computeNode.createProcess().
 * Output-stream assertions explicitly select headless mode; the entity default
 * is the interactive PTY transport, which does not expose the same FlowData stream.
 *
 * Requires: running backend at localhost:9007 + Claude Code installed.
 * Timeout: 180s (real Claude subprocess).
 */

import { AgenticProcess, FlowData, FlowElementTypes, TypeId, dataManager, isTypeId, isValidUUIDv4 } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TIMEOUT = 180_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function chatContent(outputs: FlowData[]): string {
  return outputs
    .filter((o) => o.elementType === FlowElementTypes.CHAT || o.elementType === FlowElementTypes.TEXT)
    .map((o) => String(o.data ?? ''))
    .join('');
}

function isClaudeUnavailable(content: string): boolean {
  return /(hit your limit|weekly limit|usage limit|rate limit|quota|too many requests|overloaded)/i.test(content);
}

async function collectOutput(proc: AgenticProcess, timeoutMs: number): Promise<FlowData[]> {
  const outputs: FlowData[] = [];
  const collect = (async () => {
    for await (const item of proc.output()) {
      outputs.push(item);
    }
  })();
  await Promise.race([
    collect,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`collectOutput timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
  return outputs;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('AgenticProcess loadEmbeddedSubagent', () => {
  let workdir: string;
  let agentFilePath: string;

  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);

    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'load-agent-test-'));

    // Create a minimal agent .md file — name derived from stem "pong-agent"
    agentFilePath = path.join(os.tmpdir(), 'pong-agent.md');
    fs.writeFileSync(
      agentFilePath,
      'When asked any question, respond with exactly one word: PONG\n',
    );
  });

  it('records the SubAgent entity ref in embedded_asset_refs (persisted)', async () => {
    const proc = await new AgenticProcess({ workdir }).save([]);

    await proc.loadEmbeddedSubagent(agentFilePath);

    // Fetch fresh from server to confirm persistence. Backend persists the
    // ref then pushes the updated entity via WebSocket; the cached entity
    // reflects it once that WS message lands. Under suite load that can
    // take a beat — poll briefly so the test isn't racing a fan-out we
    // can't observe directly.
    // Same gate the product code uses: well-formed typeid + uuid-form entity id.
    const isSubAgentUuidRef = (r: unknown) => {
      const s = String(r);
      if (!isTypeId(s)) return false;
      const tid = new TypeId(s);
      return tid.type === 'subagent' && isValidUUIDv4(tid.id);
    };
    const deadline = Date.now() + 5000;
    let refreshed: AgenticProcess | null = null;
    let refs: unknown[] = [];
    while (Date.now() < deadline) {
      refreshed = await dataManager.getByTypeId<AgenticProcess>(proc.typeId);
      refs = (refreshed?.embedded_asset_refs ?? []) as unknown[];
      if (refs.some(isSubAgentUuidRef)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(refreshed, 'Process not found in dataManager after loadEmbeddedSubagent').not.toBeNull();
    expect(
      refs.map(String),
      'Expected a subagent-<uuid> entry in embedded_asset_refs',
    ).toSatisfy((all: string[]) => all.some(isSubAgentUuidRef));

    // The unified descriptor view reports it as EMBEDDED with the same ref.
    const embeddedRef = refs.map(String).find(isSubAgentUuidRef)!;
    const descriptors = await proc.getAssets();
    const embedded = descriptors.filter((d) => d.typeid === embeddedRef);
    expect(embedded.length, 'getAssets should surface the embedded SubAgent').toBeGreaterThan(0);
    expect(embedded.every((d) => d.source === 'embedded')).toBe(true);

    console.log('[load_embedded_subagent] embedded_asset_refs:', refs.map(String).join(', '));
  }, TIMEOUT);

  it('executeInstruction produces CHAT/TEXT output', async (context: any) => {
    const proc = await new AgenticProcess({ workdir, pty_mode: false, visible: false }).save([]);
    await proc.loadEmbeddedSubagent(agentFilePath);
    await proc.watch();

    const collectPromise = collectOutput(proc, 160_000);
    await proc.executeInstruction('Say hello', { sync: false });

    const outputs = await collectPromise;

    const content = chatContent(outputs);
    console.log('[load_embedded_subagent] element types:', outputs.map((o) => o.elementType).join(', '));
    console.log('[load_embedded_subagent] chat content:', content);

    if (isClaudeUnavailable(content)) {
      context.skip(`Claude unavailable for loadEmbeddedSubagent executeInstruction test: ${content.slice(0, 240)}`);
    }
    expect(outputs.length, 'Expected at least one FlowData item').toBeGreaterThan(0);
    expect(content.length, 'Expected non-empty CHAT/TEXT content').toBeGreaterThan(0);

    // ── History restore: fetch a fresh process instance and verify
    //    loadHistory rebuilds the turn from the transcript on disk.
    //    ``dataManager`` returns the cached entity, which was populated by
    //    the live ``flow_data_msg`` stream above; invalidate first so the
    //    re-fetch yields a clean instance.
    expect(proc.session_id, 'session_id should be set after executeInstruction').toBeTruthy();

    dataManager.removeEntityFromCache(proc.typeId);
    const fresh = await dataManager.getByTypeId<AgenticProcess>(proc.typeId);
    expect(fresh, 'fresh process fetch should resolve').not.toBeNull();
    expect(
      fresh!.flowDataStream.items.length,
      'fresh process stream should start empty before loadHistory',
    ).toBe(0);

    await fresh!.loadHistory({ force: true });
    const restored = fresh!.flowDataStream.items;
    console.log(
      '[load_embedded_subagent] restored element types:',
      restored.map((o) => o.elementType).join(', '),
    );
    expect(restored.length, 'loadHistory should populate the stream').toBeGreaterThan(0);

    const userMessage = restored.find(
      (r) => r.elementType === FlowElementTypes.USER_MESSAGE
        || (r.attributes && r.attributes.role === 'user'),
    );
    expect(userMessage, 'restored history should contain a user message').toBeDefined();
    expect(
      String(userMessage!.data ?? userMessage!.content ?? ''),
      'user message content should be "Say hello"',
    ).toContain('Say hello');

    const assistantContent = chatContent(
      restored.filter((r) => r.attributes?.role === 'assistant'),
    );
    expect(
      assistantContent.length,
      'restored history should contain assistant content',
    ).toBeGreaterThan(0);
  }, TIMEOUT);

  it('multi-turn: second executeInstruction on the same process produces output', async (context: any) => {
    const proc = await new AgenticProcess({ workdir, pty_mode: false, visible: false }).save([]);
    await proc.loadEmbeddedSubagent(agentFilePath);
    await proc.watch();

    // Turn 1 — collect output via output() generator
    const collectPromise1 = collectOutput(proc, 120_000);
    await proc.executeInstruction('Say hello', { sync: false });
    const turn1Outputs = await collectPromise1;

    const turn1Content = chatContent(turn1Outputs);
    console.log('[load_embedded_subagent] turn1 content:', turn1Content);
    if (isClaudeUnavailable(turn1Content)) {
      context.skip(`Claude unavailable for loadEmbeddedSubagent multi-turn test: ${turn1Content.slice(0, 240)}`);
    }
    expect(turn1Content.length, 'Turn 1: expected non-empty chat content').toBeGreaterThan(0);

    // Turn 2 — workerStatus is COMPLETE from Turn 1, so output() would
    // observe a terminal state and exit immediately. Subscribe to the
    // 'complete' event BEFORE triggering, then slice the stream after
    // the next completion edge lands.
    const afterTurn1Count = proc.flowDataStream.items.length;
    const turn2Done = new Promise<void>((resolve) => {
      const unsub = proc.on('complete', () => {
        unsub();
        resolve();
      });
    });
    await proc.executeInstruction('Say goodbye', { sync: false });
    await Promise.race([
      turn2Done,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Turn 2 timed out after 12s')), 12_000),
      ),
    ]);
    const turn2Items = proc.flowDataStream.items.slice(afterTurn1Count);
    const turn2Content = chatContent(turn2Items);
    console.log('[load_embedded_subagent] turn2 content:', turn2Content);
    if (isClaudeUnavailable(turn2Content)) {
      context.skip(`Claude unavailable for loadEmbeddedSubagent multi-turn test: ${turn2Content.slice(0, 240)}`);
    }
    expect(turn2Content.length, 'Turn 2: expected non-empty chat content').toBeGreaterThan(0);
  }, TIMEOUT);
});
