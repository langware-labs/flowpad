import { afterEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosResponse } from 'axios';
import { ActionInfo, dataManager } from '@sdk';
import apiClient from '@sdk/client';
import { ConnectionManager } from '@sdk/websocket';
import { readFlowAnswer, readFlowEnvelope } from '@sdk/FlowSync/flow-call';

const held = { exit_code: 1, ran: false, busy: true, executor: 'agentic_process-test', detail: 'held' };
const info = () => new ActionInfo('run', 'compute_op', '44444444-4444-4444-8444-444444444444', 'POST');
const success = (data: unknown) => ({ status: 'SUCCESS', data });
const failure = (data: unknown) => ({ status: 'FAIL', message: 'held', data });
const httpError = (status: number, data: unknown) => new AxiosError('request failed', undefined, undefined, undefined, { status, data } as AxiosResponse);

afterEach(() => vi.restoreAllMocks());

describe('FlowCall decoding', () => {
  it.each([0, 1, 3, 4, 7])('preserves outcome %i and all result data', (exit_code) => {
    const answer = { exit_code, files: ['report.pdf'], value: { spec_kind: 'example.port', port: 80 }, steps: { child: held }, timed_out: true, reported: true };
    expect(readFlowAnswer(answer)).toBe(answer);
    expect(readFlowEnvelope(success(answer))).toBe(answer);
  });
  it('returns legacy held-slot outcomes, not arbitrary FAIL payloads', () => {
    expect(readFlowEnvelope(failure(held))).toBe(held);
    expect(() => readFlowEnvelope(failure({ exit_code: 7, ran: false }))).toThrow();
    expect(() => readFlowEnvelope(failure({ ...held, ran: true }))).toThrow();
  });
  it.each([null, [], {}, { exit_code: 2 }, { exit_code: '0' }, { exit_code: 0, ran: 'yes' }, { exit_code: 0, value_present: 'yes' }, { exit_code: 0, duration_s: NaN }])('rejects malformed answers: %j', (answer) => {
    expect(() => readFlowAnswer(answer)).toThrow('Invalid FlowCall answer');
  });
});

describe('FlowCall transport selection and compatibility', () => {
  it('returns the same answer over HTTP and WS while raw WS keeps its envelope', async () => {
    const answer = { exit_code: 7, ran: false, detail: 'Refused' };
    vi.spyOn(apiClient, 'post').mockResolvedValue(answer);
    vi.spyOn(ConnectionManager.getInstance(), 'connected', 'get').mockReturnValue(true);
    vi.spyOn(ConnectionManager.getInstance(), 'sendRestApiMessage').mockResolvedValue(success(answer));
    expect(await dataManager.callFlowAction(info())).toEqual(answer);
    expect(await dataManager.callFlowAction(info(), 'ws')).toEqual(answer);
    expect(await dataManager.callActionOverWS(info())).toEqual(success(answer));
  });
  it('unwraps only a valid busy answer from HTTP 409; legacy callers still throw', async () => {
    const error = httpError(409, failure(held));
    vi.spyOn(apiClient, 'post').mockRejectedValue(error);
    expect(await dataManager.callFlowAction(info())).toEqual(held);
    await expect(dataManager.callAction(info())).rejects.toBe(error);
  });
  it.each([401, 403, 422, 500])('preserves HTTP %i even with a busy-shaped body', async (status) => {
    const error = httpError(status, failure(held));
    vi.spyOn(apiClient, 'post').mockRejectedValue(error);
    await expect(dataManager.callFlowAction(info())).rejects.toBe(error);
  });
  it('preserves a malformed 409 and network failures', async () => {
    const send = vi.spyOn(apiClient, 'post');
    for (const error of [httpError(409, failure({})), new Error('offline')]) {
      send.mockRejectedValue(error);
      await expect(dataManager.callFlowAction(info())).rejects.toBe(error);
    }
  });
  it('does not replay a failed mutation over HTTP after choosing WS', async () => {
    vi.spyOn(ConnectionManager.getInstance(), 'connected', 'get').mockReturnValue(true);
    const error = new Error('socket closed after send');
    const ws = vi.spyOn(ConnectionManager.getInstance(), 'sendRestApiMessage').mockRejectedValue(error);
    const http = vi.spyOn(apiClient, 'post');
    await expect(dataManager.callFlowAction(info(), 'prefer-ws')).rejects.toBe(error);
    expect(ws).toHaveBeenCalledTimes(1);
    expect(http).not.toHaveBeenCalled();
  });
  it('chooses HTTP once when prefer-WS starts disconnected', async () => {
    vi.spyOn(ConnectionManager.getInstance(), 'connected', 'get').mockReturnValue(false);
    const http = vi.spyOn(apiClient, 'post').mockResolvedValue(held);
    expect(await dataManager.callFlowAction(info(), 'prefer-ws')).toEqual(held);
    expect(http).toHaveBeenCalledTimes(1);
  });
});
