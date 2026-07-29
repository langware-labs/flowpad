/**
 * Codex chat/terminal switch base matrix.
 *
 * A cold headless Codex process is created through the real compute-node
 * action, opened through production navigation, and checked before/after a
 * browser reload. The source contract test pins the shared switch seam used by
 * the live C04-C15 permutations without starting a paid/non-deterministic turn.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { apiBase, apiContext } from '../_shared/api';
import { withViewMode } from '../_shared/view-mode';

test('C01/C03/C09/C10: a new headless Codex opens as chat and reload preserves transport identity', async ({ page }) => {
  const api = await apiContext();
  const create = await api.post(`${apiBase()}/api/v1/graph/compute_node/@local/createProcess`, {
    data: {
      context: {
        workdir: '/tmp',
        worker_type: 'codex',
        permission_mode: 'bypassPermissions',
      },
      visible: false,
      pty_mode: false,
    },
  });
  expect(create.status()).toBe(200);
  const payload = await create.json();
  const processId = payload?.data?.id as string;
  expect(processId).toMatch(/^[0-9a-f-]{36}$/);

  try {
    await page.addInitScript(() => {
      localStorage.setItem('llm-setup-modal-seen', 'true');
    });
    await page.goto(withViewMode('/dock/home', 'standard'));
    await page.evaluate((id) => {
      (window as unknown as { navigation: { openShellProcess: (processId: string) => void } })
        .navigation.openShellProcess(id);
    }, processId);

    await expect(page).toHaveURL(new RegExp(`/dock/shell/agentic_process-${processId}`));
    const active = page.locator('[data-testid="terminal-panel"][data-active="true"]');
    await expect(active).toHaveAttribute('data-pty-mode', 'false');
    await expect(active.getByTestId('simple-chat-pane')).toBeVisible();
    await expect(active.locator('.xterm')).toHaveCount(0);
    // Headless ⇒ the Chat surface, which the footer mode selector shows selected.
    await expect(page.getByTestId('view-toggle-standard')).toHaveAttribute('aria-checked', 'true');

    await page.reload();
    await expect(page).toHaveURL(new RegExp(`/dock/shell/agentic_process-${processId}`));
    await expect(active).toHaveAttribute('data-pty-mode', 'false');
    await expect(active.getByTestId('simple-chat-pane')).toBeVisible();

    const entity = await api.get(`${apiBase()}/api/v1/graph/agentic_process/${processId}`);
    const data = (await entity.json())?.data;
    expect(data.worker_type).toBe('codex');
    expect(data.pty_mode).toBe(false);
    expect(data.id).toBe(processId);
  } finally {
    await api.delete(`${apiBase()}/api/v1/graph/agentic_process/${processId}`);
    await api.dispose();
  }
});

test('C02-C16: transport switching stays one URL-first process with busy and accessibility guards', () => {
  const repo = join(process.cwd(), '..');
  const interactive = readFileSync(
    join(repo, 'ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx'),
    'utf8',
  );
  // The chat⇄terminal switch is the 3-mode control in the terminal HEADER; the
  // transport action itself lives in the hook it calls.
  const modeSwitch = readFileSync(join(repo, 'ui/src/components/view-toggle/view-toggle.tsx'), 'utf8');
  const modeSwitchHook = readFileSync(
    join(repo, 'ui/src/components/terminal/interactive-terminal/use-process-surface.ts'),
    'utf8',
  );
  const terminalPanel = readFileSync(
    join(repo, 'ui/src/components/terminal/TabbedTerminal.tsx'),
    'utf8',
  );
  const sdk = readFileSync(join(repo, 'ts_sdk/src/process/agentic-process.ts'), 'utf8');
  const backend = readFileSync(
    join(repo, 'flow_sdk/builtin/agentic_process/agentic_process.py'),
    'utf8',
  );

  expect(interactive).toContain('useProcessSurface');
  expect(modeSwitchHook).toContain('.switchMode(');
  expect(terminalPanel).toContain('data-worker-session-id');
  expect(terminalPanel).toContain('data-pty-mode');
  expect(modeSwitch).toContain('role="radiogroup"');
  expect(modeSwitch).toContain('aria-label={LABELS[m]}');
  expect(modeSwitch).toContain('aria-checked={active}');
  expect(sdk).toContain('_pendingTransport');
  expect(sdk).toContain('async switchMode(mode: WorkerMode');
  expect(backend).toContain('@action.post(action_name="switch-mode")');
  expect(backend).toContain('message="a turn is in flight"');
});
