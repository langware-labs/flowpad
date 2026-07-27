/**
 * clean_claude_pty — Long Integration Test (50-iteration stress)
 *
 * Approach
 * --------
 * 1. One-time *reference capture*: start a fresh AgenticProcess, wait for PTY
 *    output to settle, render the Claude Code section of the PTY (everything
 *    after the second MODE ON ?2004 marker), and assert structural invariants:
 *      - a full-width separator row  (≥60 '─' chars)
 *      - the '❯' input-prompt glyph on its own line, with nothing after it
 *      - the '⏵⏵' / 'bypass permissions' indicator
 *
 * 2. 49 more stress iterations: same check, collecting failures.
 *
 * Fails on any iteration where the prompt carries leaked content.
 * Zero knowledge of '200~', '201~', or any Flowpad-specific strings.
 *
 * Requires: running backend at localhost:9007 + Claude Code installed.
 */

import {
  AgenticProcess,
  ConnectionManager,
  Shell,
  TypeId,
  dataContext,
  dataManager,
} from '@sdk';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { stressDescribe } from './_stress_gate';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const ITERATIONS = 50;
const MIN_SEPARATOR_LEN = 60;
const INITIAL_SETTLE_MS = 300;
const POLL_INTERVAL_MS = 150;
const MAX_WAIT_MS = 12000;
const BETWEEN_ITER_MS = 400;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decodePtyChunks(shell: Shell): string {
  const dec = new TextDecoder('utf-8', { fatal: false });
  return shell
    .getPtyChunks()
    .map((chunk) => dec.decode(chunk.data))
    .join('');
}

// ---------------------------------------------------------------------------
// Minimal VT100 renderer  (24 rows × 80 cols)
// ---------------------------------------------------------------------------

function renderPtyScreen(raw: string, cols = 80, rows = 24): string[] {
  const screen: string[][] = Array.from({ length: rows }, () => Array(cols).fill(' '));
  let row = 0;
  let col = 0;
  let i = 0;
  const n = raw.length;

  while (i < n) {
    const c = raw[i];

    if (c === '\x1b' && i + 1 < n) {
      const nxt = raw[i + 1];

      if (nxt === '[') {
        // CSI — scan to final byte, skipping intermediate chars (? > < = !)
        let j = i + 2;
        while (j < n && (raw[j] === ';' || raw[j] >= '0' && raw[j] <= '9' || '?><!='.includes(raw[j]))) j++;
        if (j < n) {
          const cmd = raw[j];
          const paramStr = raw.slice(i + 2, j).replace(/[?><!=]/g, '');
          const parts = paramStr.split(';').map((p) => (p === '' ? 0 : parseInt(p, 10)));
          const p0 = parts[0] ?? 0;
          const p1 = parts[1] ?? 0;

          if (cmd === 'H' || cmd === 'f') {
            row = Math.max(0, Math.min(rows - 1, p0 ? p0 - 1 : 0));
            col = Math.max(0, Math.min(cols - 1, p1 ? p1 - 1 : 0));
          } else if (cmd === 'A') { row = Math.max(0, row - (p0 || 1)); }
          else if (cmd === 'B') { row = Math.min(rows - 1, row + (p0 || 1)); }
          else if (cmd === 'C') { col = Math.min(cols - 1, col + (p0 || 1)); }
          else if (cmd === 'D') { col = Math.max(0, col - (p0 || 1)); }
          else if (cmd === 'G') { col = Math.max(0, Math.min(cols - 1, p0 ? p0 - 1 : 0)); }
          else if (cmd === 'J') {
            if (p0 === 2 || p0 === 3) {
              for (let r = 0; r < rows; r++) screen[r].fill(' ');
              row = col = 0;
            }
          } else if (cmd === 'K') {
            if (p0 === 0) { for (let k = col; k < cols; k++) screen[row][k] = ' '; }
            else if (p0 === 1) { for (let k = 0; k <= col; k++) screen[row][k] = ' '; }
            else if (p0 === 2) { screen[row].fill(' '); }
          }
          // SGR and everything else: ignore
          i = j + 1;
          continue;
        }
      } else if (nxt === ']') {
        // OSC — skip to BEL or ST
        let j = i + 2;
        while (j < n && raw[j] !== '\x07' && raw[j] !== '\x1b') j++;
        i = j + 1;
        continue;
      } else {
        // 2-char ESC sequence
        i += 2;
        continue;
      }
    }

    if (c === '\r') { col = 0; }
    else if (c === '\n') { row = Math.min(rows - 1, row + 1); }
    else if (c === '\b') { col = Math.max(0, col - 1); }
    else if (c.codePointAt(0)! >= 32) {
      if (row < rows && col < cols) screen[row][col] = c;
      col = Math.min(cols, col + 1);
    }
    i++;
  }

  return screen.map((r) => r.join('').trimEnd());
}

