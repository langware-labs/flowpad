/**
 * The `breadcrumb` fence: parsing a block, and the card it draws.
 *
 * The parse half's defining property is that it degrades per ROW rather than
 * per block — `sites:` is a script-written cache of something the tag index
 * owns, so one bad entry must cost one chip, never the card. The render half
 * pins the hybrid contract: authored rows show immediately, live rows replace
 * them, and neither a missing project nor a dead backend blanks anything.
 */

import { renderBreadcrumbCard } from '@src/components/milkdown-editor/plugins/fence-render/renderers/breadcrumb';
import { __resetBreadcrumbContextCache } from '@src/components/milkdown-editor/plugins/fence-render/renderers/breadcrumb-context';
import { parseBreadcrumbBlock } from '@src/components/milkdown-editor/plugins/fence-render/renderers/breadcrumb-schema';
import { afterEach, describe, expect, it, vi } from 'vitest';

const post = vi.fn();
vi.mock('@sdk/client', () => ({ default: { post: (...args: unknown[]) => post(...args) } }));

const TAG = 'breadcrumb.test.catchup_login.rules';
const NOTE = 'FAILING? read this tag rules before editing';

const BLOCK = `tag: ${TAG}
sites:
  - rel_path: tests/unit/test_catchup.py
    line: 41
    note: ${NOTE}
`;

/** Hosts this file attached to `document.body` (see `renderCard`), so they can
 *  be detached again. jsdom is shared by every test FILE in a worker, so a host
 *  left behind stays queryable by whatever runs next — a stray "Refresh from
 *  the tag index" button once made an unrelated worldview test fail with
 *  "found multiple elements with the role button". Leaking DOM is the test's
 *  own mess to clear. */
const attachedHosts: HTMLElement[] = [];

afterEach(() => {
  for (const host of attachedHosts.splice(0)) host.remove();
  __resetBreadcrumbContextCache();
  post.mockReset();
});

describe('parsing a breadcrumb block', () => {
  it('reads the tag and its sites', () => {
    expect(parseBreadcrumbBlock(BLOCK)).toEqual({
      tag: TAG,
      sites: [{ relPath: 'tests/unit/test_catchup.py', line: 41, note: NOTE }],
      issues: [],
    });
  });

  /* The tag is the cache key and the request body, so two spellings must
   * collapse onto one entry rather than two filesystem walks. */
  it('normalizes the tag to its canonical form', () => {
    expect(parseBreadcrumbBlock(`tag:  Breadcrumb.Test.X.Rules \n`).tag).toBe('breadcrumb.test.x.rules');
  });

  it('accepts a block with no sites at all', () => {
    expect(parseBreadcrumbBlock(`tag: ${TAG}\n`)).toEqual({ tag: TAG, sites: [], issues: [] });
  });

  describe('rejects only a block with no identity', () => {
    it.each([
      ['an empty body', '   \n', /Empty breadcrumb block/],
      ['malformed YAML', 'tag: [unclosed\n', /Invalid YAML/],
      ['a sequence, not a mapping', '- tag: x\n', /must be a YAML mapping/],
      ['a missing tag', 'sites: []\n', /tag/],
      ['a tag that fails the grammar', 'tag: "not a tag!"\n', /tag: Invalid tag/],
      ['sites that is not a list', `tag: ${TAG}\nsites: nope\n`, /sites/],
    ])('%s', (_label, source, message) => {
      expect(() => parseBreadcrumbBlock(source)).toThrow(message);
    });
  });

  describe('collects bad rows instead of throwing', () => {
    it('keeps the good rows and reports the bad ones by index', () => {
      const spec = parseBreadcrumbBlock(
        `tag: ${TAG}\nsites:\n  - line: 3\n  - rel_path: tests/a.py\n    line: 7\n`,
      );
      expect(spec.sites).toEqual([{ relPath: 'tests/a.py', line: 7, note: undefined }]);
      expect(spec.issues).toEqual([{ index: 0, reason: 'rel_path: Required' }]);
    });

    it('refuses an escaping rel_path as a row-level defect', () => {
      const spec = parseBreadcrumbBlock(`tag: ${TAG}\nsites:\n  - rel_path: ../../etc/passwd\n`);
      expect(spec.sites).toEqual([]);
      expect(spec.issues[0].reason).toMatch(/unsafe path/);
    });

    it.each([['0'], ['-2'], ['1.5']])('refuses line %s', (line) => {
      const spec = parseBreadcrumbBlock(`tag: ${TAG}\nsites:\n  - rel_path: a.py\n    line: ${line}\n`);
      expect(spec.issues).toHaveLength(1);
    });
  });
});

