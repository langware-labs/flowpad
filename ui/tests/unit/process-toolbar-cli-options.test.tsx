/**
 * C16 — vendor-aware ProcessToolbar surfaces, rendered end-to-end.
 *
 * A Codex process must show ONLY the controls the codex CLI supports: the debug
 * menu's CLI options carry a single Full Trust item (codex bypass flag, OpenAI
 * docs link) — no Chrome / Debug toggles, no Anthropic links — and Session Info
 * hides the Chrome/Debug/Worktree rows and shows a `codex … resume <session>`
 * command. A Claude process must keep the exact pre-vendor-split surface. An
 * unknown worker gets no CLI options section at all.
 *
 * Also the bar's one arrangement: the debug menu on the terminal surface only,
 * and every other action in the session actions menu on every surface.
 *
 * The toolbar is rendered for real (chrome-only siblings stubbed); the vendor
 * knowledge itself lives in process-cli-presentation.ts and is consumed here
 * through the real gating in ProcessToolbar.
 */
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { dataManager, ProcessStatus, type AgenticProcess, type Shell } from '@sdk';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Sibling chrome that is not under test — stubbed to keep the mount light.
vi.mock('@src/components/terminal/interactive-terminal/use-worktree-actions', () => ({
  useCommitMerge: () => ({ available: false, working: false, run: () => {} }),
  useOpenInWorktree: () => ({ loading: false, hasCommit: true, open: () => Promise.resolve() }),
}));
vi.mock('@src/components/terminal/interactive-terminal/EntityShareDialog', () => ({ EntityShareDialog: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/SessionSurfaceSwitch', () => ({
  SessionSurfaceSwitch: () => null,
}));
vi.mock('@src/components/asset-manager', () => ({ AssetManagerButton: () => null }));
// The surface on screen — the debug menu is offered on the terminal one only.
const viewMode = vi.hoisted(() => ({ current: 'advanced' }));
vi.mock('@src/contexts/view-mode-context', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@src/contexts/view-mode-context')>();
  return { ...actual, useSessionSurface: () => actual.surfaceForViewMode(viewMode.current as never) };
});
vi.mock('@src/components/terminal/interactive-terminal/pty-viewer', () => ({ PTYViewer: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/pty-events-viewer', () => ({ PTYEventsViewer: () => null }));
vi.mock('@src/components/terminal/interactive-terminal/command-status-viewer', () => ({
  CommandStatusViewer: () => null,
}));
vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({ navigation: {} }),
  useCurrentDock: () => null,
}));
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

function renderToolbar(workerType: string, process = makeProcess(workerType), embedded = true) {
  return render(
    <ProcessToolbar
      process={process}
      traceFilters={TRACE_FILTERS}
      onTraceFiltersChange={() => {}}
      colVis={COL_VIS}
      onColVisChange={() => {}}
      embedded={embedded}
      shell={null as unknown as Shell}
    />,
  );
}

afterEach(() => {
  cleanup();
  viewMode.current = 'advanced';
});

const openDebug = () => userEvent.click(screen.getByRole('button', { name: 'Debug' }));
const openActions = () => userEvent.click(screen.getByRole('button', { name: 'Session actions' }));
const openSessionInfo = async () => {
  await openActions();
  await userEvent.click(screen.getByRole('menuitem', { name: /Session info/ }));
};

describe('ProcessToolbar — vendor-gated CLI options in the debug menu', () => {
  it('codex: only Full Trust, codex flag description, OpenAI docs — no Anthropic surface', async () => {
    renderToolbar('codex');

    await openDebug();

    // Only the codex-supported toggle is offered.
    expect(screen.getByText('Full Trust')).toBeTruthy();
    expect(screen.queryByText('Chrome browser')).toBeNull();
    expect(screen.queryByText('Debug logging')).toBeNull();

    // Codex flag wording, OpenAI docs — and NO Anthropic link anywhere.
    expect(screen.getByText('Skip approvals and sandboxing (--dangerously-bypass-approvals-and-sandbox)')).toBeTruthy();
    const docsLink = screen.getByRole('link', { name: 'Full Trust docs' });
    expect(docsLink.href).toContain('developers.openai.com/codex');
    const anthropicLinks = Array.from(document.querySelectorAll('a')).filter((a) => a.href.includes('anthropic.com'));
    expect(anthropicLinks).toEqual([]);
  });

  it('claude: keeps the full pre-split surface — Chrome, Full Trust, Debug, Anthropic docs', async () => {
    renderToolbar('claude');

    await openDebug();

    expect(screen.getByText('Chrome browser')).toBeTruthy();
    expect(screen.getByText('Full Trust')).toBeTruthy();
    expect(screen.getByText('Debug logging')).toBeTruthy();
    expect(screen.getByText('Skip all permission prompts (--dangerously-skip-permissions)')).toBeTruthy();
    const trustDocs = screen.getByRole('link', { name: 'Full Trust docs' });
    expect(trustDocs.href).toContain('docs.anthropic.com');
  });

  it('unknown worker: the debug menu has no CLI options section, only gutters and viewers', async () => {
    renderToolbar('custom-worker');

    await openDebug();

    expect(screen.queryByText('CLI Options')).toBeNull();
    expect(screen.getByText('Gutters')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'PTY Viewer' })).toBeTruthy();
  });
});

