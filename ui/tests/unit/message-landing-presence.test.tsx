/**
 * The email landing page for a message: one CTA, decided by asking the hub whether the
 * user's FlowPad desktop is connected — checking → Open in FlowPad, or "FlowPad is offline"
 * with Check again and Open | Download. Signed out: Log in, no preview.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const MSG = '123e4567-e89b-4456-8abc-def123456789';
const state = vi.hoisted(() => ({
  entity: {} as Record<string, unknown>,
  online: [] as boolean[],
  delivered: 1,
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
          return { online };
        }
        if (name === 'open_on_desktop') return { delivered: state.delivered };
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
  state.delivered = 1;
  state.calls = [];
  sessionStorage.clear();
});
afterEach(cleanup);

it('checks first, then offers Open in FlowPad, and Open asks the hub to open it on the desktop', async () => {
  open();
  expect(screen.getByTestId('landing-checking')).toHaveTextContent('Checking FlowPad status');
  expect(screen.getByTestId('landing-title')).toHaveTextContent('bsend-1 sent you a message');
  expect(screen.getByTestId('landing-preview')).toHaveTextContent('laser use-cases');
  expect(screen.getByTestId('landing-profile')).toHaveTextContent('brecv-2');

  fireEvent.click(await screen.findByTestId('landing-open'));
  await waitFor(() => expect(state.calls.some((c) => c.name === 'open_on_desktop')).toBe(true));
  expect(state.calls.find((c) => c.name === 'open_on_desktop')?.body).toEqual({ flow_message_id: MSG });
  expect(screen.getByTestId('landing-download')).toHaveAttribute('download', 'body.flowmsg');
});

it('offline: says so with Check again, Open and Download; Check again asks the hub again', async () => {
  state.online = [false, true];
  open();
  expect(await screen.findByTestId('landing-offline')).toHaveTextContent('FlowPad is offline');
  expect(screen.getByTestId('landing-launch')).toBeInTheDocument();
  expect(screen.getByTestId('landing-download')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('landing-check-again'));
  expect(await screen.findByTestId('landing-open')).toBeInTheDocument();
  expect(state.calls.filter((c) => c.name === 'current-user-desktops')).toHaveLength(2);
});

it('a desktop that went away between the check and the click flips to offline', async () => {
  state.delivered = 0;
  open();
  fireEvent.click(await screen.findByTestId('landing-open'));
  expect(await screen.findByTestId('landing-offline')).toBeInTheDocument();
});

it('signed out: Log in in the bar and the card, no message text', () => {
  state.entity = { data: null, isLoading: false, notFound: false, error: { response: { status: 401 } } };
  open();
  expect(screen.getByTestId('landing-signed-out')).toBeInTheDocument();
  expect(screen.getByTestId('landing-log-in')).toBeInTheDocument();
  expect(screen.queryByTestId('landing-preview')).not.toBeInTheDocument();
  expect(state.calls).toHaveLength(0);
});
