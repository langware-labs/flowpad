// The lw (langware) cards: ```statements, ```requirements and ```test_debug fences (docs/lw.md).
import { describe, expect, it, vi } from 'vitest';
import { getFenceRenderer } from '@src/components/milkdown-editor/plugins/fence-render/registry';
import { lwChrome, renderLwCard, renderTestDebugCard } from '@src/components/milkdown-editor/plugins/fence-render/renderers/lw';
import type { LwBlockKind } from '@src/components/milkdown-editor/plugins/fence-render/renderers/lw-schema';

const STATEMENTS = `tag: machine_access.remote_control
depends_on:
  - machine_access.connected_machine
  - machine_access.privileged_access
statements:
  - text: Remote control is flow connect with a node created locked.
    basis: stated
    issues:
      - Remote control uses only the first half of flow connect.
      - No node carries a "locked" setting.
    about:
      - flow_sdk/core/compute/hub_node.py:46
  - text: A machine may protect its privileged access with a device passkey.
    basis: proven
`;

const REQUIREMENTS = `tag: machine_access.remote_control.build
depends_on:
  - machine_access.remote_control
requirements:
  - text: Remote control runs the whole flow connect path.
  - text: The machine is the authority for "locked".
`;

function render(
  kind: LwBlockKind,
  source: string,
  overrides: {
    root?: string | null;
    previewFile?: (path: string, options?: { line?: number }) => void;
    view?: string;
    editable?: boolean;
    commit?: (next: string) => void;
  } = {},
): HTMLElement {
  const host = document.createElement('div');
  renderLwCard(kind, source, host, {
    theme: 'dark',
    blockId: 'b1',
    editable: overrides.editable ?? false,
    host: {
      openFile: () => {},
      previewFile: overrides.previewFile ?? (() => {}),
      documentProjectRoot: () => ('root' in overrides ? overrides.root! : '/repo'),
      projectRootById: () => null,
    },
    commit: overrides.commit ?? (() => {}),
    view: overrides.view,
  });
  return host;
}

const texts = (host: HTMLElement, testId: string) =>
  [...host.querySelectorAll(`[data-testid="${testId}"]`)].map((node) => node.textContent);

describe('a statements card', () => {
  it('shows what it depends on and one row per statement: the sentence and its basis, nothing else', () => {
    const host = render('statements', STATEMENTS);
    expect(texts(host, 'lw-depends-on')).toEqual(['machine_access.connected_machine', 'machine_access.privileged_access']);
    expect(texts(host, 'lw-statement')).toEqual([
      'Remote control is flow connect with a node created locked.stated',
      'A machine may protect its privileged access with a device passkey.proven',
    ]);
    // The tag is the tab row's (`chrome`); issues and files have tabs of their own.
    for (const gone of ['lw-tag', 'lw-verdict', 'lw-issue', 'lw-file']) {
      expect(host.querySelector(`[data-testid="${gone}"]`)).toBeNull();
    }
  });

  it('names its tag, and an Issues and a References tab with their counts', () => {
    expect(lwChrome('statements', STATEMENTS)).toEqual({
      tag: 'machine_access.remote_control',
      views: [
        { id: 'issues', label: 'Issues', count: 2, tone: 'warn' },
        { id: 'references', label: 'References', count: 1 },
      ],
    });
  });

  it('has no Issues tab with no issues, and no References tab with no files', () => {
    expect(lwChrome('statements', 'tag: a.b\nstatements:\n  - text: x\n')).toEqual({ tag: 'a.b', views: [] });
    expect(lwChrome('requirements', REQUIREMENTS)).toEqual({ tag: 'machine_access.remote_control.build', views: [] });
  });

  it('lists on the Issues tab each violated statement with its issues', () => {
    const host = render('statements', STATEMENTS, { view: 'issues' });
    expect(texts(host, 'lw-issues-of')).toHaveLength(1);
    expect(host.querySelector('[data-testid="lw-issues-of"] .lw-card-text')!.textContent).toBe(
      'Remote control is flow connect with a node created locked.',
    );
    expect(texts(host, 'lw-verdict')).toEqual(['2 issues']);
    expect(texts(host, 'lw-issue')).toEqual([
      'Remote control uses only the first half of flow connect.',
      'No node carries a "locked" setting.',
    ]);
  });

  it('lists on the References tab the files of each statement, and opens one at its line', () => {
    const previewFile = vi.fn();
    const host = render('statements', STATEMENTS, { view: 'references', previewFile });
    expect(texts(host, 'lw-references-of')).toHaveLength(1);
    const chip = host.querySelector<HTMLButtonElement>('[data-testid="lw-file"]')!;
    expect(chip.textContent).toBe('flow_sdk/core/compute/hub_node.py:46');
    chip.click();
    expect(previewFile).toHaveBeenCalledWith('/repo/flow_sdk/core/compute/hub_node.py', { line: 46 });
  });

  it('keeps the file chip, disabled with the reason, when the doc has no project', () => {
    const chip = render('statements', STATEMENTS, { root: null, view: 'references' }).querySelector<HTMLButtonElement>(
      '[data-testid="lw-file"]',
    )!;
    expect(chip.disabled).toBe(true);
    expect(chip.title).not.toBe('');
  });

  it('writes a sentence typed in an editable doc into the block, and nothing else', () => {
    const commit = vi.fn();
    const host = render('statements', STATEMENTS, { editable: true, commit });
    const field = host.querySelector<HTMLElement>('[data-testid="lw-statement-text-0"]')!;
    expect(field.getAttribute('contenteditable')).toBe('true');
    field.textContent = 'Remote control is flow connect with a node created unlocked.';
    field.dispatchEvent(new FocusEvent('blur'));
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.calls[0][0]).toBe(
      STATEMENTS.replace('with a node created locked.', 'with a node created unlocked.'),
    );
    // The card redrew from the new source, so the next edit starts from it.
    expect(host.querySelector('[data-testid="lw-statement-text-0"]')!.textContent).toContain('unlocked');
  });

  it('keeps select-all inside the field being edited', () => {
    const host = render('statements', STATEMENTS, { editable: true });
    document.body.appendChild(host);
    const field = host.querySelector<HTMLElement>('[data-testid="lw-statement-text-0"]')!;
    const key = new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true });
    field.dispatchEvent(key);
    expect(key.defaultPrevented).toBe(true);
    expect(document.getSelection()!.toString()).toBe('Remote control is flow connect with a node created locked.');
    host.remove();
  });

  it('draws the sentence as plain text in a read-only doc', () => {
    const field = render('statements', STATEMENTS).querySelector('[data-testid="lw-statement-text-0"]')!;
    expect(field.hasAttribute('contenteditable')).toBe(false);
  });

  it('shows text as text, never as markup', () => {
    const host = render('statements', 'tag: a\nstatements:\n  - text: "<img src=x onerror=alert(1)> is text"\n');
    expect(host.querySelector('img')).toBeNull();
    expect(texts(host, 'lw-statement')[0]).toContain('<img src=x onerror=alert(1)> is text');
  });

  it('refuses a block that does not match the schema', () => {
    expect(() => render('statements', 'tag: a\nstatements:\n  - id: S1\n    text: x\n')).toThrow(/statements\.0/);
  });
});

