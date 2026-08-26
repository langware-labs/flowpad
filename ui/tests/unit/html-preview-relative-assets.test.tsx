/**
 * A previewed page's own images and stylesheets must actually load.
 *
 * The preview injects the file's markup as `srcDoc`, and a srcdoc document has
 * no URL of its own — so the browser resolves every relative reference against
 * the PARENT, the dock route the app is sitting on. Measured, real component,
 * parent at `/dock/shell/agentic_process-…`:
 *
 *     IMG  src : http://localhost:3000/dock/shell/pic.png
 *     CSS href : http://localhost:3000/dock/shell/style.css
 *
 * Those are app routes holding no files: ungated they answer with nothing
 * usable, gated the cookie-gate 403s them. On screen that is a broken-image
 * icon and a page that has lost its styling.
 *
 * Substituting a servable backend URL does not help either: the frame is
 * `sandbox="allow-scripts"` with no `allow-same-origin`, an opaque origin that
 * sends no credentials, so the fs `download` route would refuse it too. The
 * bytes have to travel INSIDE the page — read by the parent, which has the
 * credentials, and inlined into the in-memory copy only.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const FILE = '/home/user/Flowpad workspace/Course Project/img-test/page.html';
const MARKUP = [
  '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>',
  '<body><h1>Image test</h1><img src="pic.png" alt="test image"></body></html>',
].join('');

// A 1x1 PNG — the smallest real image, so the bytes travelling are real bytes.
const PNG_BYTES = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);
const CSS_TEXT = 'h1 { color: crimson; }';

vi.mock('@sdk', () => ({
  FSRef: class {
    constructor(public path: string) {}
    read() {
      return Promise.resolve(MARKUP);
    }
  },
}));
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ computeNode: { typeId: { toString: () => 'compute_node-@local' } } }),
}));
vi.mock('@src/hooks/useFS', () => ({
  useFS: () => ({
    revision: () => 0,
    getDownloadUrl: (p: string) => `http://localhost:3000/api/v1/fs/download?path=${encodeURIComponent(p)}`,
  }),
}));
vi.mock('@src/navigation', () => ({
  useDockNavigation: () => ({ navigation: { openMachinePath: vi.fn() } }),
}));

// The parent's own fetch: same origin, credentials ride, which is exactly why
// the parent — and not the origin-less frame — is the one that must read these.
let oversized = false;

vi.stubGlobal('fetch', (input: string | URL) => {
  const png = input.toString().includes('pic.png');
  const body = png ? (oversized ? new Uint8Array(3 * 1024 * 1024) : PNG_BYTES) : CSS_TEXT;
  return Promise.resolve(
    new Response(body, {
      status: 200,
      headers: { 'content-type': png ? 'image/png' : 'text/css' },
    }),
  );
});

import { HtmlPreview } from '@src/components/html-preview/HtmlPreview';

async function guestDocument(): Promise<Document> {
  render(<HtmlPreview path={FILE} />);
  const frame: HTMLIFrameElement = await screen.findByTestId('html-preview');
  await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('Image test'));
  const { JSDOM } = await import('jsdom');
  return new JSDOM(frame.getAttribute('srcdoc') ?? '', { url: window.location.href }).window.document;
}

afterEach(cleanup);

describe('HtmlPreview sibling assets', () => {
  it('loads an image beside the file instead of pointing at the app route', async () => {
    window.history.replaceState({}, '', '/dock/shell/agentic_process-10a3bd1e?viewMode=vibe');
    const guest = await guestDocument();
    const src = guest.querySelector('img')!.src;

    expect(src).not.toContain('/dock/');
    await waitFor(() => expect(src.startsWith('data:image/png;base64,')).toBe(true));
  });

  it('loads a stylesheet beside the file instead of pointing at the app route', async () => {
    window.history.replaceState({}, '', '/dock/shell/agentic_process-10a3bd1e?viewMode=vibe');
    const guest = await guestDocument();
    const href = guest.querySelector('link')!.href;

    expect(href).not.toContain('/dock/');
    expect(href.startsWith('data:text/css')).toBe(true);
  });

  it('leaves an oversized asset alone and names it, rather than showing a silent break', async () => {
    window.history.replaceState({}, '', '/dock/shell/agentic_process-10a3bd1e?viewMode=vibe');
    // Over the per-asset ceiling: inlining it would cost ~a third more again,
    // on every render, inside the page string.
    oversized = true;

    render(<HtmlPreview path={FILE} />);
    const note = await screen.findByTestId('html-preview-skipped');

    expect(note.textContent).toContain('pic.png');
    const frame: HTMLIFrameElement = await screen.findByTestId('html-preview');
    expect(frame.getAttribute('srcdoc')).toContain('src="pic.png"');
    oversized = false;
  });
});