describe('the card', () => {
  function render(
    overrides: {
      block?: string;
      documentProjectRoot?: string | null;
      editable?: boolean;
      previewFile?: (path: string, options?: { line?: number }) => void;
    } = {},
  ): HTMLElement {
    // Attached to the document because the renderer's live repaint is guarded
    // on `host.isConnected` — the NodeView attaches a host only after a
    // successful render, which is what makes a superseded render's callback a
    // no-op. A detached host in a test would silently never repaint.
    const el = document.createElement('div');
    document.body.appendChild(el);
    attachedHosts.push(el);
    renderBreadcrumbCard(overrides.block ?? BLOCK, el, {
      theme: 'dark',
      blockId: 'b1',
      editable: overrides.editable ?? true,
      host: {
        openFile: () => {},
        previewFile: overrides.previewFile ?? (() => {}),
        // `??` would swallow an explicit null, which is exactly the case under test.
        documentProjectRoot: () =>
          'documentProjectRoot' in overrides ? overrides.documentProjectRoot! : '/repo',
        projectRootById: () => null,
      },
      commit: () => {},
    });
    return el;
  }

  const chip = (el: HTMLElement, i = 0) =>
    el.querySelector<HTMLButtonElement>(`[data-testid="breadcrumb-site-${i}"]`)!;
  const provenance = (el: HTMLElement) => el.querySelector('[data-testid="breadcrumb-provenance"]')!;

  it('draws the tag and the authored sites', () => {
    post.mockResolvedValue({ code: [] });
    const el = render();
    expect(el.querySelector('[data-testid="breadcrumb-tag"]')?.textContent).toBe(TAG);
    expect(chip(el).textContent).toContain('tests/unit/test_catchup.py:41');
    expect(el.textContent).toContain(NOTE);
  });

  /* One click = peek. Opening the file for real is the deliberate step inside
   * the preview, exactly as on the interface card's source chip. */
  it('previews the resolved absolute path at the line when clicked', () => {
    post.mockResolvedValue({ code: [] });
    const previewFile = vi.fn();
    chip(render({ previewFile })).click();
    expect(previewFile).toHaveBeenCalledWith('/repo/tests/unit/test_catchup.py', { line: 41 });
  });

  /* Navigating is a read action, and a read-only surface is where following a
   * breadcrumb to its test matters most. */
  it('stays clickable on a read-only document', () => {
    post.mockResolvedValue({ code: [] });
    const previewFile = vi.fn();
    chip(render({ editable: false, previewFile })).click();
    expect(previewFile).toHaveBeenCalled();
  });

  it('disables an unresolvable site and says why', () => {
    const el = render({ documentProjectRoot: null });
    const button = chip(el);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-reason')).toBe('No project open to resolve this path against');
  });

  it('does not touch the route when there is no project root', () => {
    render({ documentProjectRoot: null });
    expect(post).not.toHaveBeenCalled();
  });

  it('shows a malformed row rather than dropping it', () => {
    post.mockResolvedValue({ code: [] });
    const el = render({ block: `tag: ${TAG}\nsites:\n  - line: 3\n` });
    const issue = el.querySelector<HTMLButtonElement>('[data-testid="breadcrumb-issue-0"]')!;
    expect(issue.disabled).toBe(true);
    expect(issue.getAttribute('data-reason')).toMatch(/rel_path/);
  });

  it('reports an empty tag with no sites', () => {
    post.mockResolvedValue({ code: [] });
    const el = render({ block: `tag: ${TAG}\n` });
    expect(el.querySelector('[data-testid="breadcrumb-empty"]')).not.toBeNull();
  });

  describe('the live refresh', () => {
    it('paints authored rows first, then replaces them with the index answer', async () => {
      let release!: (value: unknown) => void;
      post.mockReturnValue(new Promise((resolve) => (release = resolve)));

      const el = render();
      expect(provenance(el).getAttribute('data-provenance')).toBe('pending');
      expect(chip(el).textContent).toContain('tests/unit/test_catchup.py:41');

      release({ code: [{ path: 'tests/unit/test_moved.py', line: 9, tags: { [TAG]: 'moved' } }] });
      await vi.waitFor(() => expect(provenance(el).getAttribute('data-provenance')).toBe('live'));
      expect(chip(el).textContent).toContain('tests/unit/test_moved.py:9');
      expect(el.textContent).toContain('moved');
    });

    /* A backend that is down is not the author's fault: the authored rows stay,
     * and the complaint goes to the card's own status line rather than to the
     * NodeView's "your source is wrong" chip. */
    it('keeps the authored rows and explains itself when the index is unreachable', async () => {
      post.mockRejectedValue(new Error('Network Error'));
      const el = render();
      await vi.waitFor(() =>
        expect(el.querySelector('[data-testid="breadcrumb-status"]')?.textContent).toMatch(/Network Error/),
      );
      expect(chip(el).textContent).toContain('tests/unit/test_catchup.py:41');
      expect(provenance(el).getAttribute('data-provenance')).toBe('authored');
    });

    it('re-asks the index when the refresh control is used', async () => {
      post.mockResolvedValue({ code: [{ path: 'a.py', line: 1, tags: { [TAG]: 'n' } }] });
      const el = render();
      await vi.waitFor(() => expect(provenance(el).getAttribute('data-provenance')).toBe('live'));

      el.querySelector<HTMLButtonElement>('[data-testid="breadcrumb-refresh"]')!.click();
      await vi.waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    });

    it('offers no refresh control when there is no project to resolve against', () => {
      const el = render({ documentProjectRoot: null });
      expect(el.querySelector('[data-testid="breadcrumb-refresh"]')).toBeNull();
    });
  });
});
