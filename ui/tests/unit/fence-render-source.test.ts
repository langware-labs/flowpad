/**
 * Source-grounded interface blocks: parsing the `source` pointer and resolving
 * it to a local path.
 *
 * The parse half leans on the SDK's own `normalizeFSOrigin` / `isSafeRelPath`,
 * so these tests pin that we actually inherit its rules (notably
 * missing-`kind`-means-git) rather than re-deriving them here.
 */

import { renderInterfaceCard } from '@src/components/milkdown-editor/plugins/fence-render/renderers/interface';
import { parseInterfaceBlock } from '@src/components/milkdown-editor/plugins/fence-render/renderers/interface-schema';
import {
  formatSourceLabel,
  resolveSourceLocation,
  type SourceResolveContext,
} from '@src/components/milkdown-editor/plugins/fence-render/renderers/source-location';
import type { FSOriginField } from '@sdk';
import { describe, expect, it, vi } from 'vitest';

const GIT_BLOCK = `name: createTask
source:
  origin:
    kind: git
    provider: github
    owner: langware
    name: flowpad
    branch: main
    rel_path: flow_sdk/api/tasks.py
  line: 42
`;

function gitOrigin(overrides: Partial<FSOriginField> = {}): FSOriginField {
  return {
    kind: 'git',
    provider: 'github',
    owner: 'langware',
    name: 'flowpad',
    branch: 'main',
    rel_path: 'flow_sdk/api/tasks.py',
    ...overrides,
  } as FSOriginField;
}

function ctx(overrides: Partial<SourceResolveContext> = {}): SourceResolveContext {
  return {
    documentProjectRoot: '/repo',
    projectRootById: () => null,
    ...overrides,
  };
}

describe('parsing source', () => {
  it('parses a git origin with a line', () => {
    const spec = parseInterfaceBlock(GIT_BLOCK);
    expect(spec.source?.line).toBe(42);
    expect(spec.source?.origin).toMatchObject({
      kind: 'git',
      owner: 'langware',
      name: 'flowpad',
      rel_path: 'flow_sdk/api/tasks.py',
    });
  });

  it('parses a local origin', () => {
    const spec = parseInterfaceBlock(
      'name: f\nsource:\n  origin:\n    kind: local\n    base: /Users/me/dev/flowpad\n    rel_path: a/b.ts\n  line: 7\n',
    );
    expect(spec.source?.origin).toMatchObject({ kind: 'local', base: '/Users/me/dev/flowpad' });
  });

  /*
   * The tolerance rule the backend discriminator uses for origins persisted
   * before `kind` existed. We inherit it by going through `normalizeFSOrigin`
   * rather than validating the union ourselves.
   */
  it('treats a missing kind as git', () => {
    const spec = parseInterfaceBlock(
      'name: f\nsource:\n  origin:\n    provider: github\n    owner: o\n    name: n\n    rel_path: a.py\n',
    );
    expect(spec.source?.origin.kind).toBe('git');
  });

  it('carries project_id through when present', () => {
    const spec = parseInterfaceBlock(
      'name: f\nsource:\n  origin:\n    kind: local\n    base: /x\n    rel_path: a.ts\n    project_id: proj-1\n',
    );
    expect(spec.source?.origin.project_id).toBe('proj-1');
  });

  it('leaves source undefined when the block has none', () => {
    expect(parseInterfaceBlock('name: ping').source).toBeUndefined();
  });

  it('allows a source with no line', () => {
    const spec = parseInterfaceBlock(
      'name: f\nsource:\n  origin:\n    kind: local\n    base: /x\n    rel_path: a.ts\n',
    );
    expect(spec.source?.line).toBeUndefined();
  });

  it('rejects an unsafe rel_path', () => {
    expect(() =>
      parseInterfaceBlock(
        'name: f\nsource:\n  origin:\n    kind: local\n    base: /x\n    rel_path: ../../etc/passwd\n',
      ),
    ).toThrow(/unsafe or missing path/i);
  });

  it('rejects an unsupported origin kind with the SDK message', () => {
    expect(() =>
      parseInterfaceBlock('name: f\nsource:\n  origin:\n    kind: s3\n    rel_path: a.ts\n'),
    ).toThrow(/Unsupported filesystem origin kind: s3/);
  });

  it('rejects a non-positive or fractional line', () => {
    const withLine = (line: string) =>
      `name: f\nsource:\n  origin:\n    kind: local\n    base: /x\n    rel_path: a.ts\n  line: ${line}\n`;
    expect(() => parseInterfaceBlock(withLine('0'))).toThrow(/line/);
    expect(() => parseInterfaceBlock(withLine('-3'))).toThrow(/line/);
    expect(() => parseInterfaceBlock(withLine('1.5'))).toThrow(/line/);
  });
});

