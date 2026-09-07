/**
 * FLOWPAD-2095: composer status pill vs. activity line after a forced-kill +
 * stale transcript.
 * Source: worker_status_pill_drift.md
 *
 * Forces a real worker into `worker_status: inactive` while the session is
 * otherwise live (status=running, session_id present), then re-prompts it and
 * diffs the two surfaces that are supposed to agree a turn is running:
 *   - the bottom-of-chat activity line (ChatActivityLine, data-testid
 *     "chat-activity-label") — goes through `useTurnActivity`, which ORs the
 *     client-side `isPrompting` latch with the entity's `busy` and overrides
 *     any terminal `workerStatus` (INACTIVE included) to "Working".
 *   - the composer's status pill (ChatComposerBar `statusSlot`, data-testid
 *     "simple-chat-status") — resolves straight through `getDisplayStatus`,
 *     which knows nothing about `isPrompting` and has no terminal override, so
 *     it can render the stale "Inactive" until the backend's `busy: true`
 *     broadcast lands over the websocket.
 *
 * "Inactive" only exists after ~5 real minutes of transcript silence
 * (worker_status.py: ACTIVE_SECONDS=300, is_active = mtime-based, checked live
 * — not cached). Rather than waiting, this test kills the real `claude.exe`
 * worker (so the transcript's last entry has no terminal marker) and then
 * back-dates the transcript file's mtime with `fs.utimes`, which is exactly
 * equivalent from the backend's point of view.
 */
import { execFileSync } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { withViewMode } from '../_shared/view-mode';
import { dismissSetupModal, startClaude, processIdFromUrl, apiBase, activePanel, fetchProcess } from './_ap_helpers';

const ACTIVE_SECONDS = 300; // mirrors flow_sdk/builtin/worker_status.py

/** Navigate to a fresh Standard-view shell. SimpleChatPane + ChatComposerBar
 *  (with the activity line and the status pill) only render together once a
 *  process actually exists — a plain pre-`startClaude` shell shows a "Start
 *  Claude" prompt instead, so callers must wait for those testids AFTER
 *  starting the agent, not here. Advanced view shows the xterm instead of
 *  either. */
async function gotoNewStandardShell(page: Page) {
  await page.goto(withViewMode('/dock/shell/new_terminal', 'standard'));
  const skip = page.getByRole('button', { name: 'Skip' });
  if (await skip.isVisible({ timeout: 2_000 }).catch(() => false)) await skip.click();
  await page.waitForURL(/\/dock\/shell\/(shell-|agentic_process-)/, { timeout: 60_000 });
}

/**
 * OS pid of the live `claude --resume <sessionId>` worker. Mirrors the argv
 * match `flow_sdk/builtin/shell.py`'s `_session_worker_procs` does server-side
 * (pinned argv shapes: tests/unit/test_worker_cmdline_match.py).
 */
function findWorkerPid(sessionId: string): number | null {
  if (process.platform === 'win32') {
    const out = execFileSync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${sessionId}*' } | Select-Object -First 1 -ExpandProperty ProcessId)`,
    ])
      .toString()
      .trim();
    return out ? Number(out) : null;
  }
  const out = execFileSync('bash', ['-c', `pgrep -f "${sessionId}" | head -1`]).toString().trim();
  return out ? Number(out) : null;
}

/** Hard-kill — deliberately NOT the graceful interrupt endpoint, which would
 *  write its own "[Request interrupted by user]" terminal marker. */
