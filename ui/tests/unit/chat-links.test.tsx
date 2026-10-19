/**
 * A chat turn's links are a terminal's links: rendered markdown takes the same detection
 * (`remarkLinkRefs` over `link-matches`), the same click and the same menu (`LinkScope` →
 * `useLinks`), resolved against the chat's process. In a vibe chat the click shows in the
 * process's Display; anywhere else it opens a tab. The real clicks, in every mode, are
 * `tests/manual_regression/links/links_all_modes.md.ts`.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openLink: vi.fn(),
  openLinkInVibe: vi.fn(),
  showLinkInDisplay: vi.fn(),
  openLinkInBrowser: vi.fn(),
}));

vi.mock('@src/navigation', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useDockNavigation: () => ({ navigation: { ...mocks, openLinkInBrowserProfile: vi.fn() } }),
}));
vi.mock('@src/lib/browser-profiles', () => ({ fetchBrowserProfiles: () => Promise.resolve([]) }));

const { LinkScope, useLinkHandlers } = await import('@src/components/links/LinkHandlersContext');
const { MarkdownView } = await import('@src/components/markdown-view');

const TURN = [
  'Edited `ui/src/a.ts:42` and ui/src/b.ts, see [the doc](docs/x.md#L3).',
  'PR: https://example.org/pr/1 — run `npm test` in `/dock/...`.',
].join('\n\n');

const PROCESS = { id: 'p1', project_id: 'proj', resolveDisplayTarget: vi.fn() } as never;

function Turn({ value }: { value: string }) {
  return <MarkdownView value={value} compact links={useLinkHandlers()} />;
}

function renderTurn(surface?: 'vibe' | 'tab', process: unknown = PROCESS) {
  return render(
    <LinkScope process={process as never} surface={surface}>
      <Turn value={TURN} />
    </LinkScope>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('chat turn links', () => {
  it('links backticked and bare paths, authored links and URLs — not commands or placeholders', () => {
    renderTurn();
    expect([...document.querySelectorAll('[data-link]')].map((a) => a.getAttribute('data-link'))).toEqual([
      'ui/src/a.ts:42',
      'ui/src/b.ts',
      'docs/x.md#L3',
      'https://example.org/pr/1',
    ]);
    expect(screen.getByText('ui/src/a.ts:42').tagName).toBe('CODE');
  });

  it('a click opens the link against the chat process, never as a browser tab', async () => {
    renderTurn();
    const link = screen.getByText('the doc').closest('a')!;
    expect(link.getAttribute('target')).toBeNull();
    fireEvent.click(link);
    await waitFor(() => expect(mocks.openLink).toHaveBeenCalledWith('docs/x.md#L3', PROCESS));
  });

  it('in a vibe chat the click shows in the Display, and the menu still offers a tab', async () => {
    renderTurn('vibe');
    fireEvent.click(screen.getByText('ui/src/a.ts:42'));
    await waitFor(() => expect(mocks.showLinkInDisplay).toHaveBeenCalledWith('ui/src/a.ts:42', PROCESS));
    fireEvent.contextMenu(screen.getByText('ui/src/b.ts'), { clientX: 5, clientY: 5 });
    await screen.findByTestId('link-menu');
    expect(screen.queryByTestId('link-menu-vibe')).toBeNull();
    fireEvent.click(screen.getByTestId('link-menu-open'));
    expect(mocks.openLink).toHaveBeenCalledWith('ui/src/b.ts', PROCESS);
  });

  it('outside vibe the menu offers Vibe for the chat process', async () => {
    renderTurn();
    fireEvent.contextMenu(screen.getByText('https://example.org/pr/1'), { clientX: 5, clientY: 5 });
    await screen.findByTestId('link-menu');
    expect(screen.queryByTestId('link-menu-show-in-display')).toBeNull();
    fireEvent.click(screen.getByTestId('link-menu-vibe'));
    expect(mocks.openLinkInVibe).toHaveBeenCalledWith('https://example.org/pr/1', PROCESS, PROCESS);
  });

  it('before the chat has a process, the turn renders as plain markdown', () => {
    renderTurn(undefined, null);
    expect(document.querySelectorAll('[data-link]')).toHaveLength(0);
    expect(screen.getByText('the doc').closest('a')?.getAttribute('target')).toBe('_blank');
  });
});
