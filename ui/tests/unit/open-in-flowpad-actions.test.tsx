/**
 * The "Open in FlowPad" card every entry page shares (project share, message, diagnosis):
 * a desktop that opens keeps today's card; one that doesn't gets this OS's installer, in
 * place, then "Open FlowPad" — which re-sends the same link, and survives a reload.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ handedOff: true, opened: [] as string[] }));
vi.mock('@src/pages/entry/useOpenFlowpad', () => ({
  useOpenInFlowpad: (path: string) => () => {
    state.opened.push(path);
    return Promise.resolve(state.handedOff);
  },
}));

const { OpenInFlowpadActions } = await import('@src/pages/entry/OpenInFlowpadActions');

const TARGET = '/dock/home?action=open&project_id=p1';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15';
const LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
const LINUX_ARM = 'Mozilla/5.0 (X11; Linux aarch64; rv:132.0) Gecko/20100101 Firefox/132.0';
const RELEASE = 'https://github.com/langware-labs/flowpad/releases/latest/download/';

const asUserAgent = (ua: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(ua);
const card = () => render(<OpenInFlowpadActions openTargetPath={TARGET} />);
const frameSrc = () => document.querySelector<HTMLIFrameElement>('iframe#flowpad-download-frame')?.src;

/** Click Open in FlowPad with no app answering — the "nothing happened" card. */
async function openWithNoApp() {
  state.handedOff = false;
  fireEvent.click(screen.getByRole('button', { name: 'Open in FlowPad' }));
  await screen.findByTestId('desktop-download');
}

beforeEach(() => {
  state.handedOff = true;
  state.opened = [];
  sessionStorage.clear();
  asUserAgent(MAC);
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

it('a desktop that opens keeps the card as it was — no download prompt', async () => {
  card();
  fireEvent.click(screen.getByRole('button', { name: 'Open in FlowPad' }));
  await waitFor(() => expect(state.opened).toEqual([TARGET]));
  expect(screen.getByRole('button', { name: 'Open in FlowPad' })).toBeEnabled();
  expect(screen.queryByTestId('desktop-download')).not.toBeInTheDocument();
  expect(screen.queryByTestId('download-started')).not.toBeInTheDocument();
});

it('offers the one-click download for this OS under the button', async () => {
  card();
  const quick = await screen.findByRole('link', { name: 'Download for macOS' });
  fireEvent.click(quick);
  expect(frameSrc()).toBe(`${RELEASE}Flowpad-universal.dmg`);
  expect(screen.getByTestId('download-started')).toHaveTextContent(
    'Once FlowPad is installed, click Open FlowPad to continue.',
  );
});

it('no app answering: the macOS installer becomes the button, and Open FlowPad retries the same link', async () => {
  card();
  await openWithNoApp();
  expect(screen.getByTestId('download-dmg')).toHaveAttribute('href', `${RELEASE}Flowpad-universal.dmg`);
  fireEvent.click(screen.getByTestId('open-flowpad'));
  await waitFor(() => expect(state.opened).toEqual([TARGET, TARGET]));
});

it('downloading keeps the page and says what comes next — a reload too; Open FlowPad continues the invitation', async () => {
  const before = window.location.href;
  card();
  await openWithNoApp();
  fireEvent.click(screen.getByTestId('download-dmg'));
  expect(window.location.href).toBe(before);
  expect(screen.getByTestId('download-started')).toBeInTheDocument();
  expect(screen.getByTestId('download-direct')).toHaveAttribute('target', '_blank');

  cleanup(); // the reload
  card();
  expect(screen.getByTestId('download-started')).toBeInTheDocument();
  // Still nothing answering: the card says so instead of staying silent.
  expect(screen.queryByTestId('still-not-opened')).not.toBeInTheDocument();
  fireEvent.click(screen.getByTestId('open-flowpad'));
  expect(await screen.findByTestId('still-not-opened')).toBeInTheDocument();
  state.handedOff = true;
  fireEvent.click(screen.getByTestId('open-flowpad'));
  await waitFor(() => expect(screen.queryByTestId('still-not-opened')).not.toBeInTheDocument());
  expect(state.opened.at(-1)).toBe(TARGET);
  // A hand-off is never claimed: the card still only says what to do.
  expect(screen.getByTestId('download-started')).toBeInTheDocument();

  fireEvent.click(screen.getByTestId('download-another'));
  expect(await screen.findByTestId('desktop-download')).toBeInTheDocument();
  expect(sessionStorage.length).toBe(0);
});

it('Linux: AppImage by default, DEB and RPM to pick, with the install line for each', async () => {
  asUserAgent(LINUX);
  card();
  await openWithNoApp();
  expect(screen.getByTestId('format-appimage')).toBeChecked();
  expect(screen.getByTestId('download-appimage')).toHaveAttribute('href', `${RELEASE}Flowpad-x86_64.AppImage`);
  fireEvent.click(screen.getByTestId('format-deb'));
  expect(screen.getByTestId('download-deb')).toHaveAttribute('href', `${RELEASE}Flowpad-amd64.deb`);
  expect(screen.getByTestId('download-install-hint')).toHaveTextContent('sudo apt install ./Flowpad-amd64.deb');
  fireEvent.click(screen.getByTestId('format-rpm'));
  fireEvent.click(screen.getByTestId('download-rpm'));
  expect(frameSrc()).toBe(`${RELEASE}Flowpad-x86_64.rpm`);
  expect(screen.getByTestId('download-install-hint')).toHaveTextContent('sudo dnf install ./Flowpad-x86_64.rpm');
});

it('Linux on ARM: says there is no installer for it, and still lists every one by hand', async () => {
  asUserAgent(LINUX_ARM);
  card();
  await openWithNoApp();
  expect(screen.getByTestId('download-note')).toHaveTextContent("isn't available for this processor");
  expect(screen.queryByRole('link', { name: /Download FlowPad for/ })).not.toBeInTheDocument();
  expect(screen.getByTestId('download-all').querySelectorAll('a')).toHaveLength(5);
});

it('32-bit Windows: says it needs 64-bit Windows, and lists every installer by hand', async () => {
  asUserAgent('Mozilla/5.0 (Windows NT 10.0; rv:132.0) Gecko/20100101 Firefox/132.0');
  card();
  fireEvent.click(await screen.findByTestId('download-choose'));
  expect(await screen.findByTestId('download-note')).toHaveTextContent('needs 64-bit Windows');
  expect(screen.getByTestId('download-all').querySelectorAll('a')).toHaveLength(5);
});

it('a platform FlowPad does not run on: explains, and offers every installer by hand', async () => {
  asUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15');
  card();
  fireEvent.click(await screen.findByTestId('download-choose'));
  expect(await screen.findByTestId('download-note')).toHaveTextContent('runs on macOS, Windows and Linux');
  expect(screen.getByTestId('download-all').querySelectorAll('a')).toHaveLength(5);
});
