import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import { Agent, AgenticProcess, ComputeOp } from '@sdk';
import apiClient from '@sdk/client';
import { unitTestSetup } from '../utils/test-utils';

beforeEach(unitTestSetup);

const id = '44444444-4444-4444-8444-444444444444';
const accepted = { exit_code: 0, ran: true, executor: `agentic_process-${id}`, detail: 'Accepted' };
const busy = { ...accepted, exit_code: 1, ran: false, busy: true, detail: 'Busy' };
const conflict = () => new AxiosError('busy', undefined, undefined, undefined, {
  status: 409, data: { status: 'FAIL', data: busy },
} as AxiosResponse);
afterEach(() => vi.restoreAllMocks());

it('sendTurn returns admission before completion, without an optimistic echo', async () => {
  const process = new AgenticProcess({ id });
  const echo = vi.spyOn(process, 'appendUserMessage');
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue(accepted);
  expect(await process.sendTurn('hello', { workerSessionId: 'session' })).toEqual(accepted);
  expect(post.mock.calls[0][1]).toEqual({ instruction: 'hello', worker_session_id: 'session' });
  expect(echo).not.toHaveBeenCalled();
});

it('sendTurn returns busy while executeInstruction retains the original HTTP error', async () => {
  const error = conflict();
  vi.spyOn(apiClient, 'post').mockRejectedValue(error);
  const process = new AgenticProcess({ id });
  expect(await process.sendTurn('hello')).toEqual(busy);
  await expect(process.executeInstruction('hello', { sync: false })).rejects.toBe(error);
});

it('executeInstruction still waits for completion when sync is true', async () => {
  vi.spyOn(apiClient, 'post').mockResolvedValue(accepted);
  const process = new AgenticProcess({ id });
  let listening!: () => void;
  const subscribed = new Promise<void>((resolve) => { listening = resolve; });
  const on = process.on.bind(process);
  vi.spyOn(process, 'on').mockImplementation((event, listener) => {
    const unsubscribe = on(event, listener);
    if (event === 'complete') listening();
    return unsubscribe;
  });
  let completed = false;
  const execution = process.executeInstruction('hello').then(() => { completed = true; });
  await subscribed;
  expect(completed).toBe(false);
  process.emit('complete');
  await execution;
  expect(completed).toBe(true);
});

it('Agent.launch preserves busy and Agent.run retains its throwing behavior', async () => {
  const error = conflict();
  const post = vi.spyOn(apiClient, 'post').mockRejectedValue(error);
  const agent = new Agent({ id });
  expect(await agent.launch('hello')).toEqual(busy);
  await expect(agent.run('hello')).rejects.toBe(error);
  expect(post.mock.calls.map((args) => args[1])).toEqual([{ prompt: 'hello' }, { prompt: 'hello' }]);
});

it('ComputeOp returns validated check and run answers', async () => {
  const op = new ComputeOp({ id });
  vi.spyOn(apiClient, 'get').mockResolvedValue({ exit_code: 0, returncode: 0, stdout: 'ready' });
  vi.spyOn(apiClient, 'post').mockResolvedValue({ exit_code: 7, ran: false, detail: 'Refused' });
  expect((await op.check()).stdout).toBe('ready');
  expect((await op.run(false)).exit_code).toBe(7);
});

it('ComputeOp typed calls preserve lists, null, omitted input and the legacy run body', async () => {
  const op = new ComputeOp({ id });
  const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ exit_code: 0, value: [], value_present: true });
  expect((await op.call<string[]>([], { approved: true })).value).toEqual([]);
  await op.call(null);
  await op.call();
  await op.run(true);
  expect(post.mock.calls.map((args) => args[1])).toEqual([
    { approved: true, answer_tagged: true, input: [] }, { approved: false, answer_tagged: true, input: null },
    { approved: false, answer_tagged: true }, { approved: true },
  ]);
});