// ---------------------------------------------------------------------------
// Structural invariant extraction
// ---------------------------------------------------------------------------

interface Invariants {
  separatorFound: boolean;
  promptFound: boolean;
  bypassFound: boolean;
  /** Text on the prompt line after '❯', stripped of cursor blocks / nbsp */
  promptContent: string;
}

function extractInvariants(screenRows: string[]): Invariants {
  const separatorFound = screenRows.some(
    (r) => r.trim().length >= MIN_SEPARATOR_LEN && [...r.trim()].every((ch) => ch === '─'),
  );
  const promptRowIdx = screenRows.findIndex((r) => r.includes('❯'));
  const promptFound = promptRowIdx >= 0;
  const bypassFound = screenRows.some((r) => r.includes('⏵⏵') || r.includes('bypass permissions'));

  let promptContent = '';
  if (promptFound) {
    const after = screenRows[promptRowIdx].split('❯')[1] ?? '';
    // Strip cursor blocks (█ and similar box-drawing), nbsp (\xa0), spaces
    promptContent = after.replace(/[\u2580-\u259f\u2588\xa0 ]+/g, '').trim();
    // Claude rotates a placeholder hint when the input is empty
    // (e.g. `Try "edit <file> to..."`, `Try "refactor <file>"`). Treat any
    // `Try "..."` placeholder as empty \u2014 only real leaked input matters.
    if (/^Try\b.*"/.test(promptContent)) {
      promptContent = '';
    }
  }

  return { separatorFound, promptFound, bypassFound, promptContent };
}

// ---------------------------------------------------------------------------
// Claude Code section extractor
// ---------------------------------------------------------------------------

/**
 * Return the PTY string starting from where Claude Code itself takes over
 * (second occurrence of MODE ON ?2004 = \\x1b[?2004h).
 * The first occurrence is zsh enabling bracketed paste at its prompt.
 */
function extractClaudeSection(fullPty: string): string {
  const marker = '\x1b[?2004h';
  const first = fullPty.indexOf(marker);
  if (first === -1) return fullPty;
  const second = fullPty.indexOf(marker, first + marker.length);
  return second === -1 ? fullPty.slice(first) : fullPty.slice(second);
}

// ---------------------------------------------------------------------------
// Helper: run one AgenticProcess iteration and return its invariants
// ---------------------------------------------------------------------------