describe('resolving source to a local path', () => {
  it('resolves a git origin against the document project root', () => {
    const source = { origin: gitOrigin(), line: 42 };
    expect(resolveSourceLocation(source, ctx())).toEqual({
      ok: true,
      path: '/repo/flow_sdk/api/tasks.py',
      line: 42,
    });
  });

  it('resolves a local origin against its own base, with no project involved', () => {
    const source = {
      origin: { kind: 'local', base: '/Users/me/dev/x', rel_path: 'a/b.ts' } as FSOriginField,
    };
    expect(resolveSourceLocation(source, ctx({ documentProjectRoot: null }))).toEqual({
      ok: true,
      path: '/Users/me/dev/x/a/b.ts',
      line: undefined,
    });
  });

  /* An explicit project is the only part of a locator that names a place on
   * THIS machine, so it must win over anything inferred from context. */
  it('prefers project_id over the document project', () => {
    const source = { origin: gitOrigin({ project_id: 'proj-1' }) };
    const result = resolveSourceLocation(
      source,
      ctx({ projectRootById: (id) => (id === 'proj-1' ? '/other' : null) }),
    );
    expect(result).toMatchObject({ ok: true, path: '/other/flow_sdk/api/tasks.py' });
  });

  it('normalizes away duplicate and trailing slashes', () => {
    const source = { origin: gitOrigin({ rel_path: 'a//b.ts' }) };
    expect(resolveSourceLocation(source, ctx({ documentProjectRoot: '/repo/' }))).toMatchObject({
      ok: true,
      path: '/repo/a/b.ts',
    });
  });

  describe('failures each carry their own reason', () => {
    it('unknown project_id', () => {
      const source = { origin: gitOrigin({ project_id: 'ghost' }) };
      expect(resolveSourceLocation(source, ctx())).toEqual({
        ok: false,
        reason: 'No local project ghost',
      });
    });

    it('git origin with no project in context', () => {
      expect(resolveSourceLocation({ origin: gitOrigin() }, ctx({ documentProjectRoot: null }))).toEqual({
        ok: false,
        reason: 'No project open to resolve this origin against',
      });
    });

    it('local origin with no base', () => {
      const source = { origin: { kind: 'local', base: '', rel_path: 'a.ts' } as FSOriginField };
      expect(resolveSourceLocation(source, ctx())).toEqual({
        ok: false,
        reason: 'Local origin has no base path',
      });
    });

    it('unsafe rel_path is refused at the resolver too, not only at parse', () => {
      const source = { origin: gitOrigin({ rel_path: '../escape.ts' }) };
      expect(resolveSourceLocation(source, ctx())).toMatchObject({ ok: false });
    });
  });
});

describe('formatSourceLabel', () => {
  it('labels a git origin with repo, branch, path and line', () => {
    expect(formatSourceLabel({ origin: gitOrigin(), line: 42 })).toBe(
      'langware/flowpad · main — flow_sdk/api/tasks.py:42',
    );
  });

  it('omits the line when there is none', () => {
    expect(formatSourceLabel({ origin: gitOrigin() })).toBe(
      'langware/flowpad · main — flow_sdk/api/tasks.py',
    );
  });

  it('labels a local origin with its path', () => {
    const origin = { kind: 'local', base: '/x', rel_path: 'a/b.ts' } as FSOriginField;
    expect(formatSourceLabel({ origin, line: 3 })).toBe('/x/a/b.ts:3');
  });
});

describe('source row on the card', () => {
  const BLOCK = GIT_BLOCK;

  function render(overrides: {
    editable?: boolean;
    documentProjectRoot?: string | null;
    openFile?: (path: string, options?: { line?: number }) => void;
    previewFile?: (path: string, options?: { line?: number }) => void;
  } = {}): HTMLElement {
    const el = document.createElement('div');
    renderInterfaceCard(BLOCK, el, {
      theme: 'dark',
      blockId: 'b1',
      editable: overrides.editable ?? true,
      host: {
        openFile: overrides.openFile ?? (() => {}),
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

  function chip(el: HTMLElement): HTMLButtonElement {
    return el.querySelector<HTMLButtonElement>('[data-testid="interface-source"]')!;
  }

  it('renders the provenance label', () => {
    expect(chip(render()).textContent).toContain('langware/flowpad · main — flow_sdk/api/tasks.py:42');
  });

  /* One click = peek. Opening the file for real happens inside the preview. */
  it('previews the resolved path at the line when clicked', () => {
    const previewFile = vi.fn();
    const openFile = vi.fn();
    chip(render({ previewFile, openFile })).click();
    expect(previewFile).toHaveBeenCalledWith('/repo/flow_sdk/api/tasks.py', { line: 42 });
    expect(openFile).not.toHaveBeenCalled();
  });

  it('disables the chip and carries the reason when unresolvable', () => {
    const button = chip(render({ documentProjectRoot: null }));
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('data-reason')).toBe('No project open to resolve this origin against');
  });

  /*
   * The deliberate exception to the read-only rule: every other control hides
   * because it mutates the document. Navigating does not, and a read-only
   * surface is exactly where following a contract to its source matters most.
   */
  it('stays enabled when the host is read-only', () => {
    const previewFile = vi.fn();
    const el = render({ editable: false, previewFile });
    expect(el.querySelectorAll('[contenteditable="true"]')).toHaveLength(0);

    const button = chip(el);
    expect(button.disabled).toBe(false);
    button.click();
    expect(previewFile).toHaveBeenCalled();
  });

  it('renders no source row for a block without one', () => {
    const el = document.createElement('div');
    renderInterfaceCard('name: ping', el, {
      theme: 'dark',
      blockId: 'b1',
      editable: true,
      host: {
        openFile: () => {},
        previewFile: () => {},
        documentProjectRoot: () => '/repo',
        projectRootById: () => null,
      },
      commit: () => {},
    });
    expect(el.querySelector('[data-testid="interface-source"]')).toBeNull();
  });
});
