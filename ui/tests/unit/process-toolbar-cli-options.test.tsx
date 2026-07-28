/**
 * C16 — vendor-aware ProcessToolbar surfaces, rendered end-to-end.
 *
 * A Codex process must show ONLY the controls the codex CLI supports: the CLI
 * Options dropdown carries a single Full Trust item (codex bypass flag, OpenAI
 * docs link) — no Chrome / Debug toggles, no Anthropic links — and Session Info
 * hides the Chrome/Debug/Worktree rows and shows a `codex … resume <session>`
 * command. A Claude process must keep the exact pre-vendor-split surface. An
 * unknown worker gets no CLI Options dropdown at all.
 *
 * The toolbar is rendered for real (chrome-only siblings stubbed); the vendor
 * knowledge itself lives in process-cli-presentation.ts and is consumed here
 * through the real gating in ProcessToolbar.
 */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ProcessStatus, type AgenticProcess, type Shell } from '@sdk';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Sibling chrome that is not under test — stubbed to keep the mount light.
vi.mock('@src/components/terminal/interactive-terminal/WorktreeButtons', () => ({
  CommitMergeButton: () => null,
  OpenInWorktreeButton: () => null,
}));
vi.mock('@src/components/entity-actions/EntityActionsToolbar', () => ({ EntityActionsToolbar: () => null }));
vi.mock('@src/components/entity-actions/ExportEntityButton', () => ({ ExportEntityButton: () => null }));
vi.mock('@src/components/asset-manager', () => ({ AssetManagerButton: () => null }));
vi.mock('@src/components/view-mode', () => ({
  ViewSwap: ({ advanced }: { advanced: React.ReactNode }) => <>{advanced}</>,
}));
// The header is pure arrangement — render every slot so the real toolbar
// content (CLI Options, Session Info, …) stays in the tree.
vi.mock('@src/components/terminal/interactive-terminal/InteractiveTabHeader', () => ({
  AdvancedInteractiveTabHeader: (p: Record<string, React.ReactNode>) => (
    <div>
      {p.debug}
      {p.restart}
      {p.title}
      {p.actions}
      {p.download}
      {p.right}
    </div>
  ),
  StandardInteractiveTabHeader: () => null,
}));
vi.mock('@src/components/terminal/interactive-terminal/pty-viewer', () => ({ PTYViewer: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/pty-events-viewer', () => ({ PTYEventsViewer: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/command-status-viewer', () => ({
  CommandStatusViewer: () => null,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: {} }) }));
// SessionInfoPopover discovers the on-disk session record on mount — no
// backend in this tier.
vi.mock('@sdk/resource_management/fs_records/claude/claude-session.js', () => ({
  ClaudeSessionRecord: { discover: () => Promise.resolve(null) },
}));

import { ProcessToolbar } from '@src/components/terminal/interactive-terminal/ProcessToolbar';

const SESSION_ID = '019abcde-1234-4000-8000-abcdefabcdef';

function makeProcess(workerType: string): AgenticProcess {
  return {
    id: 'f3b2a4c1-6d5e-4f7a-8b9c-0d1e2f3a4b5c',
    typeId: `agentic_process:${workerType}-toolbar-test`,
    status: ProcessStatus.RUNNING,
    workerStatus: undefined,
    restart_required: false,
    session_id: SESSION_ID,
    worker_type: workerType,
    workdir: '/tmp/proj',
    pty_pid: null,
    name: 'Toolbar test process',
    cliOptions: {
      chrome: false,
      debug: false,
      worktree: false,
      permission_mode: 'bypassPermissions',
      model: null,
    },
    save: () => Promise.resolve(),
  } as unknown as AgenticProcess;
}

const TRACE_FILTERS = {
  events: false,
  time: false,
  index: false,
  line: false,
  absLine: false,
  debugTime: false,
  refTime: false,
  promptAnnotations: false,
};
const COL_VIS = { trace: true, time: true, annotations: true };

function renderToolbar(workerType: string) {
  return render(
    <ProcessToolbar
      process={makeProcess(workerType)}
      traceFilters={TRACE_FILTERS}
      onTraceFiltersChange={() => {}}
      colVis={COL_VIS}
      onColVisChange={() => {}}
      embedded
      shell={null as unknown as Shell}
    />,
  );
}

afterEach(() => cleanup());

describe('ProcessToolbar — vendor-gated CLI Options dropdown', () => {
  it('codex: only Full Trust, codex flag description, OpenAI docs — no Anthropic surface', async () => {
    renderToolbar('codex');

    await userEvent.click(screen.getByRole('button', { name: 'CLI Options' }));

    // Only the codex-supported toggle is offered.
    expect(screen.getByText('Full Trust')).toBeTruthy();
    expect(screen.queryByText('Chrome browser')).toBeNull();
    expect(screen.queryByText('Debug logging')).toBeNull();

    // Codex flag wording, OpenAI docs — and NO Anthropic link anywhere.
    expect(screen.getByText('Skip approvals and sandboxing (--dangerously-bypass-approvals-and-sandbox)')).toBeTruthy();
    const docsLink = screen.getByRole('link', { name: 'Full Trust docs' });
    expect(docsLink.href).toContain('developers.openai.com/codex');
    const anthropicLinks = Array.from(document.querySelectorAll('a')).filter((a) =>
      a.href.includes('anthropic.com'),
    );
    expect(anthropicLinks).toEqual([]);
  });

  it('claude: keeps the full pre-split surface — Chrome, Full Trust, Debug, Anthropic docs', async () => {
    renderToolbar('claude');

    await userEvent.click(screen.getByRole('button', { name: 'CLI Options' }));

    expect(screen.getByText('Chrome browser')).toBeTruthy();
    expect(screen.getByText('Full Trust')).toBeTruthy();
    expect(screen.getByText('Debug logging')).toBeTruthy();
    expect(screen.getByText('Skip all permission prompts (--dangerously-skip-permissions)')).toBeTruthy();
    const trustDocs = screen.getByRole('link', { name: 'Full Trust docs' });
    expect(trustDocs.href).toContain('docs.anthropic.com');
  });

  it('unknown worker: no CLI Options dropdown at all', () => {
    renderToolbar('custom-worker');
    expect(screen.queryByRole('button', { name: 'CLI Options' })).toBeNull();
  });
});

describe('ProcessToolbar — vendor-gated Session Info popover', () => {
  it('codex: hides Chrome/Debug/Worktree rows and shows the codex resume command', async () => {
    renderToolbar('codex');

    await userEvent.click(screen.getByRole('button', { name: 'Codex session info' }));

    expect(screen.queryByText('Chrome')).toBeNull();
    expect(screen.queryByText('Debug')).toBeNull();
    expect(screen.queryByText('Worktree')).toBeNull();
    expect(
      screen.getByText(`cd '/tmp/proj' && codex --dangerously-bypass-approvals-and-sandbox resume ${SESSION_ID}`),
    ).toBeTruthy();
  });

  it('claude: keeps all rows and the claude --resume command', async () => {
    renderToolbar('claude');

    await userEvent.click(screen.getByRole('button', { name: 'Claude session info' }));

    expect(screen.getByText('Chrome')).toBeTruthy();
    expect(screen.getByText('Debug')).toBeTruthy();
    expect(screen.getByText('Worktree')).toBeTruthy();
    expect(
      screen.getByText(`cd '/tmp/proj' && claude --dangerously-skip-permissions --resume ${SESSION_ID}`),
    ).toBeTruthy();
  });
});
