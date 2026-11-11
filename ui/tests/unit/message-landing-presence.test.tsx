/**
 * The email landing page for a message: Open in FlowPad (the deep link, which also starts a
 * closed FlowPad) with a line under it saying whether the user's FlowPad desktop is connected
 * to the hub — re-asked on Check again and live when the hub announces a desktop came or went.
 * Signed out: Log in, no preview.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { act } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ConnectionManager } from '@sdk';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const MSG = '123e4567-e89b-4456-8abc-def123456789';
const state = vi.hoisted(() => ({
  entity: {} as Record<string, unknown>,
  online: [] as (boolean | 'fail')[],
  calls: [] as { name: string; body: unknown }[],
}));

vi.mock('@sdk/react/hooks', () => ({
  useEntity: () => state.entity,
  useAuth: () => ({ currentUser: { name: 'brecv-2', email: 'b@x.test' } }),
}));
vi.mock('@sdk', async (orig) => {
  const real = await orig<typeof import('@sdk')>();
  return {
    ...real,
    dataManager: {
      callAction: vi.fn(async (action: { name?: string; _name?: string; bodyParameters?: unknown }) => {
        const name = action.name ?? action._name ?? '';
        state.calls.push({ name, body: action.bodyParameters });
        if (name === 'current-user-desktops') {
          const online = state.online.length > 1 ? state.online.shift() : state.online[0];
          if (online === 'fail') throw new Error('422 Unknown entity type or action: current-user-desktops');
          return { online };
        }
        return null;
      }),
      getCurrentUser: vi.fn(async () => null),
    },
  };
});

const { default: MessageLanding } = await import('@src/pages/entry/MessageLanding');

const MESSAGE = {
  id: MSG,
  text: 'Here is the laser use-cases doc',
  sender_name: 'bsend-1',
  attachment_filename: 'body.flowmsg',
  body_status: 'ready',
};

const open = () =>
  render(
    <MemoryRouter initialEntries={[`/flow_message/${MSG}`]}>
      <Routes>
        <Route path="flow_message/:messageId" element={<MessageLanding />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  state.entity = { data: MESSAGE, isLoading: false, notFound: false, error: null };
  state.online = [true];
  state.calls = [];
  sessionStorage.clear();
});
afterEach(cleanup);

const line = () => screen.getByTestId('landing-connection');
const desktopChecks = () => state.calls.filter((c) => c.name === 'current-user-desktops').length;

it('the old card: Open in FlowPad, the agents, Download — and a connected line under the button', async () => {
  open();
  expect(screen.getByTestId('landing-title')).toHaveTextContent('Conversation with bsend-1');
  expect(screen.getByTestId('landing-preview')).toHaveTextContent('laser use-cases');
  expect(screen.getByRole('button', { name: 'Open in FlowPad' })).toBeInTheDocument();
  expect(screen.getByAltText('Claude Code')).toBeInTheDocument();
  expect(screen.getByTestId('landing-download')).toHaveAttribute('download', 'body.flowmsg');
  expect(line()).toHaveAttribute('data-presence', 'checking');
  await waitFor(() => expect(line()).toHaveTextContent('FlowPad is connected'));
});

it('not connected: says so, and Open stays the deep link', async () => {
  state.online = [false];
  open();
  await waitFor(() => expect(line()).toHaveTextContent("FlowPad isn't connected"));
  expect(screen.getByRole('button', { name: 'Open in FlowPad' })).toBeEnabled();
});

it('a hub that cannot answer is not "offline" — it says it could not check', async () => {
  state.online = ['fail'];
  open();
  await waitFor(() => expect(line()).toHaveTextContent("Couldn't check FlowPad's connection"));
});

it('Check again asks the hub again', async () => {
  state.online = [false, true];
  open();
  await waitFor(() => expect(line()).toHaveTextContent("FlowPad isn't connected"));
  fireEvent.click(screen.getByTestId('landing-check-again'));
  await waitFor(() => expect(line()).toHaveTextContent('FlowPad is connected'));
  expect(desktopChecks()).toBe(2);
});

it('flips live when the hub announces a desktop came or went — no reload, no click', async () => {
  state.online = [false, true, false];
  open();
  await waitFor(() => expect(line()).toHaveTextContent("FlowPad isn't connected"));
  act(() => ConnectionManager.getInstance().onMessage({ message_type: 'desktop_presence' } as never));
  await waitFor(() => expect(line()).toHaveTextContent('FlowPad is connected'));
  act(() => ConnectionManager.getInstance().onMessage({ message_type: 'desktop_presence' } as never));
  await waitFor(() => expect(line()).toHaveTextContent("FlowPad isn't connected"));
  expect(desktopChecks()).toBe(3);
});

it('signed out: Log in in the bar and the card, no message text', () => {
  state.entity = { data: null, isLoading: false, notFound: false, error: { response: { status: 401 } } };
  open();
  expect(screen.getByTestId('landing-signed-out')).toBeInTheDocument();
  expect(screen.getByTestId('landing-log-in')).toBeInTheDocument();
  expect(screen.queryByTestId('landing-preview')).not.toBeInTheDocument();
  expect(state.calls).toHaveLength(0);
});
