import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ openSources: vi.fn() }));
vi.mock('@src/navigation/useDockNavigation', () => ({ useDockNavigation: () => ({ navigation: {} }) }));
vi.mock('@src/components/llm-sources/llm-sources-pointer', () => ({ openLlmSources: h.openSources }));
vi.mock('@src/components/terminal/openers/AskInstallOneOfDialog', () => ({ AskInstallOneOfDialog: () => null }));

import { FlowData } from '@sdk/flow_processing/flow-data';
import { FlowElementTypes } from '@sdk/flow_processing/flow-element-types';
import { groupTurnEvents } from '@src/components/floating-chat/groupTurnEvents';
import { TurnGroupsList } from '@src/components/entity-execution-panel/TurnGroupsList';
import * as LF from '@src/components/launch-failure/LaunchFailureCard';

afterEach(cleanup);
const refused = (lf: object) => ({ response: { data: { data: { launch_failure: { ...lf } } } } });
const msg = (message: string) => ({ response: { data: { message } } });
const fix = () => screen.getByTestId('launch-failure-fix');
const card = (lf: object, retry = vi.fn().mockResolvedValue(0), process?: object) =>
  render(<LF.LaunchFailureCard failure={LF.readLaunchFailure(refused(lf))!} retry={retry} process={process as any} />);

describe('launch failure', () => {
  it.each<[string, unknown, string | null]>([
    ['typed', refused({ code: 'key_rejected' }), 'key_rejected'],
    ['process', { launch_failure: { code: 'cli_crashed' } }, 'cli_crashed'],
    ['alias', refused({ code: 'not_authenticated' }), 'signed_out'],
    ['legacy unfunded', msg('claude has no usable LLM source:'), 'signed_out'],
    ['legacy missing', msg('Claude CLI is not installed on this machine.'), 'not_installed'],
    ['unrelated', msg('Workspace is read-only.'), null],
  ])('reads %s', (_, src, code) => expect(LF.readLaunchFailure(src)?.code ?? null).toBe(code));

  it.each<[object, string, string]>([
    [{ code: 'folder_not_trusted', fix: 'trust_folder', facts: { folder: '/w/proj' } }, 'Trust folder proj?', 'Trust'],
    [{ code: 'first_run_setup', fix: 'finish_setup' }, 'Claude needs a one-time setup', 'Finish setup'],
    [{ code: 'signed_out', fix: 'connect' }, "Claude isn't connected to an account", 'Connect'],
    [{ code: 'key_rejected', fix: 'replace_key', facts: { provider: 'X' } }, 'X key **** was rejected', 'Replace key'],
    [{ code: 'not_installed', fix: 'install' }, "Claude isn't installed on this computer", 'Install'],
    [{ code: 'cli_crashed', fix: 'reinstall' }, 'Claude crashed on start', 'Reinstall'],
    [{ code: 'whatever' }, "Claude couldn't start", 'Try again'],
  ])('card %o', (lf, title, button) => {
    card(lf);
    expect([screen.getByTestId('launch-failure-title').textContent, fix().textContent]).toEqual([title, button]);
  });

  it('server fix via the process (headless relaunched:false retries); UI fix hands off then retries', async () => {
    const retry = vi.fn().mockResolvedValue(0);
    const resolveLaunchFailure = vi.fn().mockResolvedValue({ relaunched: false });
    card({ code: 'folder_not_trusted', fix: 'trust_folder', phase: 'blocked' }, retry, { resolveLaunchFailure });
    fireEvent.click(fix());
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
    expect(resolveLaunchFailure).toHaveBeenCalledWith('trust_folder');
    cleanup();
    card({ code: 'signed_out', fix: 'connect' }, retry);
    fireEvent.click(fix());
    await waitFor(() => expect(fix().textContent).toBe('Try again'));
    expect(h.openSources).toHaveBeenCalledWith({}, 'claude_code');
    fireEvent.click(fix());
    await waitFor(() => expect(retry).toHaveBeenCalledTimes(2));
  });

  it('budget wait retries on its own, then becomes the signed-out card', () => {
    vi.useFakeTimers();
    const retry = vi.fn().mockResolvedValue(0);
    card({ code: 'budget_not_ready' }, retry);
    act(() => void vi.advanceTimersByTime(LF.BUDGET_WAIT_MS));
    expect([retry.mock.calls.length, fix().textContent]).toEqual([2, 'Connect']);
    vi.useRealTimers();
  });

  it('an exit-error frame is its own chat row; its retry re-sends the prompt', async () => {
    const user = new FlowData(FlowElementTypes.USER_MESSAGE, 'add a toggle', { i: '0', role: 'user' });
    const exit = new FlowData(FlowElementTypes.STATUS, 'exit 1', { i: '1', subtype: 'exit-error' });
    const process = { worker_type: 'claude_code', start: vi.fn().mockResolvedValue(1), prompt: vi.fn() };
    render(<TurnGroupsList groups={groupTurnEvents([user, exit])} process={process as never} />);
    fireEvent.click(fix());
    await waitFor(() => expect(process.prompt).toHaveBeenCalledWith('add a toggle'));
  });
});
