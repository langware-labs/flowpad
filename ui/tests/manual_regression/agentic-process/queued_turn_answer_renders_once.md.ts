/**
 * FLOWPAD-2042 — a queue-drained turn's answer must render ONCE in the Standard chat.
 *
 * A turn the pane did not start (the prompt queue draining when the worker frees
 * up) reaches the pane twice: the `observe-turn` stream (useObservedTurn) and the
 * WS broadcast (`run_headless_turn` → `emit_flow_data`). Both land in the same
 * `process.flowDataStream`. When the observe-turn copy of the final answer
 * arrives first, its row is still open (not `ready`) when the WS copy lands, so
 * `_heldTwin` (ready-only) misses it and `_ingestRaw` consolidates the WS copy
 * into that row: "ZEBRA-2042-1ZEBRA-2042-1". A history reload shows it once.
 *
 * Real Claude turns (paid, needs an authenticated `claude` CLI); the drained
 * turn is multi-step on purpose — that is the shape that loses the race.
 *
 * The race is timing-bound: on a fresh session the observe-turn row usually
 * closes before the WS copy lands, so this passes even with the bug. It fails
 * reliably against a long-history headless Claude session — point it at one:
 *   FP2042_PROCESS_ID=<agentic_process id> npx playwright test --config \
 *     tests/manual_regression/agentic-process/playwright.config.ts queued_turn_answer_renders_once
 * (the process is reused, not deleted). Without it a fresh process is created.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';
import { withViewMode } from '../_shared/view-mode';

const DRAINS = 3;
const TURN_TIMEOUT = 150_000;
// Unique per run: a reused process (FP2042_PROCESS_ID) keeps earlier runs' answers in
// its history, and a repeated token would be counted twice.
const RUN = Date.now().toString(36).toUpperCase();

/** How many times `token` appears in `locator`'s rendered text (case-sensitive). */
async function occurrences(locator: Locator, token: string): Promise<number> {
  const text = await locator.innerText();
  return text.split(token).length - 1;
}

async function send(page: Page, text: string): Promise<void> {
  const input = page.getByTestId('entity-execution-input');
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

test('FLOWPAD-2042: a queue-drained turn answer renders once in the Standard chat', async ({ page }) => {
  test.setTimeout(DRAINS * 200_000 + 60_000);

  const api = await apiContext();
  const reuse = process.env.FP2042_PROCESS_ID;
  let processId = reuse ?? '';
  if (!reuse) {
    const create = await api.post(`${apiBase()}/api/v1/graph/compute_node/@local/createProcess`, {
      data: {
        context: {
          workdir: mkdtempSync(join(tmpdir(), 'fp2042-')),
          worker_type: 'claude_code',
        },
        visible: false,
        pty_mode: false,
      },
    });
    expect(create.status()).toBe(200);
    processId = (await create.json())?.data?.id as string;
  }
  expect(processId).toMatch(/^[0-9a-f-]{36}$/);

  try {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
    await page.goto(withViewMode(`/dock/shell/agentic_process-${processId}`, 'standard'));

    const active = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    const pane = active.getByTestId('simple-chat-pane');
    await expect(pane).toBeVisible({ timeout: 60_000 });
    await expect(active).toHaveAttribute('data-pty-mode', 'false');
    await expect(page.getByTestId('entity-execution-input')).toBeVisible();
    const stop = page.getByTestId('entity-execution-stop');

    const answers: string[] = [];
    for (let n = 1; n <= DRAINS; n++) {
      const alpha = `ALPHA-${RUN}-${n}`;
      const zebra = `ZEBRA-2042-${RUN}-${n}`;
      answers.push(zebra);

      await send(page, `Use the Bash tool to run: sleep 12. Then reply with only the uppercase of: ${alpha.toLowerCase()}`);
      // The second prompt must be sent while this turn runs, so the BACKEND starts
      // it from the queue — a turn this pane did not send.
      await expect(stop).toBeVisible({ timeout: 60_000 });
      await send(
        page,
        `First write the sentence "Starting step ${n}." then use the Bash tool to run: echo step-${n}. ` +
          `Then reply with only the uppercase of: ${zebra.toLowerCase()}`,
      );

      await expect(pane).toContainText(alpha, { timeout: TURN_TIMEOUT });
      await expect(pane).toContainText(zebra, { timeout: TURN_TIMEOUT });
      await expect(stop).toBeHidden({ timeout: TURN_TIMEOUT });
      // Let any late second-channel copy land before counting.
      await page.waitForTimeout(5_000);

      const rows = pane.getByTestId('execution-message');
      const doubledRows = await rows.filter({ hasText: `${zebra}${zebra}` }).count();
      expect(doubledRows, `a row shows "${zebra}${zebra}" — the WS copy was appended into the observe-turn row`).toBe(0);
      expect(await occurrences(pane, zebra), `the agent answered "${zebra}" once; the pane must show it once`).toBe(1);
    }

    // Control: the transcript holds one copy of each answer.
    await page.reload();
    await expect(pane).toContainText(answers[answers.length - 1], { timeout: 60_000 });
    for (const zebra of answers) {
      expect(await occurrences(pane, zebra), `after reload "${zebra}" is rebuilt from history`).toBe(1);
    }
  } finally {
    if (!reuse) await api.delete(`${apiBase()}/api/v1/graph/agentic_process/${processId}`);
    await api.dispose();
  }
});
