/**
 * `/open-pc/<agent id>`: the no-code probe decides between opening straight away (link mode) and asking for
 * an invite code; a code is sent without cookies, and each refusal reads as what the visitor can do about it.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { default: apiClient } = await import('@sdk/client');
const { default: OpenPcLanding } = await import('@src/pages/entry/OpenPcLanding');

const AGENT_ID = '11111111-2222-4333-8444-555555555555';
const URL = 'https://box.example/gate?x=1';

const hubError = (status: number, message: string, reason?: string) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { message, ...(reason ? { data: { reason } } : {}) } },
  });

let assign: ReturnType<typeof vi.fn>;
const originalLocation = window.location;

beforeEach(() => {
  assign = vi.fn();
  Object.defineProperty(window, 'location', { configurable: true, value: { ...originalLocation, assign } });
  // The quiet agent-name read: a private agent refuses it.
  vi.spyOn(apiClient, 'get').mockRejectedValue(hubError(401, 'private'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={[`/open-pc/${AGENT_ID}`]}>
      <Routes>
        <Route path="open-pc/:agentId" element={<OpenPcLanding />} />
      </Routes>
    </MemoryRouter>,
  );

/** The probe asks for a code; the code call answers `codeAnswer`. */
function codeMode(codeAnswer: () => Promise<unknown>) {
  return vi
    .spyOn(apiClient, 'post')
    .mockImplementation((_path: string, body?: unknown) =>
      (body as { code?: string })?.code ? codeAnswer() : Promise.reject(hubError(401, 'invite code required')),
    );
}

async function submitCode(code = 'WDJB-MJHT') {
  fireEvent.change(await screen.findByTestId('open-pc-code'), { target: { value: code } });
  fireEvent.click(screen.getByTestId('open-pc-open'));
}

describe('OpenPcLanding', () => {
  it('opens straight away in link mode', async () => {
    vi.spyOn(apiClient, 'post').mockResolvedValue({ workspace_url: URL });
    renderPage();
    await waitFor(() => expect(assign).toHaveBeenCalledWith(URL));
    expect(screen.queryByTestId('open-pc-code')).toBeNull();
  });

  it('asks for a code, then sends it without cookies and goes to the sandbox', async () => {
    const post = codeMode(() => Promise.resolve({ workspace_url: URL }));
    renderPage();
    expect(screen.getByTestId('open-pc-title')).toHaveTextContent('Open your sandbox');
    await submitCode();

    await waitFor(() => expect(assign).toHaveBeenCalledWith(URL));
    const [, body, config] = post.mock.calls[1];
    expect(body).toEqual({ code: 'WDJB-MJHT' });
    expect(config).toMatchObject({ adapter: 'fetch', withCredentials: false });
    // The probe sends no cookies either: a signed-in browser must still get the code box.
    expect(post.mock.calls[0][2]).toMatchObject({ adapter: 'fetch', withCredentials: false });
  });

  it.each([
    [404, "this code doesn't work", undefined, "This code doesn't work. Check it, or ask whoever gave it to you."],
    [409, 'all sandboxes for this agent are in use', 'full', 'All sandboxes for this agent are in use right now.'],
    // Seen live: a missing repository read "all sandboxes are in use" -- the visitor waited for nothing.
    [
      409,
      'the project repository is missing on the hub; publish the project again',
      'not_ready',
      "This agent isn't ready to open yet: the project repository is missing on the hub; publish the project again",
    ],
    [429, 'too many tries -- try again later', undefined, 'Too many tries. Try again later.'],
  ])('says what a %s means, and keeps the code box', async (status, message, reason, shown) => {
    codeMode(() => Promise.reject(hubError(status, message, reason)));
    renderPage();
    await submitCode();

    expect(await screen.findByTestId('open-pc-error')).toHaveTextContent(shown);
    expect(screen.getByTestId('open-pc-code')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });
});