describe('ProcessToolbar — one bar for every surface', () => {
  const standalone = (mode: string) => {
    viewMode.current = mode;
    renderToolbar('claude', makeProcess('claude'), false);
  };

  it('terminal: debug menu on the left, Fork and the session actions menu on the right', () => {
    standalone('advanced');
    expect(screen.getByRole('button', { name: 'Debug' })).toBeTruthy();
    expect(screen.getByTestId('process-toolbar-fork')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Session actions' })).toBeTruthy();
  });

  it.each(['standard', 'vibe'])('%s: no debug menu, the same Fork and session actions menu', (mode) => {
    standalone(mode);
    expect(screen.queryByRole('button', { name: 'Debug' })).toBeNull();
    expect(screen.getByTestId('process-toolbar-fork')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Session actions' })).toBeTruthy();
  });

  it('the session actions menu carries every action the old icon row had', async () => {
    standalone('standard');

    await openActions();

    const items = screen.getAllByRole('menuitem').map((el) => el.getAttribute('data-testid'));
    expect(items).toEqual([
      'session-action-info',
      'session-action-transcript',
      'session-action-assets',
      'process-toolbar-restart',
      'session-action-terminal',
      'session-action-worktree',
      'entity-actions-export',
    ]);
  });

  it('embedded: no nav-out actions in the menu, and no Fork', async () => {
    renderToolbar('claude');
    expect(screen.queryByTestId('process-toolbar-fork')).toBeNull();

    await openActions();

    const items = screen.getAllByRole('menuitem').map((el) => el.getAttribute('data-testid'));
    expect(items).toEqual([
      'session-action-info',
      'session-action-transcript',
      'session-action-assets',
      'process-toolbar-restart',
    ]);
  });

  it('restart required: the closed menu button carries the signal', () => {
    renderToolbar('claude', { ...makeProcess('claude'), restart_required: true } as AgenticProcess);
    expect(screen.getByTestId('process-toolbar-menu').getAttribute('data-restart-required')).toBe('true');
  });

  it('Restart session restarts the process', async () => {
    const restart = vi.fn(() => Promise.resolve());
    renderToolbar('claude', { ...makeProcess('claude'), restart } as unknown as AgenticProcess);

    await openActions();
    await userEvent.click(screen.getByTestId('process-toolbar-restart'));

    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe('ProcessToolbar — vendor-gated Session Info popover', () => {
  it('codex: hides Chrome/Debug/Worktree rows and shows the codex resume command', async () => {
    renderToolbar('codex');

    await openSessionInfo();

    expect(screen.queryByText('Chrome')).toBeNull();
    expect(screen.queryByText('Debug')).toBeNull();
    expect(screen.queryByText('Worktree')).toBeNull();
    expect(
      screen.getByText(`cd '/tmp/proj' && codex --dangerously-bypass-approvals-and-sandbox resume ${SESSION_ID}`),
    ).toBeTruthy();
  });

  it('claude: keeps all rows and the claude --resume command', async () => {
    renderToolbar('claude');

    await openSessionInfo();

    expect(screen.getByText('Chrome')).toBeTruthy();
    expect(screen.getByText('Debug')).toBeTruthy();
    expect(screen.getByText('Worktree')).toBeTruthy();
    expect(
      screen.getByText(`cd '/tmp/proj' && claude --dangerously-skip-permissions --resume ${SESSION_ID}`),
    ).toBeTruthy();
  });
});

it('updates the header for a name-only entity notification after status settles', () => {
  const process = makeProcess('claude');
  let notify = () => {};
  const subscription = vi.spyOn(dataManager, 'subscribe').mockImplementation((_id, callback) => {
    notify = () => callback(process as never);
    return () => {};
  });
  try {
    renderToolbar('claude', process, false);
    expect(screen.getByTestId('process-header-name').textContent).toBe('Toolbar test process');
    act(() => {
      process.name = 'Native title after the answer';
      notify();
    });
    expect(screen.getByTestId('process-header-name').textContent).toBe('Native title after the answer');
  } finally {
    cleanup();
    subscription.mockRestore();
  }
});