describe('a requirements card', () => {
  it('shows the statements it implements and its requirements', () => {
    const host = render('requirements', REQUIREMENTS);
    expect(host.textContent).toContain('Implements');
    expect(texts(host, 'lw-depends-on')).toEqual(['machine_access.remote_control']);
    expect(texts(host, 'lw-requirement')).toEqual([
      'Remote control runs the whole flow connect path.',
      'The machine is the authority for "locked".',
    ]);
    expect(host.querySelector('[data-testid="lw-verdict"]')).toBeNull();
  });
});

describe('registration', () => {
  it('draws both fence languages as document-width cards', () => {
    expect(getFenceRenderer('statements')?.layout).toBe('block');
    expect(getFenceRenderer('requirements')?.tabLabel).toBe('Requirements');
  });
});

const TEST_DEBUG = `tag: breadcrumb.test.agent_activity_readout.rules
depends_on:
  - breadcrumb.test.live_frame_identity.rules
sites:
  - rel_path: "ui/tests/unit/chat-activity-readout.test.tsx"
    line: 49
    note: "FAILING? read this tag's rules before editing"
  - rel_path: "ui/tests/unit/chat-activity-readout.test.tsx"
    line: 231
proven: "2026-08-13 · FLOWPAD-1980"
statements:
  - text: The activity line takes the process and nothing else.
    about: ["ui/src/components/chat/ChatActivityReadout.tsx"]
  - text: A frame stays on screen for at least 500 ms.
  - text: It renders nothing when the process is idle.
`;

describe('a test-debug card', () => {
  const draw = (previewFile: (path: string, options?: { line?: number }) => void = () => {}) => {
    const host = document.createElement('div');
    renderTestDebugCard(TEST_DEBUG, host, {
      theme: 'dark',
      blockId: 'b1',
      editable: false,
      // No project root: the card draws what the block says and asks no index.
      host: { openFile: () => {}, previewFile, documentProjectRoot: () => null, projectRootById: () => null },
      commit: () => {},
    });
    return host;
  };

  it('shows the tag, when it was proven, what it depends on, the bound tests and the statements', () => {
    const host = draw();
    expect(texts(host, 'lw-tag')).toEqual(['breadcrumb.test.agent_activity_readout.rules']);
    expect(texts(host, 'lw-proven')).toEqual(['proven 2026-08-13 · FLOWPAD-1980']);
    expect(texts(host, 'lw-depends-on')).toEqual(['breadcrumb.test.live_frame_identity.rules']);
    expect(host.querySelector('[data-testid="lw-site-0"]')!.textContent).toBe('ui/tests/unit/chat-activity-readout.test.tsx:49');
    expect(host.querySelector('[data-testid="lw-site-1"]')!.textContent).toBe('ui/tests/unit/chat-activity-readout.test.tsx:231');
    expect(host.textContent).toContain("FAILING? read this tag's rules before editing");
    expect(texts(host, 'lw-statement')).toHaveLength(3);
    expect(texts(host, 'lw-verdict')).toEqual(['pass', 'pass', 'pass']);
    expect(texts(host, 'lw-file')).toEqual(['ui/src/components/chat/ChatActivityReadout.tsx']);
  });

  it('is registered with the tab label the doc shows', () => {
    expect(getFenceRenderer('test_debug')).toMatchObject({ tabLabel: 'Test debug', layout: 'block' });
  });
});
