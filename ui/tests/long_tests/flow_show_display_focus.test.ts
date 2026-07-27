/**
 * Agent → `flow show` → AgenticProcess.on_show → entity_event('on_show') → TS 'show' event.
 *
 * End-to-end, no mocks: a real Claude worker is created with standing
 * instructions (context_data.instructions → system-prompt append) telling it to
 * present its deliverable via `flow show`. One turn — "build me hello world
 * app" — the agent writes the app and runs `flow show file <path>` (or
 * `flow show webapp --port N`), the backend `show` action resolves the target
 * and emits the `on_show` entity event, which this test observes through the
 * SDK's typed `proc.onShow(...)` subscription (the same channel a display
 * surface uses). `show` deliberately needs NO active tab — unlike navigate —
 * so no presence frame is sent.
 *
 * The test passes the moment the show event arrives — it does NOT wait for the
 * turn to complete (the show fires mid-turn, right after the deliverable
 * exists). Output is drained only for diagnostics / the Claude-unavailable skip.
 *
 * Requires: running long-test backend with FLOWPAD_DEFAULT_WORKER=claude,
 * restarted with the `show` action + instructions-merge backend changes.
 */

import { AgenticProcess, FlowData, FlowElementTypes } from '@sdk';
import { afterEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SHOW_INSTRUCTIONS = [
  'Work fast, no explanations, no preamble text.',
  'Exactly two actions: (1) Write the deliverable file. (2) Run via Bash:',
  '  flow show file <absolute-path>',
  'then stop. Run flow show exactly once; exit 0 means done.',
  'Do NOT use `flow navigate`. Do NOT read files, list directories, or verify.',
].join('\n');

function chatContent(outputs: FlowData[]): string {
  return outputs
    .filter((o) => o.elementType === FlowElementTypes.CHAT || o.elementType === FlowElementTypes.TEXT)
    .map((o) => String(o.data ?? ''))
    .join('');
}

function isClaudeUnavailable(content: string): boolean {
  return /(hit your limit|weekly limit|usage limit|rate limit|quota|too many requests|overloaded)/i.test(content);
}

describe('flow show — agent-declared display focus reaches proc.onShow', () => {
  let proc: AgenticProcess | null = null;
  let workdir: string | null = null;

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

  it('instructions + "build me hello world app" → on_show payload received', async (context: any) => {
    await apiTestSetup(getTestSignupInfo(), context.task.name);

    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'flow-show-hello-'));

    // 1-2. ap = new AP().save() with the standing show instructions
    //      (context_data.instructions → worker system-prompt append).
    // The worker resolves `flow` from PATH — normally the installed release
    // (~/.local/bin/flow), which may predate `flow show`. Front this repo's
    // venv so the worker runs the CLI under test.
    const venvBin = path.resolve(__dirname, '../../..', '.venv/bin');

    proc = await new AgenticProcess({
      workdir,
      // Headless transport — with the PTY default, `claude -- "<prompt>"` only
      // PRE-FILLS the first prompt (no auto-submit) and the turn never runs.
      pty_mode: false,
      // No assistant mount — the instructions below carry the whole recipe,
      // and skipping the skill scan shaves seconds off claude boot.
      load_flowpad_assistant: false,
      context_data: { instructions: SHOW_INSTRUCTIONS },
      cli_config: {
        permission_mode: 'bypassPermissions',
        // This test exercises the show plumbing, not model quality — haiku
        // keeps the whole turn inside the 30s cap.
        model: 'haiku',
        env_vars: { PATH: `${venvBin}:${process.env.PATH ?? ''}` },
      },
    }).save([]);
    await proc.watch();

    // 4 (armed before 3). Subscribe to the typed 'show' event BEFORE submitting —
    // the show lands mid-turn.
    const received: Record<string, unknown>[] = [];
    let resolveShow!: () => void;
    const showSeen = new Promise<void>((resolve) => {
      resolveShow = resolve;
    });
    proc.onShow((payload) => {
      received.push(payload);
      resolveShow();
    });

    // Drain output for diagnostics only (never awaited to completion — the
    // test must not depend on the turn finishing). Ring-capped: only the tail
    // is ever read (for the failure message), so don't retain a chatty turn.
    const outputs: FlowData[] = [];
    void (async () => {
      try {
        for await (const item of proc!.output()) {
          outputs.push(item);
          if (outputs.length > 200) outputs.shift();
        }
      } catch {
        /* stream ends with the process — irrelevant once show is seen */
      }
    })();

    // 3. ap.submit("build me hello world app") — fire the turn, don't wait for it.
    await proc.executeInstruction(
      'build me hello world app (a simple single index.html is fine)',
      { sync: false },
    );

    // 4. wait for the show command — the ONLY await; fail fast with whatever
    //    the agent said so far.
    await Promise.race([
      showSeen,
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          const said = chatContent(outputs);
          reject(
            new Error(
              isClaudeUnavailable(said)
                ? `SKIP-WORTHY Claude unavailable: ${said.slice(0, 240)}`
                : `no on_show received; agent said: ${said.slice(0, 400)}`,
            ),
          );
        }, 55_000),
      ),
    ]).catch((e: Error) => {
      if (/SKIP-WORTHY/.test(e.message)) context.skip(e.message);
      throw e;
    });

    expect(received.length, 'expected at least one show payload').toBeGreaterThan(0);
    const payload = received[0];
    expect(payload.kind, 'show payload kind').toMatch(/^(entity|vfs|webapp)$/);
    if (payload.kind === 'webapp') {
      expect(payload.port, 'webapp show carries the port').toBeTruthy();
    } else {
      // entity | vfs — the target must be addressable: a typeid or a path.
      expect(payload.typeid ?? payload.path, 'show target (typeid or path)').toBeTruthy();
    }
  }, 60_000); // user-approved 60s exception 2026-07-03 (claude CLI boot alone is 15-18s;
  // the agent's flow show landed T+30-48s across runs) — do not increase further
});
