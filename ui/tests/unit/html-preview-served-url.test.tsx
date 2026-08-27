/**
 * The preview points the frame at the file's own served url — it does not paste
 * the file's markup in.
 *
 * This test replaces two others (`html-preview-relative-link-base`,
 * `html-preview-relative-assets`), and the replacement is the point. Both of
 * those pinned WORKAROUNDS for one defect: a `srcdoc` document has no url, so
 * the browser resolved its relative references against the parent — the app's
 * dock route — and `<a href="page2.html">` became `/dock/shell/page2.html`.
 * One test pinned a click-interceptor that caught links before the frame could
 * follow them; the other pinned a rewriter that read sibling images and
 * stylesheets in the PARENT and inlined them as data: uris, because an
 * origin-less frame could not fetch them itself.
 *
 * Both existed only because the frame had no address. `fs/serve` gives it one,
 * whose tail is the file's path, so relative refs resolve to the real siblings
 * and there is nothing left to intercept or inline. What is pinned here instead
 * is the small set of properties that whole class now depends on.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const FILE = '/home/user/Flowpad workspace/Course Project/clouds-site/index.html';
const SERVE_BASE = 'http://localhost:8000/api/v1/graph/compute_node/@local/fs/serve';

let revision = 0;

vi.mock('@src/components/agent-layout/agent-layout', () => ({
  useAgentContext: () => ({ computeNode: { typeId: { toString: () => 'compute_node-@local' } } }),
}));
vi.mock('@src/hooks/useFS', () => ({
  useFS: () => ({
    revision: () => revision,
    getServeUrl: (p: string) => `${SERVE_BASE}${p}`,
  }),
}));

import { HtmlPreview } from '@src/components/html-preview/HtmlPreview';

function frame(): HTMLIFrameElement {
  return screen.getByTestId('html-preview');
}

describe('HtmlPreview', () => {
  afterEach(() => {
    revision = 0;
    cleanup();
  });

  it('points the frame at the served url, not at inlined markup', () => {
    render(<HtmlPreview path={FILE} />);

    const src = frame().getAttribute('src') ?? '';
    expect(src.startsWith(`${SERVE_BASE}${FILE}`)).toBe(true);
    // No markup travels in the attribute any more — that WAS the bug.
    expect(frame().getAttribute('srcdoc')).toBeNull();
  });

  it("ends the url with the file's own path, so siblings resolve to real files", () => {
    render(<HtmlPreview path={FILE} />);

    // The browser resolves a relative href against the url's directory. Doing
    // that here is the assertion: `cloud-types.html` beside index.html must
    // land on the sibling's served url, not on an app route.
    const resolved = new URL('cloud-types.html', frame().getAttribute('src') ?? '');
    expect(resolved.pathname).toBe(new URL(`${SERVE_BASE}${FILE}`.replace('index.html', 'cloud-types.html')).pathname);
    expect(resolved.pathname).not.toContain('/dock/');
  });

  it('withholds allow-same-origin while granting what needs no origin', () => {
    render(<HtmlPreview path={FILE} />);
    const sandbox = frame().getAttribute('sandbox') ?? '';

    // The served url is on the app's OWN origin, so allow-same-origin would let
    // an agent-written page call the API with the user's session and reach
    // parent.document. Everything that does not need an origin is granted.
    expect(sandbox).not.toContain('allow-same-origin');
    expect(sandbox).toContain('allow-scripts');
    expect(sandbox).toContain('allow-forms');
    expect(sandbox).toContain('allow-modals');
    expect(sandbox).toContain('allow-popups');
  });

  it('changes src when the file changes, so an edit reaches the screen', () => {
    const { rerender } = render(<HtmlPreview path={FILE} />);
    const before = frame().getAttribute('src');

    revision = 1;
    rerender(<HtmlPreview path={FILE} />);

    // The response is no-store, but a frame keeps the document it already has
    // until its src actually changes — hence the revision in the query.
    expect(frame().getAttribute('src')).not.toBe(before);
  });
});
