/**
 * A message body's links are a terminal's links: the same matches (`linkSegments`), the
 * same click (`useLinks` → `navigation.openLink(link, source)`) and the same right-click
 * menu, with the FlowMessage as the source the backend resolves against. The real
 * click → tab path is `tests/manual_regression/conversation/message_links.md.ts`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConversationMessage } from '@sdk/entities/conversation';

const mocks = vi.hoisted(() => ({ openLink: vi.fn(), openLinkInVibe: vi.fn() }));

vi.mock('@src/navigation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDockNavigation: () => ({
    navigation: { openLink: mocks.openLink, openLinkInBrowser: vi.fn(), openLinkInVibe: mocks.openLinkInVibe, openLinkInBrowserProfile: vi.fn() },
  }),
}));
vi.mock('@src/lib/browser-profiles', () => ({ fetchBrowserProfiles: () => Promise.resolve([]) }));

const { MessageBubble } = await import('@src/components/conversation/MessageBubble');

const URL = 'https://github.com/langware-labs/flowpad/pull/544';
const BODY = `היי ערן, אין צורך לעשות כלום\nPR: ${URL}\nsee src/a.ts:3.`;

function message(content: string): ConversationMessage {
  return { role: 'sender', content, sender_id: 'user-1', timestamp: '2026-10-04T10:00:00.000Z' };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('message links behave like terminal links', () => {
  it('renders the URL and the file reference as links, keeping the text and its newlines', () => {
    const { container } = render(<MemoryRouter><MessageBubble message={message(BODY)} senderName="Gadi" /></MemoryRouter>);
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([URL, 'src/a.ts:3']);
    expect(links[0].getAttribute('dir')).toBe('ltr');
    const body = container.querySelector('.whitespace-pre-wrap');
    expect(body?.textContent).toBe(BODY);
  });

  it('a click opens the link against the message, like a terminal against its shell', async () => {
    const fm = { id: 'm1', resolveDisplayTarget: vi.fn() };
    const onSelect = vi.fn();
    render(<MemoryRouter><MessageBubble message={message(BODY)} flowMessage={fm as never} senderName="Gadi" onSelect={onSelect} /></MemoryRouter>);
    fireEvent.click(screen.getByText(URL));
    await waitFor(() => expect(mocks.openLink).toHaveBeenCalledWith(URL, fm));
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('a right-click opens the shared link menu, with Vibe only when the conversation has a process', async () => {
    const run = { project_id: 'p1' };
    render(<MemoryRouter><MessageBubble message={message(BODY)} run={run as never} senderName="Gadi" /></MemoryRouter>);
    fireEvent.contextMenu(screen.getByText(URL), { clientX: 5, clientY: 5 });
    const menu = await screen.findByTestId('link-menu');
    expect(menu.textContent).toContain('Open in Flowpad');
    expect(menu.textContent).toContain('Open in browser');
    fireEvent.click(screen.getByTestId('link-menu-vibe'));
    expect(mocks.openLinkInVibe).toHaveBeenCalledWith(URL, null, run);
  });

  it('a non-primary click does not open the link', async () => {
    render(<MemoryRouter><MessageBubble message={message(BODY)} senderName="Gadi" /></MemoryRouter>);
    fireEvent.click(screen.getByText(URL), { button: 1 });
    fireEvent.click(screen.getByText('src/a.ts:3'));
    await waitFor(() => expect(mocks.openLink).toHaveBeenCalledTimes(1));
    expect(mocks.openLink).toHaveBeenCalledWith('src/a.ts:3', null);
  });
});
