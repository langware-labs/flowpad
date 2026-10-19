/**
 * A hub-launched sandbox pauses on E2B's idle timer and auto-resumes on the
 * next request — but the resume is not instant. A request that lands in that
 * window gets a 502 straight from E2B's own edge, with the body "the sandbox
 * is running but port is not open" (never reaches our backend, whose own
 * errors are never a 502). Reproduced live on prod compute_node
 * f41f5c42-a8fa-4934-8cda-9080f09d24bd: a `POST /cloud/login` that landed in
 * that window failed outright with zero retry, leaving the user stuck.
 *
 * `getApiClient()`'s response interceptor now retries a 502 a couple of
 * times with a short delay before giving up — these tests drive that
 * through a fake axios adapter (no real network), so they exercise the
 * actual interceptor code, not a re-implementation of it.
 */
import { getApiClient } from '@sdk';
import type { AxiosRequestConfig } from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

function fakeResponse(config: AxiosRequestConfig, status: number, data: unknown) {
  return {
    data,
    status,
    statusText: status === 200 ? 'OK' : 'Bad Gateway',
    headers: {},
    config,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('apiClient retries a 502 while a sandbox wakes from pause', () => {
  it('retries transparently and resolves once the sandbox answers', async () => {
    vi.useFakeTimers();
    const client = getApiClient();
    let calls = 0;
    client.defaults.adapter = vi.fn((config: AxiosRequestConfig) => {
      calls += 1;
      if (calls < 3) {
        const err = new Error('Request failed with status code 502') as Error & {
          response: unknown;
          config: AxiosRequestConfig;
          isAxiosError: boolean;
        };
        err.response = fakeResponse(config, 502, {
          detail: 'the sandbox is running but port is not open',
        });
        err.config = config;
        err.isAxiosError = true;
        return Promise.reject(err);
      }
      return Promise.resolve(fakeResponse(config, 200, { status: 'SUCCESS', data: { ok: true } }));
    });

    const promise = client.get('/api/v1/cloud/status');
    // Two retries, 300ms then 800ms — flush both without a real wait.
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(800);

    await expect(promise).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  it('gives up after its retry budget and surfaces the last 502', async () => {
    vi.useFakeTimers();
    const client = getApiClient();
    let calls = 0;
    client.defaults.adapter = vi.fn((config: AxiosRequestConfig) => {
      calls += 1;
      const err = new Error('Request failed with status code 502') as Error & {
        response: unknown;
        config: AxiosRequestConfig;
        isAxiosError: boolean;
      };
      err.response = fakeResponse(config, 502, { detail: 'still not open' });
      err.config = config;
      err.isAxiosError = true;
      return Promise.reject(err);
    });

    const promise = client.get('/api/v1/cloud/status');
    const assertion = expect(promise).rejects.toMatchObject({ response: { status: 502 } });
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(800);
    await assertion;

    // The 2 retries this file's fix allows, plus the original attempt.
    expect(calls).toBe(3);
  });

  it('does NOT retry a plain 500 — only the sandbox-waking 502 shape', async () => {
    vi.useFakeTimers();
    const client = getApiClient();
    let calls = 0;
    client.defaults.adapter = vi.fn((config: AxiosRequestConfig) => {
      calls += 1;
      const err = new Error('Request failed with status code 500') as Error & {
        response: unknown;
        config: AxiosRequestConfig;
        isAxiosError: boolean;
      };
      err.response = fakeResponse(config, 500, { detail: 'a real backend error' });
      err.config = config;
      err.isAxiosError = true;
      return Promise.reject(err);
    });

    await expect(client.get('/api/v1/cloud/status')).rejects.toMatchObject({ response: { status: 500 } });
    expect(calls).toBe(1);
  });
});
