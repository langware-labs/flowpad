/**
 * loadEmbeddedAgent Integration Test
 *
 * Verifies that:
 *   1. loadEmbeddedAgent bakes the agent spec into cli_config.agents_json (durable across requests)
 *   2. executeInstruction on a process with an embedded agent produces CHAT/TEXT FlowData output
 *
 * Uses new AgenticProcess({ workdir }).save([]) pattern — not computeNode.createProcess().
 *
 * Requires: running backend at localhost:9007 + Claude Code installed.
 * Timeout: 180s (real Claude subprocess).
 */

import { AgenticProcess, FlowData, FlowElementTypes, dataManager } from '@sdk';
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

describe('AgenticProcess loadEmbeddedAgent', () => {
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

  it('bakes agent into cli_config.agents_json (persisted)', async () => {
    const proc = await new AgenticProcess({ workdir }).save([]);

    await proc.loadEmbeddedAgent(agentFilePath);

    // Fetch fresh from server to confirm persistence
    const refreshed = await dataManager.getByTypeId<AgenticProcess>(proc.typeId);
    expect(refreshed, 'Process not found in dataManager after loadEmbeddedAgent').not.toBeNull();

    const agentsJson = (refreshed!.cli_config as any)?.agents_json as Record<string, unknown> | undefined;
    expect(agentsJson, 'cli_config.agents_json should be set after loadEmbeddedAgent').toBeDefined();
    expect(
      Object.keys(agentsJson!),
      'Expected "pong-agent" key in agents_json',
    ).toContain('pong-agent');

    console.log('[load_embedded_agent] agents_json:', JSON.stringify(agentsJson));
  }, TIMEOUT);

  it('executeInstruction produces CHAT/TEXT output', async () => {
    const proc = await new AgenticProcess({ workdir }).save([]);
    await proc.loadEmbeddedAgent(agentFilePath);
    await proc.watch();

    const collectPromise = collectOutput(proc, 160_000);
    await proc.executeInstruction('Say hello', { sync: false });

    const outputs = await collectPromise;

    const content = chatContent(outputs);
    console.log('[load_embedded_agent] element types:', outputs.map((o) => o.elementType).join(', '));
    console.log('[load_embedded_agent] chat content:', content);

    expect(outputs.length, 'Expected at least one FlowData item').toBeGreaterThan(0);
    expect(content.length, 'Expected non-empty CHAT/TEXT content').toBeGreaterThan(0);
  }, TIMEOUT);

  it('multi-turn: second executeInstruction on the same process produces output', async () => {
    const proc = await new AgenticProcess({ workdir }).save([]);
    await proc.loadEmbeddedAgent(agentFilePath);
    await proc.watch();

    // Turn 1 — collect output via output() generator
    const collectPromise1 = collectOutput(proc, 120_000);
    await proc.executeInstruction('Say hello', { sync: false });
    const turn1Outputs = await collectPromise1;

    const turn1Content = chatContent(turn1Outputs);
    console.log('[load_embedded_agent] turn1 content:', turn1Content);
    expect(turn1Content.length, 'Turn 1: expected non-empty chat content').toBeGreaterThan(0);

    // Turn 2 — capture stream position, executeInstruction resets _completed,
    // then output() yields all existing items + new ones.
    const afterTurn1Count = proc.flowDataStream.items.length;
    await proc.executeInstruction('Say goodbye', { sync: false });

    const allOutputs2: FlowData[] = [];
    for await (const item of proc.output()) {
      allOutputs2.push(item);
    }

    const turn2Items = allOutputs2.slice(afterTurn1Count);
    const turn2Content = chatContent(turn2Items);
    console.log('[load_embedded_agent] turn2 content:', turn2Content);
    expect(turn2Content.length, 'Turn 2: expected non-empty chat content').toBeGreaterThan(0);
  }, TIMEOUT);
});