function killPid(pid: number) {
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${pid} -Force -Confirm:$false`]);
  } else {
    process.kill(pid, 'SIGKILL');
  }
}

/** `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl` — scans every project
 *  dir rather than re-deriving the cwd encoding, same fallback the backend
 *  itself uses (flow_sdk/fs_store/indexer/functions/claude_sessions.py). */
async function findTranscriptPath(sessionId: string): Promise<string | null> {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const fname = `${sessionId}.jsonl`;
  let dirs: string[];
  try {
    dirs = await fsp.readdir(projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsDir, dir, fname);
    try {
      await fsp.access(candidate);
      return candidate;
    } catch {
      // not this project dir — keep scanning
    }
  }
  return null;
}

test.describe('worker status pill drift (FLOWPAD-2095)', () => {
  test('composer pill matches the activity line right after re-prompting an INACTIVE session', async ({ page }) => {
    test.setTimeout(300_000);
    test.skip(process.platform !== 'win32', 'process-kill helper here is Windows-only; see findWorkerPid');

    await dismissSetupModal(page);
    await gotoNewStandardShell(page);
    await startClaude(page);
    const pid = processIdFromUrl(page);
    // Unlike the PTY-mode sessions `_ap_helpers.ts`'s `waitForRunningSession`
    // targets (Advanced view), `startClaude()` from Standard view creates a
    // HEADLESS process (pty_mode: false) — it legitimately sits at
    // `status: "new"` with no worker at all until the first prompt is sent
    // (confirmed via the network trace: no `.../open` call ever fires here).
    // SimpleChatPane still mounts immediately (`showSimpleChat` admits a
    // headless process regardless of status), so there is nothing to wait on
    // besides the UI itself before sending.
    await activePanel(page).locator('[data-testid="simple-chat-pane"]').waitFor({ state: 'visible', timeout: 30_000 });

    const input = activePanel(page).locator('[data-testid="entity-execution-input"]');
    const send = activePanel(page).locator('[data-testid="entity-execution-send"]');
    const activityLabel = activePanel(page).locator('[data-testid="chat-activity-label"]');
    const composerPill = activePanel(page).locator('[data-testid="simple-chat-status"]');

    // 1. Kick off a turn with a real, controllable busy window. A pure text
    // generation prompt (e.g. "generate 1000 words") races and loses — a fast
    // model can finish and let the CLI exit cleanly before this test can look
    // up and kill the OS process. A shell command in flight guarantees both a
    // wide window AND a dangling, unanswered `tool_use` transcript entry (the
    // tool-call frame flushes to the transcript before its result — confirmed
    // against a real transcript while proving out this repro manually).
    const sentAt = Date.now();
    await input.fill('Run the shell command `sleep 30` and wait for it to finish before replying.');
    await send.click();

    // 2. Wait for a REAL turn in flight (busy + session_id), so there's an OS
    // worker process and a non-terminal transcript entry to kill.
    let sessionId = '';
    await expect(async () => {
      const proc = await fetchProcess(page, apiBase(), pid);
      expect(proc.busy).toBe(true);
      expect(proc.session_id).toBeTruthy();
      sessionId = proc.session_id;
    }).toPass({ timeout: 60_000 });

    // 3. `busy` flips true as soon as the turn is accepted — before the
    // claude.exe child has actually spawned and written anything. Worse, this
    // app REUSES an idle Claude tab/session across separate launches instead
    // of always minting a fresh one (confirmed: a resumed session's .jsonl
    // already has old history on disk from a PRIOR turn), so "the file
    // exists" is true immediately and proves nothing about THIS turn. Wait
    // for the file's mtime to actually move past `sentAt` — that is the only
    // reliable signal that the sleep tool-call has been flushed.
    let transcriptPath: string | null = null;
    await expect(async () => {
      const found = await findTranscriptPath(sessionId);
      expect(found, `no transcript found yet for session ${sessionId}`).not.toBeNull();
      const stat = await fsp.stat(found!);
      expect(stat.mtimeMs, 'transcript exists but has no fresh activity from this turn yet').toBeGreaterThan(sentAt);
      transcriptPath = found;
    }).toPass({ timeout: 30_000 });

    // 4. Hard-kill the worker — no graceful terminal marker gets written.
    const workerPid = findWorkerPid(sessionId);
    expect(workerPid, `no OS process found for session ${sessionId}`).not.toBeNull();
    killPid(workerPid!);

    // 6. Back-date the transcript past ACTIVE_SECONDS instead of waiting.
    const past = new Date(Date.now() - (ACTIVE_SECONDS + 10) * 1000);
    await fsp.utimes(transcriptPath!, past, past);

    // 7. Confirm the repro precondition: a live session reporting a terminal
    // worker_status (the exact state described in the ticket). `busy` must
    // have settled back to false too (the backend reaps the killed child) —
    // otherwise the next send would enqueue onto the dead turn instead of
    // starting a fresh one, and `isPrompting` would never flip.
    await expect(async () => {
      const proc = await fetchProcess(page, apiBase(), pid);
      expect(proc.status).toBe('running');
      expect(proc.busy).toBe(false);
      expect(proc.worker_status).toBe('inactive');
    }).toPass({ timeout: 20_000 });

    // 8. Re-prompt. `isPrompting` flips client-side the instant this resolves;
    // the backend's own `busy: true` broadcast is what's on the clock here.
    await input.fill('Are you still there?');
    await send.click();

    // 9. Read both surfaces as early as possible — this is the actual race
    // window the bug lives in.
    await activityLabel.waitFor({ state: 'visible', timeout: 5_000 });
    const activityText = (await activityLabel.textContent())?.trim() ?? '';
    const pillText = (await composerPill.textContent())?.trim() ?? '';
    // eslint-disable-next-line no-console
    console.log(`[FLOWPAD-2095] activity line: "${activityText}" | composer pill: "${pillText}"`);

    expect(activityText, 'activity line regressed to a stale terminal label').not.toMatch(/inactive/i);
    // This is the actual regression assertion — expected to FAIL until
    // ChatComposerBar's statusSlot adopts the same isPrompting-aware signal
    // ChatActivityLine already uses (see worker_status_pill_drift.md).
    expect(pillText, 'composer pill still reads a stale terminal status').not.toMatch(/inactive/i);
  });
});
