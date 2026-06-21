/**
 * Assistance-enabled agent → `flow navigate` → ui_command(navigate_entity) reaches the WS.
 *
 * End-to-end, no mocks: a real Claude worker (load_flowpad_assistant=true) is told to
 * create a file, then told to "now open it". The agent resolves the entity and shells out
 * to the bundled flowpad-assistance/flowpad-navigation skill (`flow navigate entity <typeid>`),
 * which the backend turns into a `ui_command` { kind: 'navigate_entity' } frame sent to the
 * active tab. This test connects as that active tab (presence visible+focused) and asserts the
 * frame was received.
 *
 * Requires: running long-test backend (localhost:9007) with FLOWPAD_DEFAULT_WORKER=claude.
 * Timeout: 240s (two real Claude turns) — the established long-test cap; do not raise.
 */

import { AgenticProcess, ConnectionManager, FlowData, FlowElementTypes, type UiCommandMessage } from '@sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

describe('assistance agent flow navigate — ui_command(navigate_entity) reaches the WS', () => {
  let proc: AgenticProcess | null = null;
  let workdir: string | null = null;

  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);

    // This test connection must be the "active tab" the backend targets for a
    // connection-less `flow navigate`. New connections default to visible+focused
    // server-side, but assert it explicitly so the routing is order-independent.
    const cm = ConnectionManager.getInstance();
    await vi.waitFor(
      () => {
        if (!cm.connected) throw new Error('WS not connected');
      },
      { timeout: 5000, interval: 200 },
    );
    cm.send(
      JSON.stringify({
        message_type: 'presence',
        message_id: crypto.randomUUID(),
        visible: true,
        focused: true,
      }),
    );
  });

  afterEach(async () => {
    try {
      await proc?.stop?.();
    } catch {
      /* best-effort */
    }
    if (workdir && !process.env.KEEP_WORKDIR) {
      try {
        fs.rmSync(workdir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    proc = null;
    workdir = null;
  });

  it('create a file, then "now open it" → navigate_entity event received', async (context: any) => {
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-nav-open-it-'));
    proc = await new AgenticProcess({
      workdir,
      load_flowpad_assistant: true,
      cli_config: { permission_mode: 'bypassPermissions' },
    }).save([]);
    await proc.watch();

    // Capture navigate_entity ui_commands for the whole run.
    const received: UiCommandMessage[] = [];
    const cm = ConnectionManager.getInstance();
    cm.on('on_ui_command', (msg: UiCommandMessage) => {
      if (msg?.kind === 'navigate_entity') received.push(msg);
    });

    // Turn 1 — create the file. Start draining output() BEFORE triggering, then await.
    const turn1Promise = collectOutput(proc, 150_000);
    await proc.executeInstruction('Create a file hello.md with the text "hello".', { sync: false });
    const turn1Content = chatContent(await turn1Promise);
    if (isClaudeUnavailable(turn1Content)) {
      context.skip(`Claude unavailable: ${turn1Content.slice(0, 240)}`);
    }

    // Turn 2 — "now open it". workerStatus is COMPLETE from turn 1, so subscribe to the
    // next 'complete' edge BEFORE triggering (the multi-turn pattern), then assert the event.
    const turn2Done = new Promise<void>((resolve) => {
      const unsub = proc!.on('complete', () => {
        unsub();
        resolve();
      });
    });
    await proc.executeInstruction('now open it in flowpad', { sync: false });
    await turn2Done;

    // The navigate frame may land a tick after the worker's terminal edge.
    await vi.waitFor(
      () => {
        if (received.length === 0) throw new Error('no navigate_entity ui_command received');
      },
      { timeout: 10_000, interval: 200 },
    );

    expect(received.length, 'expected a navigate_entity ui_command').toBeGreaterThan(0);
    expect(received[0].kind).toBe('navigate_entity');
    expect(received[0].type, 'navigate target type').toBeTruthy();
    expect(received[0].id, 'navigate target id').toBeTruthy();
  }, 240_000); // do not increase timeout without approval
});
