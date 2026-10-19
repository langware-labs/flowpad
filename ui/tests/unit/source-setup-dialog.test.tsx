/**
 * A source's Setup dialog, for any driver: it starts the source's own setup run on open, draws the run's
 * question in place, closes itself when the run it followed ends set up, and stays — with why, and a way
 * to run it again — when the run stops short or cannot start.
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectSetupRun, SetupTreeResult } from '@sdk';
import { fakeSource } from './fake-source';

vi.mock('@src/components/ask/ask-claims', () => ({
  claimAskRun: () => () => {},
  openQuestionOf: async () => 'q-1',
}));
vi.mock('@src/components/ask/AskForm', () => ({
  AskForm: ({ questionId }: { questionId: string }) => <div data-testid="ask-form">{questionId}</div>,
}));

import { SourceSetupDialog } from '@src/components/setup-wizard/SourceSetupDialog';
import { SETUP_POLL_MS } from '@src/components/project-setup/use-setup-run';

const tree = (state: 'done' | 'failed' | 'running', detail = ''): SetupTreeResult => ({
  state,
  detail,
  total: 1,
  done: state === 'done' ? 1 : 0,
  ran: true,
  root: { id: 'data_source-1', label: 'work mail', level: 0, state, detail, prepare: null, run: null, children: [], shared: false },
});

/** A source whose run reads as `states`, one per look (the last one repeats). */
function sourceWhoseRunReads(...states: ProjectSetupRun[]) {
  const source = fakeSource('work mail', 'gmail');
  const startSetup = vi.fn(async () => 'run/1');
  let look = 0;
  source.startSetup = startSetup;
  source.setupRun = async () => states[Math.min(look++, states.length - 1)];
  return { source, startSetup };
}

const idle: ProjectSetupRun = { run: 'run/1', running: false, tree: null };
const going: ProjectSetupRun = { run: 'run/1', running: true, tree: tree('running') };
const tick = () => act(() => vi.advanceTimersByTimeAsync(SETUP_POLL_MS));

describe('SourceSetupDialog', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('starts the source’s setup on open and draws its question in place', async () => {
    const { source, startSetup } = sourceWhoseRunReads(idle, going);
    render(<SourceSetupDialog source={source} onClose={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(startSetup).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('source-setup-running')).toBeTruthy();
    expect(screen.getByTestId('ask-form').textContent).toBe('q-1');
    expect(screen.queryByTestId('setup-tree')).toBeNull(); // no tree claiming "set up" beside an open question
  });

  it('says Connected, in the check’s own words, once the run it followed ends set up; Done closes it', async () => {
    const said = tree('done');
    said.root!.run = { exit_code: 0, steps: { verify: { exit_code: 0, detail: 'Reading me@gmail.com.' } } };
    const { source } = sourceWhoseRunReads(idle, { ...idle, tree: said });
    const onClose = vi.fn();
    render(<SourceSetupDialog source={source} onClose={onClose} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await tick();
    expect(screen.getByTestId('source-setup-connected').textContent).toBe('Connected — reading me@gmail.com');
    expect(screen.getByTestId('source-setup-finished').textContent).toContain('1 of 1 set up');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('source-setup-done'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a check that said nothing of its own names the account the source reads', async () => {
    const { source } = sourceWhoseRunReads(idle, { ...idle, tree: tree('done') });
    source.account_key = 'me@gmail.com';
    render(<SourceSetupDialog source={source} onClose={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await tick();
    expect(screen.getByTestId('source-setup-connected').textContent).toBe('Connected — reading me@gmail.com');
  });

  it('while the source’s own check runs, says it is checking the sign-in', async () => {
    const checking = tree('running');
    const { source } = sourceWhoseRunReads({ ...going, tree: checking });
    render(<SourceSetupDialog source={source} onClose={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByTestId('source-setup-running').textContent).toBe('Checking the sign-in…');
  });

  it('a tree an earlier run left set up does not close a dialog that has not run yet', async () => {
    const { source } = sourceWhoseRunReads({ ...idle, tree: tree('done') });
    source.startSetup = () => new Promise<string>(() => {});
    const onClose = vi.fn();
    render(<SourceSetupDialog source={source} onClose={onClose} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('a run that stops short stays open with why, and offers to set up again', async () => {
    const { source, startSetup } = sourceWhoseRunReads(idle, { ...idle, tree: tree('failed', 'Gmail refused the login') });
    const onClose = vi.fn();
    render(<SourceSetupDialog source={source} onClose={onClose} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await tick();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('setup-tree').textContent).toContain('Gmail refused the login');
    fireEvent.click(screen.getByTestId('source-setup-retry'));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(startSetup).toHaveBeenCalledTimes(2);
  });

  it('a setup that cannot start says why, in the server’s words', async () => {
    const { source } = sourceWhoseRunReads(idle);
    source.startSetup = async () => {
      throw Object.assign(new Error('Request failed with status code 409'), {
        response: { data: { message: 'This source belongs to no project.' } },
      });
    };
    render(<SourceSetupDialog source={source} onClose={() => {}} />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(screen.getByTestId('source-setup-refused').textContent).toBe('This source belongs to no project.');
    expect(screen.getByTestId('source-setup-retry')).toBeTruthy();
  });
});
