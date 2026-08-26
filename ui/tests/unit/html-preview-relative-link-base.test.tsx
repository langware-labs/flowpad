/**
 * A relative link in the HTML preview must open the file NEXT TO IT.
 *
 * The preview injects the file's markup into an iframe as `srcDoc`
 * (`HtmlPreview.tsx`). A `srcdoc` document has no URL of its own, so the browser
 * resolved its relative URLs against the PARENT document — the app's own dock
 * route. `<a href="cloud-types.html">` in a generated two-page site therefore
 * pointed at `/dock/shell/cloud-types.html`, a path holding no such file.
 *
 * Observed both ways in the field, one bug wearing two faces:
 *   - desktop (ungated): the pane goes blank
 *   - cloud sandbox (gated): `cloud-types.html:1  403`, and the cookie-gate's
 *     Forbidden page renders in the pane, because the frame is `allow-scripts`
 *     with no `allow-same-origin` and so carries no credentials either
 *
 * The site was never wrong. Its links are relative and correct; the frame's base
 * was the app. So the parent resolves them and routes them.
 */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const FILE = '/home/user/Flowpad workspace/Course Project/clouds-site/index.html';
const SITE_DIR = '/home/user/Flowpad workspace/Course Project/clouds-site/';
const MARKUP = '<!doctype html><html><body><a href="cloud-types.html">go</a></body></html>';

const openMachinePath = vi.fn();
const typeId = { toString: () => 'compute_node-@local' };

// Input only: the bytes the preview is asked to show, and the host context —
// the same way tests/react/vibe-new-process-parity.test.tsx supplies it. The
// resolution under test is the component's own.
vi.mock('@sdk', () => ({
  FSRef: class {
    constructor(public path: string) {}
    read() {
      return Promise.resolve(MARKUP);
    }
  },
}));
vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ computeNode: { typeId } }),
}));
vi.mock('@src/hooks/useFS', () => ({ useFS: () => ({ revision: () => 0 }) }));
vi.mock('@src/navigation', () => ({
  useDockNavigation: () => ({ navigation: { openMachinePath } }),
}));

import { HtmlPreview, previewLinkTarget } from '@src/components/html-preview/HtmlPreview';

afterEach(cleanup);

describe('HtmlPreview relative links', () => {
  it('resolves a sibling page next to the file, not onto the app route', () => {
    expect(previewLinkTarget(FILE, 'cloud-types.html')).toBe(`${SITE_DIR}cloud-types.html`);
    expect(previewLinkTarget(FILE, './pages/deep.html')).toBe(`${SITE_DIR}pages/deep.html`);
    expect(previewLinkTarget(FILE, '../other/x.html')).toBe('/home/user/Flowpad workspace/Course Project/other/x.html');
    // Not ours to route: the guest handles its own anchors, and anything with a
    // scheme is not a file beside this one.
    expect(previewLinkTarget(FILE, '#top')).toBeNull();
    expect(previewLinkTarget(FILE, 'https://example.com/x.html')).toBeNull();
  });

  it('scrolls an in-page anchor inside the frame instead of navigating it', async () => {
    // `#id` does not scroll on its own in a srcdoc frame: the document's url is
    // `about:srcdoc` but its BASE is the parent's dock route, so `#top` resolves
    // to `<app route>#top` -- a different document -- and the browser navigates
    // the frame at the gated backend. Users got the Forbidden page for clicking
    // an in-page anchor, and agents started replacing `href="#id"` with custom
    // scroll JS, which breaks the markup everywhere it is published.
    render(<HtmlPreview path={FILE} />);
    const frame: HTMLIFrameElement = await screen.findByTestId('html-preview');
    await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('cloud-types.html'));
    const srcdoc = frame.getAttribute('srcdoc') ?? '';

    // Handled in the guest, by scrolling — never handed to the parent to route.
    expect(srcdoc).toContain('scrollIntoView');
    expect(srcdoc).toMatch(/charAt\(0\) === '#'/);
    // …and the parent still refuses to treat a fragment as a sibling file.
    expect(previewLinkTarget(FILE, '#top')).toBeNull();
  });

  it('routes a clicked link through the router instead of navigating the frame', async () => {
    window.history.replaceState({}, '', '/dock/shell/agentic_process-10a3bd1e?viewMode=vibe');
    openMachinePath.mockClear();

    render(<HtmlPreview path={FILE} />);
    const frame = await screen.findByTestId('html-preview');
    await waitFor(() => expect(frame.getAttribute('srcdoc')).toContain('cloud-types.html'));

    // The guest is told not to navigate, and to say where it wanted to go.
    expect(frame.getAttribute('srcdoc')).toContain('preventDefault');
    expect(frame.getAttribute('srcdoc')).toContain('flowpad:preview-link');
    // …and the file itself is untouched: what we publish is what the agent wrote.
    expect(frame.getAttribute('srcdoc')).toContain(MARKUP);

    window.dispatchEvent(
      new MessageEvent('message', {
        data: { type: 'flowpad:preview-link', href: 'cloud-types.html' },
        source: frame.contentWindow,
      }),
    );

    await waitFor(() => expect(openMachinePath).toHaveBeenCalledWith(`${SITE_DIR}cloud-types.html`, typeId));
  });
});
