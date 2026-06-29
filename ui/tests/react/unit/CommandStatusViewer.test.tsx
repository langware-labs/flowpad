import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dataManager, AgenticProcess } from '@sdk';
import { unitTestSetup } from '../../utils/test-utils';
import { CommandStatusViewer } from '@src/components/terminal/interactive-terminal/command-status-viewer/CommandStatusViewer';

const stubProcess = (id = 'p-1') => ({ id }) as unknown as AgenticProcess;

const baseSnapshot = {
  generic: {
    worker_type: 'claude',
    workdir: '/repo',
    session_id: 'sess-1',
    additional_dirs: [],
  },
  worker: {
    workdir: '/repo',
    model: 'claude-sonnet-4-6',
    resume: true,
  },
};

describe('CommandStatusViewer', () => {
  beforeEach(async () => {
    await unitTestSetup();
    vi.restoreAllMocks();
  });

  it('renders "No restart needed" when changed is empty', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      restart_required: false,
      running: true,
      worker_type: 'claude',
      loaded: baseSnapshot,
      current: baseSnapshot,
      changed: [],
    } as any);

    render(<CommandStatusViewer open={true} onClose={() => {}} process={stubProcess()} />);

    await waitFor(() => expect(screen.getByText(/no restart needed/i)).toBeInTheDocument());
    expect(screen.getByText(/claude · running/)).toBeInTheDocument();
  });

  it('renders "Restart required — N fields changed" with correct count', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      restart_required: true,
      running: true,
      worker_type: 'claude',
      loaded: baseSnapshot,
      current: {
        ...baseSnapshot,
        generic: { ...baseSnapshot.generic, workdir: '/repo2' },
        worker: { ...baseSnapshot.worker, model: 'claude-opus-4-7' },
      },
      changed: [
        { section: 'generic', field: 'workdir', loaded: '/repo', current: '/repo2' },
        { section: 'worker', field: 'model', loaded: 'claude-sonnet-4-6', current: 'claude-opus-4-7' },
      ],
    } as any);

    render(<CommandStatusViewer open={true} onClose={() => {}} process={stubProcess()} />);

    await waitFor(() =>
      expect(screen.getByText(/restart required — 2 fields changed/i)).toBeInTheDocument(),
    );
  });

  it('uses singular "field" when exactly one field changed', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      restart_required: true,
      running: true,
      worker_type: 'claude',
      loaded: baseSnapshot,
      current: { ...baseSnapshot, generic: { ...baseSnapshot.generic, workdir: '/x' } },
      changed: [{ section: 'generic', field: 'workdir', loaded: '/repo', current: '/x' }],
    } as any);

    render(<CommandStatusViewer open={true} onClose={() => {}} process={stubProcess()} />);

    await waitFor(() =>
      expect(screen.getByText(/restart required — 1 field changed/i)).toBeInTheDocument(),
    );
  });

  it('highlights only the rows in `changed` with the amber background', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      restart_required: true,
      running: true,
      worker_type: 'claude',
      loaded: baseSnapshot,
      current: { ...baseSnapshot, generic: { ...baseSnapshot.generic, workdir: '/x' } },
      changed: [{ section: 'generic', field: 'workdir', loaded: '/repo', current: '/x' }],
    } as any);

    render(<CommandStatusViewer open={true} onClose={() => {}} process={stubProcess()} />);

    await waitFor(() => expect(screen.getByText(/restart required/i)).toBeInTheDocument());

    // Dialog renders into a portal, so query the whole document, not just container.
    const rows = Array.from(document.querySelectorAll('tr'));
    const workdirRows = rows.filter((r) => /\bworkdir\b/.test(r.textContent ?? ''));
    expect(workdirRows.length).toBeGreaterThan(0);
    // At least one workdir row is highlighted.
    expect(workdirRows.some((r) => r.className.includes('bg-amber-500/10'))).toBe(true);

    // session_id is not in `changed`, so its row must not carry the highlight.
    const sessionRow = rows.find((r) => /session_id/.test(r.textContent ?? ''));
    expect(sessionRow).toBeDefined();
    expect(sessionRow!.className.includes('bg-amber-500/10')).toBe(false);
  });

  it('hides the Loaded column and shows the not-started note when loaded is null', async () => {
    vi.spyOn(dataManager, 'callAction').mockResolvedValue({
      restart_required: false,
      running: false,
      worker_type: 'claude',
      loaded: null,
      current: baseSnapshot,
      changed: [],
    } as any);

    render(<CommandStatusViewer open={true} onClose={() => {}} process={stubProcess()} />);

    await waitFor(() => expect(screen.getByText(/process not started yet/i)).toBeInTheDocument());

    // Dialog renders into a portal, so query the whole document.
    const headers = Array.from(document.querySelectorAll('th')).map((h) => h.textContent);
    expect(headers).not.toContain('Loaded');
    // Current column is still present.
    expect(headers).toContain('Current');
  });

  it('does not fetch when closed', async () => {
    const spy = vi.spyOn(dataManager, 'callAction').mockResolvedValue({} as any);

    render(<CommandStatusViewer open={false} onClose={() => {}} process={stubProcess()} />);

    // Give any pending effects a tick.
    await new Promise((r) => setTimeout(r, 30));
    expect(spy).not.toHaveBeenCalled();
  });
});
