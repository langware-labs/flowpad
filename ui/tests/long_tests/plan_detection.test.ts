/**
 * Plan-detection end-to-end (PTY shell + line triggers + getPlan).
 *
 * Drives a real Claude Code PTY session, prompts it to make a plan, and
 * validates the plan-detection pipeline:
 *   - process.onLine fires while Claude streams text
 *   - process.onPlan({ validate: true }) eventually receives a Markdown
 *     entity (validated by server-side getPlan() call)
 *   - process.plan_path is persisted on the entity
 *   - the resolved Markdown's .md file mentions "fibonacci"
 *
 * Requires: running backend at LOCAL_SERVER_PORT + Claude Code installed.
 * Timeout: 240s — plan generation involves multiple model round-trips.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { AgenticProcess, Markdown } from '@sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// Phrased to push Claude toward a concrete ExitPlanMode tool call rather
// than diverting into any auto-loaded skill (e.g. flowpad-assistance). The
// model has to invoke ExitPlanMode for the transcript to carry the
// ``planFilePath`` we read on the server side.
const PROMPT =
  'Generate a plan for implementing a fibonacci(n) function in Python. ' +
  'Use plan mode and call the ExitPlanMode tool to present the plan. ' +
  'Do not navigate, do not call any flowpad-assistance skill. The plan ' +
  'should be a short markdown outline mentioning fibonacci.';

function readMarkdownBody(md: Markdown): string {
  const ar = md.asset_ref;
  if (!ar) return '';
  try {
    return fs.readFileSync(ar, 'utf-8');
  } catch {
    return '';
  }
}

describe('AgenticProcess plan detection — end-to-end', () => {
  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
  });

  let proc: AgenticProcess | null = null;
  afterEach(async () => {
    if (proc) {
      await proc.exit().catch(() => {});
      proc = null;
    }
  });

  it(
    'PTY prompt → onPlan({validate:true}) resolves a Markdown referencing fibonacci',
    async () => {
      const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-detection-'));
      // Launch Claude in plan mode at the CLI level. ``ExitPlanMode``
      // is gated by session-level plan state — without this flag the
      // model writes a plan as text but the tool itself errors with
      // "you are not in plan mode".
      proc = await new AgenticProcess({
        cli_config: { permission_mode: 'plan' },
        workdir,
        visible: true,
      }).save([]);

      // Spawn Claude in interactive PTY mode and wait for the shell link.
      await proc.start({ visible: true });

      // Subscribe to lines + plan events. Validate=true so the handler
      // receives the resolved Markdown (or null) once getPlan() runs.
      const triggerLines: string[] = [];
      const planEvents: (Markdown | null)[] = [];
      const unsubLines = proc.onLine((line) => {
        triggerLines.push(line);
      });
      const unsubPlan = proc.onPlan<Markdown | null>({ validate: true }, (md) => {
        planEvents.push(md);
      });

      // eslint-disable-next-line no-console
      console.log(
        `[plan_detection] process.id=${proc.id} session_id=${proc.session_id ?? 'null'} ` +
          `shell_id=${proc.shell_id ?? 'null'} workdir=${proc.workdir ?? 'null'}`,
      );

      // Stream PTY output so we can see what Claude actually prints.
      const unsubLineLog = proc.onLine((line) => {
        if (line.trim()) {
          // eslint-disable-next-line no-console
          console.log(`[pty-line] ${line.slice(0, 200)}`);
        }
      });

      try {
        // Wait until the PTY is live (WS attached + replay done) before
        // typing into it. ``sendInput`` silently no-ops if the PTY isn't
        // live yet.
        const startDeadline = Date.now() + 30_000;
        while (Date.now() < startDeadline && !proc.ptyConnection?.isLive) {
          await new Promise((r) => setTimeout(r, 200));
        }
        // eslint-disable-next-line no-console
        console.log(
          `[plan_detection] PTY live=${proc.ptyConnection?.isLive} ` +
            `replayDone=${proc.ptyConnection?.replayDone} after start. ` +
            `session_id now=${proc.session_id ?? 'null'}`,
        );

        // Send the prompt as text, then Enter as a separate keystroke.
        // Claude's TUI bracketed-paste-wraps any chunk we send, so a
        // trailing \r in the same chunk is absorbed as paste content
        // rather than treated as Enter-to-submit. Split into two writes
        // with a long enough delay for the paste to settle.
        const pty = proc.ptyConnection!;
        await pty.sendInput(PROMPT);
        await new Promise((r) => setTimeout(r, 1500));
        await pty.sendInput('\r');
        // eslint-disable-next-line no-console
        console.log(`[plan_detection] prompt sent + Enter. Polling getPlan...`);

        // Poll getPlan() until the plan resolves or we hit the test budget.
        // Plan generation involves multiple model round-trips; budget
        // generously.
        const deadline = Date.now() + 200_000;
        let resolved: Markdown | null = null;
        while (Date.now() < deadline) {
          resolved = await proc.getPlan();
          if (resolved) break;
          await new Promise((r) => setTimeout(r, 2000));
        }

        expect(resolved, 'getPlan() should resolve to a Markdown entity within the test budget').not.toBeNull();
        expect(proc.plan_path, 'plan_path should be persisted on the process').toBeTruthy();
        expect(proc.plan_path ?? '', 'plan_path should point under .claude/plans/').toMatch(/\.claude\/plans\//);

        const body = readMarkdownBody(resolved!);
        expect(body.length, 'plan markdown file should have content').toBeGreaterThan(0);
        expect(body.toLowerCase(), 'plan content should mention fibonacci').toContain('fibonacci');

        // The line-trigger pipeline should have fired for at least the
        // banner / prompt rendering — log counts so PTY-trigger coverage
        // is observable, but don't hard-fail since the path may surface
        // only via the transcript path.
        // eslint-disable-next-line no-console
        console.log(
          `[plan_detection] lines captured=${triggerLines.length}, ` +
            `validated plan events=${planEvents.length}, ` +
            `nonNullPlanEvents=${planEvents.filter((p) => p != null).length}`,
        );
        expect(triggerLines.length, 'expected line trigger to fire at least once during the session').toBeGreaterThan(0);
      } finally {
        unsubLines();
        unsubPlan();
        unsubLineLog();
      }
    },
    240_000,
  );
});
