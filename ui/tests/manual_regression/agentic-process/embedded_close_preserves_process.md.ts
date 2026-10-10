/**
 * Parked embedded-toolbar invariant.
 *
 * There is still no reachable embedded InteractiveTerminal host. Until one
 * ships, this executable source guard covers the exact invariant the scenario
 * locks: embedded Close delegates only to onClose, while destructive and
 * pop-out actions remain non-embedded-only.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

test('embedded Close is a pure host callback and destructive controls stay hidden', () => {
  const repo = join(process.cwd(), '..');
  const toolbar = readFileSync(
    join(repo, 'ui/src/components/terminal/interactive-terminal/ProcessToolbar.tsx'),
    'utf8',
  );
  const menu = readFileSync(
    join(repo, 'ui/src/components/terminal/interactive-terminal/SessionActionsMenu.tsx'),
    'utf8',
  );
  const terminal = readFileSync(
    join(repo, 'ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx'),
    'utf8',
  );

  const embeddedClose = toolbar.match(
    /\{\/\* Close — only in embedded mode \*\/\}[\s\S]*?\{embedded && onClose && \([\s\S]*?label=\{t`Close terminal`\}[\s\S]*?onClick=\{onClose\}[\s\S]*?\)\}/,
  );
  expect(embeddedClose, 'embedded close must directly invoke the host callback').not.toBeNull();
  expect(embeddedClose?.[0]).not.toMatch(/process\.(?:exit|close|stop)/);

  // The nav-out actions (terminal, worktree, commit & merge, export) are one
  // non-embedded-only block of the session actions menu.
  const navOut = menu.match(/\{!embedded && \(\s*<>[\s\S]*?<\/>\s*\)\}/);
  expect(navOut, 'nav-out actions must be one non-embedded-only block').not.toBeNull();
  for (const id of [
    'session-action-terminal',
    'session-action-worktree',
    'session-action-commit-merge',
    'entity-actions-export',
  ]) {
    expect(navOut?.[0]).toContain(id);
    expect(menu.split(id).length, `${id} appears once, inside the block`).toBe(2);
  }
  // Fork is non-embedded-only.
  expect(toolbar).toMatch(/\{!embedded && \(\s*<CompactIconAction\s+icon=\{GitFork\}/);
  expect(terminal).toContain('embedded={embedded}');

  const callers = readFileSync(
    join(repo, 'ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx'),
    'utf8',
  );
  expect((callers.match(/embedded=\{/g) ?? []).length).toBe(1);
});
