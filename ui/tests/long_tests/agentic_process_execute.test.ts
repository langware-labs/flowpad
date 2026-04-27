/**
 * AgenticProcess executeInstruction Integration Tests
 *
 * Migrated from agentic_process_stress.test.ts Suites 1 & 2 (PTY-based, were skipped).
 * Uses the new headless model: new AgenticProcess({ workdir }).save([]) + executeInstruction + output().
 *
 * Suite 1: Basic executeInstruction — creates a fresh process, sends one instruction,
 *   asserts CHAT output appears and contains the expected word.
 *
 * Suite 2: Multi-turn — same process, two sequential executeInstruction calls,
 *   both produce CHAT output.
 *
 * Requires: running backend at localhost:9007 + Claude Code installed.
 * Timeout: 240s (real Claude subprocess).
 */

import { AgenticProcess, FlowData, FlowElementTypes } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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
  await Promise.race([
    (async () => {
      for await (const item of proc.output()) {
        outputs.push(item);
      }
    })(),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`collectOutput timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
  return outputs;
}

// ---------------------------------------------------------------------------
// Suite 1 — Basic executeInstruction (replaces old PTY Suite 1)
// ---------------------------------------------------------------------------

describe('AgenticProcess.executeInstruction — single turn', () => {
  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  it('executeInstruction("Say hola") → chat output contains "hola"', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-execute-test-'));
    const proc = await new AgenticProcess({ workdir }).save([]);
    await proc.watch();

    const collectPromise = collectOutput(proc, 150_000);
    await proc.executeInstruction('Say hola', { sync: false });

    const outputs = await collectPromise;
    const content = chatContent(outputs);

    console.log('[agentic_process_execute] element types:', outputs.map((o) => o.elementType).join(', '));
    console.log('[agentic_process_execute] chat content:', content);

    expect(outputs.length, 'Expected at least one FlowData item').toBeGreaterThan(0);
    expect(content.toLowerCase(), 'Expected "hola" in chat output').toContain('hola');
  }, 200_000);
});

// ---------------------------------------------------------------------------
// Suite 2 — Multi-turn (replaces old PTY Suite 2: restore-from-DB test)
// ---------------------------------------------------------------------------

describe('AgenticProcess.executeInstruction — multi-turn', () => {
  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  it('two sequential executeInstruction calls both produce "hola"', async () => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-multiturn-test-'));
    const proc = await new AgenticProcess({ workdir }).save([]);
    await proc.watch();

    // Turn 1 — collect output via output() generator
    const collectPromise1 = collectOutput(proc, 120_000);
    await proc.executeInstruction('Say hola', { sync: false });
    const turn1Outputs = await collectPromise1;

    const turn1Content = chatContent(turn1Outputs);
    console.log('[agentic_process_execute] turn1 content:', turn1Content);
    expect(turn1Content.toLowerCase(), 'Turn 1 should contain "hola"').toContain('hola');

    // Turn 2 — capture stream position, then executeInstruction resets _completed,
    // then output() yields all existing items + new ones.
    const afterTurn1Count = proc.flowDataStream.items.length;
    await proc.executeInstruction('Say hola again', { sync: false });

    const allOutputs2: FlowData[] = [];
    for await (const item of proc.output()) {
      allOutputs2.push(item);
    }

    const turn2Items = allOutputs2.slice(afterTurn1Count);
    const turn2Content = chatContent(turn2Items);
    console.log('[agentic_process_execute] turn2 content:', turn2Content);
    expect(turn2Content.toLowerCase(), 'Turn 2 should contain "hola"').toContain('hola');
  }, 240_000);
});
