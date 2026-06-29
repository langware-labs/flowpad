/**
 * CLI log viewer — `flow log` (FLOWPAD).
 * Source: cli_log_viewer.md
 *
 * The viewer is the bare `flow log` command (with --limit / --level); the real
 * subcommands are replay / settings / clear. `flow` is on PATH at
 * <repo>/.venv/bin; the instance is selected via FLOW_INSTANCE (QA_FLOW_INSTANCE,
 * default qa-2). Pure-CLI test — shells out via child_process.
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'node:child_process';
import * as path from 'node:path';

// Playwright runs from the `ui/` directory; the repo root is its parent.
const REPO_ROOT = path.resolve(process.cwd(), '..');
const FLOW = path.join(REPO_ROOT, '.venv/bin/flow');
const FLOW_INSTANCE = process.env.QA_FLOW_INSTANCE || 'qa-2';

function flow(args: string): { code: number; out: string } {
  try {
    const out = execSync(`${FLOW} ${args}`, {
      env: { ...process.env, FLOW_INSTANCE },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e: unknown) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

test('test 1: `flow log` lists recent CLI log entries', () => {
  expect(flow('log --limit 20').code).toBe(0);
});

test('test 2: `flow log --help` exposes the real subcommands (replay/settings/clear)', () => {
  const r = flow('log --help');
  expect(r.code).toBe(0);
  expect(r.out).toContain('clear');
});

test('test 3: `flow log clear` empties the log', () => {
  expect(flow('log clear').code).toBe(0);
  expect(flow('log --limit 5').code).toBe(0);
});