async function runIteration(workdir: string): Promise<{ inv: Invariants; process: AgenticProcess }> {
  const process = await new AgenticProcess({
    cli_config: { permission_mode: 'bypassPermissions' },
    workdir,
    visible: true,
  }).save([]);

  await process.start({ visible: true });
  const shellId = process.shell_id!;

  const shell = await dataManager.getByTypeId<Shell>(new TypeId(Shell.type, shellId));
  if (!shell) {
    await process.exit().catch(() => {});
    throw new Error('shell not found');
  }

  // Poll the PTY until Claude banner invariants are met or MAX_WAIT_MS is reached —
  // banner-ready time is variable across spawns. The cheap `bypass` substring probe
  // skips the VT100 render until Claude is actually printing its banner; otherwise
  // each poll re-renders an ever-growing PTY chunk.
  await new Promise((r) => setTimeout(r, INITIAL_SETTLE_MS));
  const deadline = Date.now() + MAX_WAIT_MS;
  let inv: Invariants = { separatorFound: false, promptFound: false, bypassFound: false, promptContent: '' };
  while (Date.now() < deadline) {
    const rawPty = decodePtyChunks(shell);
    if (rawPty.includes('bypass') || rawPty.includes('⏵⏵')) {
      const screen = renderPtyScreen(extractClaudeSection(rawPty));
      inv = extractInvariants(screen);
      if (inv.separatorFound && inv.promptFound && inv.bypassFound) break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { inv, process };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

stressDescribe('clean_claude_pty', () => {
  let activeProcess: AgenticProcess | null = null;

  beforeAll(async () => {
    try {
      await fetch(`${window.location.origin}/health/status`, { signal: AbortSignal.timeout(2000) });
    } catch {
      throw new Error('Server not running — start it with: uv run -m flow_sdk.server.run');
    }
  });

  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
    await vi.waitFor(
      () => { if (!ConnectionManager.getInstance().connected) throw new Error('WS not connected'); },
      { timeout: 5000, interval: 200 },
    );
  });

  afterEach(async () => {
    if (activeProcess) {
      await activeProcess.exit().catch(() => {});
      activeProcess = null;
    }
  });

  it(`PTY screen must be structurally clean on ${ITERATIONS} consecutive launches`, async () => {
    const rawHome = dataContext.bootstrapInfo?.desktop_info?.paths?.home ?? '';
    const workdir = rawHome
      ? rawHome.startsWith('/') ? rawHome : `/${rawHome}`
      : '/tmp';

    // ── Reference (iteration 0) ────────────────────────────────────────────
    const { inv: refInv, process: refProcess } = await runIteration(workdir);
    activeProcess = refProcess;
    expect(refInv.separatorFound, 'reference missing separator — is Claude Code installed?').toBe(true);
    expect(refInv.promptFound,    'reference missing ❯ prompt').toBe(true);
    expect(refInv.bypassFound,    'reference missing bypass-permissions').toBe(true);
    expect(refInv.promptContent,  `reference prompt not empty: ${JSON.stringify(refInv.promptContent)}`).toBe('');
    await refProcess.exit().catch(() => {});
    activeProcess = null;

    const failures: string[] = [];

    // Each iteration gets one retry — back-to-back real-Claude spawns occasionally
    // hit transient PTY/WS races. A real regression would fail BOTH attempts.
    for (let i = 1; i < ITERATIONS; i++) {
      let lastProblems: string[] = [];
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 2; attempt++) {
        let process: AgenticProcess | null = null;
        try {
          // Heal a dropped shared WS before the attempt. Across 50 back-to-back
          // real-Claude PTY spawns the singleton ConnectionManager can drop
          // (PTY-output backpressure on the one socket); without this, every
          // subsequent iteration throws "WebSocket not connected" and is
          // miscounted as a PTY-cleanliness regression. A reconnect is exactly
          // the transient-infra recovery this retry loop exists for — it does
          // not mask real prompt-leak regressions, which fail the invariant
          // checks on a healthy connection.
          const cm = ConnectionManager.getInstance();
          if (!cm.connected) {
            await cm.connect();
            await vi.waitFor(
              () => { if (!cm.connected) throw new Error('WS reconnect pending'); },
              { timeout: 5000, interval: 100 },
            );
          }
          const result = await runIteration(workdir);
          process = result.process;
          activeProcess = process;
          const { inv } = result;

          lastProblems = [];
          if (!inv.separatorFound) lastProblems.push('missing separator');
          if (!inv.promptFound)    lastProblems.push('missing ❯ prompt');
          if (!inv.bypassFound)    lastProblems.push('missing bypass-permissions');
          if (inv.promptContent)   lastProblems.push(`prompt not empty: ${JSON.stringify(inv.promptContent)}`);

          if (lastProblems.length === 0) { lastErr = null; break; }
        } catch (err) {
          lastErr = err;
        } finally {
          await process?.exit().catch(() => {});
          activeProcess = null;
        }
      }
      if (lastErr) failures.push(`iter ${i}: ${lastErr}`);
      else if (lastProblems.length) failures.push(`iter ${i}: ${lastProblems.join('; ')}`);
      await new Promise((r) => setTimeout(r, BETWEEN_ITER_MS));
    }

    expect(failures, `${failures.length}/${ITERATIONS} dirty:\n${failures.join('\n')}`).toHaveLength(0);
    // 50 cold Claude PTYs × ~16-18s/iter on a loaded dev machine. Noisy
    // iterations trigger the one-retry inner loop and can double their cost,
    // so leave 20s/iter + 60s setup as the budget. (Nominal iteration is
    // ~14s; the extra is retry headroom, not slack on the happy path.)
  }, ITERATIONS * 20_000 + 60_000);
});
