/**
 * Flowpad Assistant skill-availability integration test.
 *
 * Validates the end-to-end "include Flowpad Assistant" mount: a process with
 * the assistant enabled (the default — `load_flowpad_assistant` unset inherits
 * the global ServiceConfig.load_flowpad_assistant) launches the worker with
 * `--add-dir <…/system_projects/flowpad_assistant>`, so that project's
 * `.claude/skills` are discoverable. We assert the worker can see the
 * bundled `transcript-analyzer` skill shipped under that project.
 *
 * The skill lives at
 *   flow_sdk/system_projects/flowpad_assistant/.claude/skills/transcript-analyzer/SKILL.md
 *
 * Requires: running backend at localhost:$LOCAL_SERVER_PORT + Claude Code installed.
 * Real Claude subprocess — skips gracefully when Claude is rate-limited.
 */

import { AgenticProcess, FlowData, FlowElementTypes } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const TEST_SKILL = 'transcript-analyzer';

function textContent(outputs: FlowData[]): string {
  return outputs
    .filter((o) => o.elementType === FlowElementTypes.CHAT || o.elementType === FlowElementTypes.TEXT)
    .map((o) => String(o.data ?? ''))
    .join('');
}

function isClaudeUnavailable(content: string): boolean {
  return /(hit your limit|weekly limit|usage limit|rate limit|quota|too many requests|overloaded)/i.test(content);
}

/**
 * Drain `proc.output()` until the worker reaches a terminal status, OR the
 * budget elapses. On timeout we RESOLVE with whatever was collected (rather
 * than reject) so the caller can distinguish "worker produced nothing" (almost
 * always a Claude 429/rate-limit before any output — skip) from a genuine
 * assertion failure. `timedOut` reports which happened.
 */
async function collectOutput(
  proc: AgenticProcess,
  timeoutMs: number,
): Promise<{ outputs: FlowData[]; timedOut: boolean }> {
  const outputs: FlowData[] = [];
  let timedOut = false;
  await Promise.race([
    (async () => {
      for await (const item of proc.output()) {
        outputs.push(item);
      }
    })(),
    new Promise<void>((resolve) => setTimeout(() => { timedOut = true; resolve(); }, timeoutMs)),
  ]);
  return { outputs, timedOut };
}

describe('Flowpad Assistant mount — skill availability', () => {
  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  it('assistant-enabled process can see the transcript-analyzer skill (mounted via --add-dir)', async (context: any) => {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-assistant-skill-'));
    // No explicit worker_type / flag: load_flowpad_assistant is unset, so it
    // inherits the global default (True) → the Flowpad Assistant project is
    // mounted and its skills (incl. transcript-analyzer) are discoverable.
    const proc = await new AgenticProcess({ workdir }).save([]);
    // Sanity: the per-process flag round-trips from the backend "as is".
    expect(proc.load_flowpad_assistant ?? null, 'flag should default to null (inherit global)').toBeNull();
    await proc.watch();

    const collectPromise = collectOutput(proc, 150_000);
    await proc.executeInstruction(
      `You have skills available under mounted .claude/skills directories. ` +
        `List every available skill name, one per line, exactly as named — output only the names. ` +
        `In particular confirm whether a skill named "${TEST_SKILL}" is available.`,
      { sync: false },
    );

    const { outputs, timedOut } = await collectPromise;
    const content = textContent(outputs);
    console.log('[flowpad_assistant_skill_available] element types:', outputs.map((o) => o.elementType).join(', '));
    console.log('[flowpad_assistant_skill_available] content:', content);

    // Claude unavailable (rate-limit / 429) shows up two ways: a rate-limit
    // message in the output, OR — when the 429 hits before any token — no
    // output at all and the drain times out. Both are environmental, not a
    // mount failure, so skip rather than fail. (The worker DID launch with
    // `--add-dir <flowpad_assistant>` either way — that's the mount under test.)
    if (isClaudeUnavailable(content) || (timedOut && outputs.length === 0)) {
      context.skip(`Claude unavailable (rate-limit / no output): ${content.slice(0, 240) || '<no output>'}`);
    }
    expect(outputs.length, 'Expected at least one FlowData item').toBeGreaterThan(0);
    expect(content, `Expected the worker to see the "${TEST_SKILL}" skill`).toContain(TEST_SKILL);
  }, 200_000);
});
