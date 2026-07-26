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
  const terminal = readFileSync(
    join(repo, 'ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx'),
    'utf8',
  );

  const embeddedClose = toolbar.match(
    /\{\/\* Close — only in embedded mode \*\/\}[\s\S]*?\{embedded && onClose && \([\s\S]*?tooltip=\{t`Close terminal`\}[\s\S]*?onClick=\{onClose\}[\s\S]*?\)\}/,
  );
  expect(embeddedClose, 'embedded close must directly invoke the host callback').not.toBeNull();
  expect(embeddedClose?.[0]).not.toMatch(/process\.(?:exit|close|stop)/);

  expect(toolbar).toContain('{!embedded && <CommitMergeButton');
  expect(toolbar).toContain('{!embedded && <OpenInWorktreeButton');
  expect(toolbar).toMatch(/Open terminal in current folder[\s\S]*?\{!embedded && \([\s\S]*?<SquareTerminal/);
  expect(toolbar).toMatch(/Fork — hidden in embedded mode[\s\S]*?\{!embedded && \([\s\S]*?<GitFork/);
  expect(terminal).toContain('embedded={embedded}');

  const callers = readFileSync(
    join(repo, 'ui/src/components/terminal/interactive-terminal/InteractiveTerminal.tsx'),
    'utf8',
  );
  expect((callers.match(/embedded=\{/g) ?? []).length).toBe(1);
});
