/**
 * Deterministic browser slice of the Codex chat/terminal full matrix.
 *
 * The live-worker transport/restart permutations are exercised by the API,
 * long, hub-browser, and unit suites. This file owns the browser projection
 * seam: one canonical Codex transcript must survive chat/trace switches and a
 * hard reload without dropping semantic rows or collapsing equal content.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { withViewMode } from '../_shared/view-mode';

const SESSION = 'matrix-session';

type Entry = Record<string, unknown>;

function base(kind: string, id: string, timestamp: string): Entry {
  return {
    kind,
    id,
    session_id: SESSION,
    timestamp,
    worker: 'codex',
    parent_id: null,
    is_sidechain: false,
    entry_id: id,
    model: 'gpt-5',
  };
}

function matrixTranscript() {
  const entries: Entry[] = [
    { ...base('meta', 'meta-1', '2026-07-25T10:00:00.000Z'), meta_kind: 'session_meta', payload: { cwd: '/repo' } },
    { ...base('system', 'developer-1', '2026-07-25T10:00:00.100Z'), subtype: 'developer', payload: { text: 'policy' } },
  ];

  for (let turn = 1; turn <= 3; turn += 1) {
    entries.push(
      { ...base('user_message', `user-${turn}`, `2026-07-25T10:00:0${turn}.000Z`), text: 'SAME PROMPT', role: 'user' },
      {
        ...base('assistant_message', `assistant-${turn}`, `2026-07-25T10:00:0${turn}.100Z`),
        text: 'SAME ANSWER',
        thinking: turn === 1 ? 'Inspecting the durable projection before answering.' : null,
        phase: 'final_answer',
      },
    );
  }

  entries.push(
    {
      ...base('shell_command', 'command-ok', '2026-07-25T10:00:05.000Z'),
      command: 'printf ok',
      cwd: '/repo',
      exit_code: 0,
      stdout_preview: 'ok',
      stderr_preview: null,
      duration_ms: 12,
      timeout: null,
      tool_name: 'exec_command',
      tool_use_id: 'call-ok',
    },
    {
      ...base('shell_command', 'command-fail', '2026-07-25T10:00:06.000Z'),
      command: 'false',
      cwd: '/repo',
      exit_code: 1,
      stdout_preview: null,
      stderr_preview: 'failed',
      duration_ms: 7,
      timeout: null,
      tool_name: 'exec_command',
      tool_use_id: 'call-fail',
    },
    {
      ...base('file_edit', 'edit-1', '2026-07-25T10:00:07.000Z'),
      path: 'src/a.ts',
      hunks: [{ old: 'a', new: 'b' }, { old: 'c', new: 'd' }],
      change_summary: 'two-file matrix edit',
      tool_name: 'apply_patch',
      tool_use_id: 'call-edit',
    },
    {
      ...base('file_write', 'write-1', '2026-07-25T10:00:08.000Z'),
      path: 'src/b.ts',
      content: 'export const b = true;',
      bytes_count: 22,
      line_count: 1,
      is_new: true,
      tool_name: 'apply_patch',
      tool_use_id: 'call-write',
    },
    {
      ...base('skill_call', 'skill-1', '2026-07-25T10:00:09.000Z'),
      skill_name: 'matrix-skill',
      invocation_kind: 'file_load',
      tool_name: 'read_file',
      tool_use_id: 'call-skill',
    },
    {
      ...base('token_usage', 'assistant-3:usage', '2026-07-25T10:00:10.000Z'),
      input_tokens: 120,
      output_tokens: 30,
      cached_input_tokens: 20,
      reasoning_output_tokens: 4,
    },
  );

  return {
    ok: true,
    worker_type: 'codex',
    session_id: SESSION,
    path: `/tmp/rollout-${SESSION}.jsonl`,
    received: false,
    header: { name: 'Codex matrix fixture', model: 'gpt-5' },
    entries,
  };
}

function semanticTraceRowCount(): number {
  return matrixTranscript().entries.filter(
    (entry) =>
      entry.kind !== 'token_usage' &&
      !(entry.kind === 'meta' && entry.meta_kind === 'session_meta'),
  ).length;
}

async function openMatrix(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('llm-setup-modal-seen', 'true');
  });
  await page.route(`**/api/v1/workers/codex/${SESSION}/transcript`, async (route) => {
    // The route answers in the standard `{status, message, data}` envelope (every
    // backend route does — CLAUDE.md), and `apiClient` unwraps `data`. Fulfilling
    // with the BARE fixture handed the consumer `undefined`, so the transcript
    // rendered zero rows and every count assertion below read 0.
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ status: 'SUCCESS', message: 'success', data: matrixTranscript() }),
    });
  });
  await page.goto(
    withViewMode(`/dock/lens/codex/transcript/${SESSION}?transcriptMode=chat`, 'advanced'),
  );
}

test.describe('Codex durable transcript projection', () => {
  test('D01/D04/D10: equal turns and semantic entries survive mode switches and reload', async ({ page }) => {
    await openMatrix(page);

    await expect(page.getByText('SAME PROMPT', { exact: true })).toHaveCount(3);
    await expect(page.getByText('SAME ANSWER', { exact: true })).toHaveCount(3);
    await expect(page.getByText('Inspecting the durable projection before answering.', { exact: true })).toBeVisible();

    await page.getByTestId('transcript-mode-chip-trace').click();
    // session_meta renders in the transcript header and token_usage annotates
    // its preceding semantic row; neither is a standalone trace row.
    await expect(page.locator('[data-entry-uuid]')).toHaveCount(semanticTraceRowCount());
    await expect(page.getByText('printf ok', { exact: true })).toBeVisible();
    await expect(page.getByText('false', { exact: true })).toBeVisible();
    // OperationRow intentionally renders compact basenames while the full path
    // remains part of the durable entry payload.
    await expect(page.getByText('a.ts', { exact: true })).toBeVisible();
    await expect(page.getByText('b.ts', { exact: true })).toBeVisible();
    await expect(page.getByText('matrix-skill', { exact: true })).toBeVisible();

    await page.getByTestId('transcript-mode-chip-chat').click();
    await page.reload();
    await expect(page.getByText('SAME PROMPT', { exact: true })).toHaveCount(3);
    await expect(page.getByText('SAME ANSWER', { exact: true })).toHaveCount(3);
  });

  test('D02-D09/R01-R09/A01-A08: the production seams required by the live matrix remain wired', () => {
    const repo = join(process.cwd(), '..');
    const sdk = readFileSync(join(repo, 'ts_sdk/src/process/agentic-process.ts'), 'utf8');
    const backend = readFileSync(
      join(repo, 'flow_sdk/builtin/agentic_process/agentic_process.py'),
      'utf8',
    );
    const terminalPanel = readFileSync(
      join(repo, 'ui/src/components/terminal/TabbedTerminal.tsx'),
      'utf8',
    );
    // One mode selector (the footer ViewToggle); the transport reconcile that
    // follows a mode change lives in the useProcessSurface effect.
    const modeSwitchHook = readFileSync(
      join(repo, 'ui/src/components/terminal/interactive-terminal/use-process-surface.ts'),
      'utf8',
    );
    const modeSwitch = readFileSync(join(repo, 'ui/src/components/view-toggle/view-toggle.tsx'), 'utf8');
    const toolbar = readFileSync(
      join(repo, 'ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx'),
      'utf8',
    );

    expect(sdk).toContain('async switchMode(mode: WorkerMode');
    expect(sdk).toContain('_pendingTransport');
    expect(sdk).toContain('loadHistory({ force: true })');
    expect(backend).toContain('@action.post(action_name="switch-mode")');
    expect(backend).toContain('restart_required');
    expect(backend).toContain('ensure_embedded_assets');
    expect(terminalPanel).toContain('useProcessSurface');
    expect(modeSwitchHook).toContain('.switchMode(');
    expect(modeSwitchHook).toContain('loadHistory({ force: true })');
    expect(terminalPanel).toContain('data-pty-mode');
    expect(modeSwitch).toContain('view-toggle-${m}');
    expect(modeSwitch).toContain('ViewMode.Vibe');
    expect(toolbar).toContain("if (wt === 'codex') return 'Codex'");
    expect(toolbar).toContain('permission_mode');
  });
});
