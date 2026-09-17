/**
 * `/launch?agent=` with the REAL signed-in agent read.
 *
 * `launch-landing.test.tsx` stubs `useEntity`, so it states what the page does with each answer
 * but cannot prove the answer reaches the page. This file keeps `useEntity` and the SDK store and
 * fakes only the wire (`apiClient.get`), the way staging answers an agent the caller cannot see:
 * `403 target_not_found`. Signed in, that must end in a visible "can't launch" error.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { AxiosError, type AxiosResponse } from 'axios';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ createSandbox: vi.fn(), launchSandbox: vi.fn() }));

vi.mock('@sdk/react/hooks', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, useAuth: () => ({ currentUser: { id: 'user-1' } }) };
});

vi.mock('@src/hooks/use-sandboxes', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useSandboxes: () => ({
      launch: vi.fn(),
      createSandbox: (...args: unknown[]) => mocks.createSandbox(...args),
      launchSandbox: (...args: unknown[]) => mocks.launchSandbox(...args),
      steps: [],
      launchUrl: null,
    }),
  };
});

const { default: apiClient } = await import('@sdk/client');
const { default: LaunchLanding } = await import('@src/pages/entry/LaunchLanding');

// A fresh id per test run: the store caches refs by TypeId across renders.
const AGENT_ID = '5be3d54a-3e27-4a92-bef9-cbb723e71871';

function targetNotFound(): AxiosError {
  const error = new AxiosError('Request failed with status code 403', 'ERR_BAD_REQUEST');
  error.response = {
    status: 403,
    statusText: 'Forbidden',
    data: { status: 'FAIL', message: 'Missing request info(Target entity not found)', data: { error_code: 'target_not_found' } },
    headers: {},
    config: {} as never,
  } as AxiosResponse;
  error.status = 403;
  return error;
}

let get: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.createSandbox = vi.fn();
  mocks.launchSandbox = vi.fn();
  get = vi.fn().mockRejectedValue(targetNotFound());
  vi.spyOn(apiClient, 'get').mockImplementation((...args: unknown[]) => get(...args));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('/launch?agent= — real signed-in read', () => {
  // The app renders under StrictMode, which mounts effects twice: the first `useEntity`
  // subscription is cancelled mid-fetch and the second waits on that same in-flight request.
  it.each([
    ['plain', false],
    ['StrictMode', true],
  ])('shows "can\'t launch" when the hub answers 403 target_not_found (%s)', async (_label, strict) => {
    const tree = (
      <MemoryRouter initialEntries={[`/launch?agent=${AGENT_ID}`]}>
        <Routes>
          <Route path="launch" element={<LaunchLanding />} />
        </Routes>
      </MemoryRouter>
    );
    render(strict ? <StrictMode>{tree}</StrictMode> : tree);

    expect(screen.getByTestId('launch-signed-in')).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByTestId('launch-agent-error').textContent).toBe(
        "Can't launch this agent: it doesn't exist, or you don't have access to it.",
      ),
    );
    expect(get).toHaveBeenCalledWith(`/graph/agent/${AGENT_ID}`, expect.anything());
    expect(mocks.createSandbox).not.toHaveBeenCalled();
  });
});
