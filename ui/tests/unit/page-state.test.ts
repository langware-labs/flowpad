/**
 * The state key a page presents to the local server: where the SDK finds it, that every call carries
 * it, and what a page says when the server refuses it. (The server half: tests/unit/test_state_key.py.)
 */
import { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { apiClient, htmlPage } from '@sdk';
import { showPageStateError, stateKey, stateRefusal, STATE_HEADER } from '@sdk/page-state';

const PROCESS = 'agentic_process-3b241101-e2bb-4255-8caf-4136c566a962';
const KEY = 'k'.repeat(32);
const g = globalThis as { __FLOWPAD_STATE_KEY__?: string };
const notice = () => document.querySelector('[data-testid="flowpad-page-error"]');

/** Answer the next call as the local server would; `seen` is the request it got. */
function server(answer: { data?: unknown; refusal?: string }) {
  const seen: InternalAxiosRequestConfig[] = [];
  apiClient.defaults.adapter = async (config) => {
    seen.push(config);
    if (answer.refusal) {
      const response = { status: 403, statusText: 'Forbidden', data: '', headers: { 'x-flowpad-gate': answer.refusal }, config };
      throw new AxiosError('Forbidden', 'ERR_BAD_REQUEST', config, null, response);
    }
    return { status: 200, statusText: 'OK', headers: {}, config, data: { status: 'SUCCESS', data: answer.data } };
  };
  return seen;
}

beforeEach(() => {
  delete g.__FLOWPAD_STATE_KEY__;
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  notice()?.remove();
});

afterEach(() => {
  apiClient.defaults.adapter = undefined;
});

describe('where the key comes from', () => {
  it('is the one the server or host wrote into the page, remembered by the top-level window only', () => {
    g.__FLOWPAD_STATE_KEY__ = KEY;

    expect(stateKey()).toBe(KEY);
    expect(window.sessionStorage.getItem('flowpad.stateKey')).toBe(KEY);
  });

  it('survives the shell reloading itself, when nothing is injected any more', () => {
    window.sessionStorage.setItem('flowpad.stateKey', KEY);

    expect(stateKey()).toBe(KEY);
  });

  it('is the ?state= of a page with no injection, and nothing otherwise', () => {
    expect(stateKey()).toBeNull();
    window.history.replaceState(null, '', `/page.html?state=${KEY}`);

    expect(stateKey()).toBe(KEY);
  });
});

describe('what a refusal says', () => {
  it('reads the reason from the gate header', () => {
    expect(stateRefusal({ 'x-flowpad-gate': 'request=9c8daa; state=missing' })).toBe('missing');
    expect(stateRefusal({ 'x-flowpad-gate': 'request=9c8daa; state=unknown' })).toBe('unknown');
    expect(stateRefusal({ 'x-flowpad-gate': 'request=9c8daa; cookie=absent' })).toBeNull();
    expect(stateRefusal(undefined)).toBeNull();
  });

  it('is said once, inside the page', () => {
    showPageStateError('missing');
    showPageStateError('unknown');

    expect(document.querySelectorAll('[data-testid="flowpad-page-error"]')).toHaveLength(1);
    expect(notice()?.getAttribute('role')).toBe('alert');
  });
});

describe('every call carries the key', () => {
  it('as a header', async () => {
    g.__FLOWPAD_STATE_KEY__ = KEY;
    const seen = server({ data: {} });

    await apiClient.get('/api/v1/anything');

    expect(seen[0].headers[STATE_HEADER]).toBe(KEY);
  });

  it('and a page the server refuses says why in itself', async () => {
    server({ refusal: 'request=9c8daa; state=unknown' });

    await expect(apiClient.get('/api/v1/anything')).rejects.toBeTruthy();

    expect(notice()?.textContent).toContain('not valid here');
  });
});

describe('htmlPage()', () => {
  it('gives the page what it was opened about', async () => {
    g.__FLOWPAD_STATE_KEY__ = KEY;
    server({ data: { enforced: true, state: { context: { process: PROCESS } } } });

    const page = await htmlPage();

    expect(page.context).toEqual({ process: PROCESS });
    expect(page.process?.toString()).toBe(PROCESS);
  });

  it('says so, in the page, when the key stands for nothing', async () => {
    server({ data: { enforced: true, state: null } });

    await expect(htmlPage()).rejects.toThrow('without permission');
    expect(notice()).not.toBeNull();
  });

  it('has no context, and no complaint, on a server that does not demand keys', async () => {
    server({ data: { enforced: false, state: null } });

    expect(await htmlPage()).toMatchObject({ context: {}, process: null, enforced: false });
    expect(notice()).toBeNull();
  });
});
