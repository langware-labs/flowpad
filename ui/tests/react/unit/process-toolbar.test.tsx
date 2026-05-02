import { AgenticProcess, TypeId } from '@sdk';
import { render, fireEvent } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTerminalName } from '@src/components/terminal/TabbedTerminal';
import type { TraceFilters, ColVisibility } from '@src/components/terminal/interactive-terminal/InteractiveTerminal';
import { ProcessToolbar } from '@src/components/terminal/interactive-terminal/ProcessToolbar';

const mockOpenNewShell = vi.fn();

vi.mock('@src/navigation/useDockNavigation', () => ({
  useDockNavigation: () => ({
    navigation: { openNewShell: mockOpenNewShell, openShell: vi.fn(), openShellProcess: vi.fn() },
  }),
}));

function makeProcess(overrides: Partial<AgenticProcess> = {}): AgenticProcess {
  return {
    id: 'proc-1',
    typeId: new TypeId('agentic_process', 'proc-1'),
    session_id: 'session-1',
    pty_pid: 'pty-1',
    workdir: '/home/user/project',
    cliOptions: { chrome: false, permission_mode: 'askUser', debug: false },
    status: 'running',
    save: vi.fn(),
    fork: vi.fn().mockResolvedValue({ id: 'forked-proc-1' }),
    ...overrides,
  } as unknown as AgenticProcess;
}

/** Find the "Open terminal" button by looking for the SquareTerminal icon inside the toolbar */
function getOpenTerminalButton(container: HTMLElement): HTMLButtonElement {
  const toolbar = container.querySelector('[data-testid="process-toolbar"]')!;
  const terminalIcon = toolbar.querySelector('.lucide-square-terminal')!;
  return terminalIcon.closest('button')! as HTMLButtonElement;
}

const defaultTraceFilters: TraceFilters = { events: true, time: false, index: false, line: false, absLine: false, debugTime: false, refTime: false, promptAnnotations: false };
const defaultColVis: ColVisibility = { trace: true, time: true, annotations: true };

describe('ProcessToolbar "Open terminal" button', () => {
  beforeEach(() => {
    mockOpenNewShell.mockClear();
  });

  it('opens a new terminal with cwd when workdir is set', () => {
    const process = makeProcess();
    const { container } = render(
      <ProcessToolbar
        process={process}
        traceFilters={defaultTraceFilters}
        onTraceFiltersChange={vi.fn()}
        colVis={defaultColVis}
        onColVisChange={vi.fn()}
      />
    );

    fireEvent.click(getOpenTerminalButton(container));

    expect(mockOpenNewShell).toHaveBeenCalledWith({ cwd: '/home/user/project' });
  });

  it('opens a new terminal without cwd when workdir is empty', () => {
    const process = makeProcess({ workdir: undefined });
    const { container } = render(
      <ProcessToolbar
        process={process}
        traceFilters={defaultTraceFilters}
        onTraceFiltersChange={vi.fn()}
        colVis={defaultColVis}
        onColVisChange={vi.fn()}
      />
    );

    fireEvent.click(getOpenTerminalButton(container));

    expect(mockOpenNewShell).toHaveBeenCalledWith({ cwd: undefined });
  });
});

describe('nextTerminalName', () => {
  it('returns "Tab 1" when no sessions exist', () => {
    expect(nextTerminalName([])).toBe('Tab 1');
  });

  it('returns next sequential number', () => {
    const sessions = [{ name: 'Tab 1' }, { name: 'Tab 2' }];
    expect(nextTerminalName(sessions)).toBe('Tab 3');
  });

  it('fills gaps from closed tabs', () => {
    const sessions = [{ name: 'Tab 1' }, { name: 'Tab 3' }];
    expect(nextTerminalName(sessions)).toBe('Tab 2');
  });

  it('ignores non-tab names', () => {
    const sessions = [{ name: 'Claude CLI' }, { name: 'Tab 1' }];
    expect(nextTerminalName(sessions)).toBe('Tab 2');
  });
});
