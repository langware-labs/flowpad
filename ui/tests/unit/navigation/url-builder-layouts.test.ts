/**
 * Three-layout URL grammar (docs/tab-management.md Part 3 §7):
 * build → parse → strip round-trips for dock/dev/win across all route
 * namespaces, layout detection (the `windowMode` derivation source), the
 * win-morph rule, and the layout-preserving loader redirect builder.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDockUrl,
  buildShellRedirectUrl,
  detectLayout,
  parseDockUrl,
  preserveWindowLayout,
  stripDockPortion,
} from '@src/navigation/url-builder';
import { DockPointer } from '@src/navigation/DockPointer';
import { Layout, PageId, ViewType } from '@sdk';

const LAYOUTS: Array<{ layout: Layout; keyword: string }> = [
  { layout: Layout.DOCK, keyword: 'dock' },
  { layout: Layout.DEV, keyword: 'dev' },
  { layout: Layout.WIN, keyword: 'win' },
];

const BASES: Array<{ base: string; agentId?: string; processId?: string }> = [
  { base: '' },
  { base: '/agent/agent-1', agentId: 'agent-1' },
  { base: '/agent/agent-1/flow/proc-9', agentId: 'agent-1', processId: 'proc-9' },
];

describe('url-builder three-layout round-trips', () => {
  for (const { layout, keyword } of LAYOUTS) {
    for (const { base, agentId, processId } of BASES) {
      it(`build → parse → strip round-trips ${layout} at base "${base || '/'}"`, () => {
        const url = buildDockUrl(`${base}/dock/editor/stale.ts`, ViewType.EDITOR, 'src/app.ts', undefined, layout);
        expect(url).toBe(`${base}/${keyword}/editor/src/app.ts`);

        const parsed = parseDockUrl(url);
        expect(parsed).not.toBeNull();
        expect(parsed!.layout).toBe(layout);
        expect(parsed!.viewType).toBe('editor');
        expect(parsed!.pointer).toBe('src/app.ts');
        expect(parsed!.agentId).toBe(agentId);
        expect(parsed!.processId).toBe(processId);

        expect(stripDockPortion(url)).toBe(base);
      });
    }

    it(`round-trips an encoded pointer under ${layout}`, () => {
      const url = buildDockUrl('', ViewType.EDITOR, 'src/my file.ts', undefined, layout);
      expect(url).toBe(`/${keyword}/editor/src/my%20file.ts`);
      const parsed = parseDockUrl(url);
      expect(parsed!.layout).toBe(layout);
      // parseDockUrl is encoding-preserving; DockPointer.fromUrl decodes.
      expect(decodeURIComponent(parsed!.pointer!)).toBe('src/my file.ts');
    });
  }

  it('buildDockUrl defaults to the dock layout', () => {
    expect(buildDockUrl('/agent/a', ViewType.SHELL, 'shell-1')).toBe('/agent/a/dock/shell/shell-1');
  });

  it('parseDockUrl reports Layout.WIN for /win/ URLs', () => {
    expect(parseDockUrl('/win/shell/agentic_process-123')?.layout).toBe(Layout.WIN);
  });

  it('stripDockPortion strips /win/ like the other layout keywords', () => {
    expect(stripDockPortion('/agent/a/flow/f/win/shell/shell-1')).toBe('/agent/a/flow/f');
    expect(stripDockPortion('/win/assets/list/skill')).toBe('');
  });

  it('first layout keyword wins when a pointer segment shadows another keyword', () => {
    // Historical dock-vs-dev tie-break, extended to win: the pointer may
    // legally contain a path segment named like a layout keyword.
    const parsed = parseDockUrl('/dock/editor/src/win/util.ts');
    expect(parsed!.layout).toBe(Layout.DOCK);
    expect(parsed!.pointer).toBe('src/win/util.ts');
    expect(stripDockPortion('/dock/editor/src/win/util.ts')).toBe('');
  });
});

describe('page dimension (/<layout>/<page>/<viewType>)', () => {
  it('never emits the desk page segment — bare /dock/<viewType> stays byte-identical', () => {
    // Explicit desk and the default (no page arg) both omit the segment.
    expect(buildDockUrl('', ViewType.EDITOR, 'x.ts', undefined, Layout.DOCK, PageId.DESK)).toBe('/dock/editor/x.ts');
    expect(buildDockUrl('', ViewType.EDITOR, 'x.ts')).toBe('/dock/editor/x.ts');
  });

  it('emits the page segment only for a non-desk page', () => {
    expect(buildDockUrl('', ViewType.EDITOR, 'x.ts', undefined, Layout.DOCK, PageId.HUB)).toBe('/dock/hub/editor/x.ts');
    expect(buildDockUrl('/agent/a', ViewType.SHELL, 'shell-1', undefined, Layout.WIN, PageId.HUB)).toBe(
      '/agent/a/win/hub/shell/shell-1',
    );
  });

  it('parses a known page segment into page + viewType', () => {
    const parsed = parseDockUrl('/dock/hub/editor/x.ts');
    expect(parsed!.page).toBe(PageId.HUB);
    expect(parsed!.viewType).toBe('editor');
    expect(parsed!.pointer).toBe('x.ts');
  });

  it('defaults to desk and does NOT consume the segment when it is not a known page (back-compat)', () => {
    // A real existing URL: `assets` is a viewType, not a page.
    const assets = parseDockUrl('/dock/assets/list/skill');
    expect(assets!.page).toBe(PageId.DESK);
    expect(assets!.viewType).toBe('assets');
    expect(assets!.pointer).toBe('list/skill');

    // An arbitrary unknown first segment is left as the viewType, unchanged.
    const unknown = parseDockUrl('/dock/notapage/foo');
    expect(unknown!.page).toBe(PageId.DESK);
    expect(unknown!.viewType).toBe('notapage');
    expect(unknown!.pointer).toBe('foo');
  });

  it('DockPointer round-trips the page through toUrl → fromUrl for both pages', () => {
    const desk = new DockPointer(ViewType.EDITOR, 'x.ts', {}, Layout.DOCK, PageId.DESK);
    expect(desk.toUrl()).toBe('/dock/editor/x.ts');
    expect(DockPointer.fromUrl(desk.toUrl()).page).toBe(PageId.DESK);

    const hub = new DockPointer(ViewType.EDITOR, 'x.ts', {}, Layout.DOCK, PageId.HUB);
    expect(hub.toUrl()).toBe('/dock/hub/editor/x.ts');
    expect(DockPointer.fromUrl(hub.toUrl()).page).toBe(PageId.HUB);
  });
});

describe('detectLayout (windowMode derivation source)', () => {
  it('derives WIN from win URLs', () => {
    expect(detectLayout('/win/shell/shell-1')).toBe(Layout.WIN);
    expect(detectLayout('/agent/a/flow/f/win/editor/x.ts')).toBe(Layout.WIN);
  });

  it('derives DOCK / DEV from their URLs and DOCK for layout-less paths', () => {
    expect(detectLayout('/dock/shell/shell-1')).toBe(Layout.DOCK);
    expect(detectLayout('/agent/a/flow/f/dev/shell/shell-1')).toBe(Layout.DEV);
    expect(detectLayout('/agent/a/flow/f')).toBe(Layout.DOCK);
    expect(detectLayout('/')).toBe(Layout.DOCK);
  });
});

describe('win morph (Part 3 §7)', () => {
  it('preserves WIN for navigation initiated from inside a win URL', () => {
    expect(preserveWindowLayout('/win/shell/shell-1', Layout.DOCK)).toBe(Layout.WIN);
    expect(preserveWindowLayout('/agent/a/win/assets/list/skill', Layout.DOCK)).toBe(Layout.WIN);
  });

  it('passes the requested layout through outside win URLs', () => {
    expect(preserveWindowLayout('/dock/shell/shell-1', Layout.DOCK)).toBe(Layout.DOCK);
    expect(preserveWindowLayout('/agent/a/flow/f/dev/shell/s', Layout.DEV)).toBe(Layout.DEV);
    expect(preserveWindowLayout('/agent/a/flow/f', Layout.DOCK)).toBe(Layout.DOCK);
  });

  it('building a URL from within a win-layout current URL stays on win', () => {
    const currentUrl = '/agent/a/win/shell/agentic_process-1';
    const url = buildDockUrl(
      currentUrl,
      ViewType.EDITOR,
      'src/app.ts',
      undefined,
      preserveWindowLayout(currentUrl, Layout.DOCK),
    );
    expect(url).toBe('/agent/a/win/editor/src/app.ts');
  });
});

describe('buildShellRedirectUrl (loader redirects preserve layout)', () => {
  it('keeps a /win/shell fallback redirect inside the win layout', () => {
    expect(buildShellRedirectUrl('/win/shell/agentic_process-dead', 'shell-alive')).toBe('/win/shell/shell-alive');
    expect(buildShellRedirectUrl('/win/shell')).toBe('/win/shell');
  });

  it('keeps dock redirects byte-identical to the historical form', () => {
    expect(buildShellRedirectUrl('/dock/shell', 'agentic_process-1')).toBe('/dock/shell/agentic_process-1');
    expect(buildShellRedirectUrl('/dock/shell/old')).toBe('/dock/shell');
  });

  it('preserves the agent/flow base path', () => {
    expect(buildShellRedirectUrl('/agent/a/flow/f/win/shell', 'shell-1')).toBe('/agent/a/flow/f/win/shell/shell-1');
  });
});

describe('DockPointer.terminalTargetTypeIdForShellPointer (shell-pointer → tab-key grammar)', () => {
  const AP_ID = '6f8b7a4e-1d2c-4e5f-9a0b-3c4d5e6f7a8b';
  const SHELL_ID = '0b1c2d3e-4f5a-4b6c-8d9e-0f1a2b3c4d5e';

  it('maps an agentic_process pointer to its TypeId', () => {
    const tid = DockPointer.terminalTargetTypeIdForShellPointer(`agentic_process-${AP_ID}`);
    expect(tid.type).toBe('agentic_process');
    expect(tid.id).toBe(AP_ID);
    expect(tid.toString()).toBe(`agentic_process-${AP_ID}`);
  });

  it('passes an already-prefixed shell pointer through', () => {
    const tid = DockPointer.terminalTargetTypeIdForShellPointer(`shell-${SHELL_ID}`);
    expect(tid.type).toBe('shell');
    expect(tid.toString()).toBe(`shell-${SHELL_ID}`);
  });

  it('prefixes a bare legacy shell id', () => {
    const tid = DockPointer.terminalTargetTypeIdForShellPointer(SHELL_ID);
    expect(tid.type).toBe('shell');
    expect(tid.id).toBe(SHELL_ID);
    expect(tid.toString()).toBe(`shell-${SHELL_ID}`);
  });
});
