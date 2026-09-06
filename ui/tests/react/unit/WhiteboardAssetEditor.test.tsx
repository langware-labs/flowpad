/**
 * WhiteboardAssetEditor — RTL coverage.
 *
 * Asserts:
 *   1. Lazy Suspense mounts → Excalidraw appears after promise resolution.
 *   2. onChange → debounced 750ms → exactly one PUT to board.json with the
 *      wrapped {kind:"excalidraw",version:1,data:...} payload.
 *   3. WHITE_BOARD.md PUT splices the mermaid block between the auto-markers
 *      AND preserves prose written outside the markers.
 *   4. thumbnail.svg PUT fires after board.json.
 *   5. "Import mermaid → board" dialog flow: opens, accepts text, calls
 *      parseMermaidToExcalidraw, updateScene, then debounce-saves.
 *
 * Strategy: mock @excalidraw/excalidraw with a stub <Excalidraw> that exposes
 * a data-testid="trigger-change" button to fire onChange on demand. Mock
 * @excalidraw/mermaid-to-excalidraw similarly. Fake timers drive the debounce.
 */
import { act, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import React from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock @excalidraw/excalidraw before the editor import ─────────────────────
const exportToSvgMock = vi.fn(async () => {
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('data-stub', 'thumb');
  return el;
});

vi.mock('@excalidraw/excalidraw', () => {
  type CtxApi = {
    updateScene: (scene: { elements: unknown[] }) => void;
    getSceneElements: () => unknown[];
    getAppState: () => unknown;
    getFiles: () => unknown;
  };
  const ExcalidrawStub = (props: {
    initialData?: unknown;
    onChange?: (els: unknown, app: unknown, files: unknown) => void;
    excalidrawAPI?: (api: CtxApi) => void;
    theme?: 'light' | 'dark';
    UIOptions?: unknown;
    children?: React.ReactNode;
  }) => {
    const elementsRef = React.useRef<unknown[]>(
      ((props.initialData as { elements?: unknown[] })?.elements ?? []) as unknown[],
    );
    React.useEffect(() => {
      if (!props.excalidrawAPI) return;
      props.excalidrawAPI({
        updateScene: ({ elements }) => {
          elementsRef.current = elements;
        },
        getSceneElements: () => elementsRef.current,
        getAppState: () => ({}),
        getFiles: () => ({}),
      });
    }, [props]);
    return (
      <div data-testid="excalidraw-stub" data-theme={props.theme ?? ''}>
        <pre data-testid="current-elements">{JSON.stringify(elementsRef.current)}</pre>
        <button
          data-testid="trigger-change"
          onClick={() =>
            props.onChange?.(
              [{ id: 'r1', type: 'rectangle' }],
              { theme: 'light' },
              {},
            )
          }
        >
          fire change
        </button>
        <button
          data-testid="trigger-viewport-change"
          onClick={() => props.onChange?.(elementsRef.current, { zoom: 2 }, {})}
        >
          fire viewport change
        </button>
        {props.children}
      </div>
    );
  };
  const MainMenuStub = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mainmenu-stub">{children}</div>
  );
  (MainMenuStub as unknown as { DefaultItems: Record<string, React.ComponentType> }).DefaultItems = {
    LoadScene: () => <span data-testid="menu-load" />,
    SaveAsImage: () => <span data-testid="menu-save" />,
    ClearCanvas: () => <span data-testid="menu-clear" />,
  };
  return {
    Excalidraw: ExcalidrawStub,
    MainMenu: MainMenuStub,
    exportToSvg: exportToSvgMock,
    // The editor materializes mermaid-import skeletons via this helper before
    // calling updateScene — the test passes pre-shaped elements, so identity is fine.
    convertToExcalidrawElements: (skel: unknown[]) => skel,
  };
});

// ── Mock the mermaid-to-excalidraw lib ───────────────────────────────────────
const parseMermaidMock = vi.fn(async (_text: string) => ({
  elements: [
    { id: 'imp1', type: 'rectangle' },
    { id: 'imp2', type: 'rectangle' },
  ],
}));
vi.mock('@excalidraw/mermaid-to-excalidraw', () => ({
  parseMermaidToExcalidraw: parseMermaidMock,
}));

// ── Mock the mermaid serializer (we just need a stable token in output) ─────
vi.mock(
  '@src/components/assets/editor/whiteboard/excalidrawToMermaid',
  () => ({
    excalidrawToMermaid: (_d: unknown) => 'flowchart TD\n  N1[Stub]\n',
  }),
);

// Now import the editor — its lazy(() => import('@excalidraw/excalidraw'))
// resolves via the mock above.
// eslint-disable-next-line import/first
import { WhiteboardAssetEditor } from '@src/components/assets/editor/whiteboard/WhiteboardAssetEditor';

function renderEditor(fsRef: import('@sdk').FSRef, whiteboard?: import('@sdk').Whiteboard) {
  return render(
    <MemoryRouter>
      <WhiteboardAssetEditor fsRef={fsRef} whiteboard={whiteboard} />
    </MemoryRouter>,
  );
}

/** A tiny FSRef-shaped stub the editor can call. */
function makeFsRef(name: string, files: Record<string, string>, writeLog: Array<{ path: string; body: string }>) {
  return {
    name,
    child(childName: string) {
      const full = `${name}/${childName}`;
      return {
        name: childName,
        async read(): Promise<string> {
          if (full in files) return files[full];
          throw new Error('not found');
        },
        async readIfExists(): Promise<string | null> {
          return full in files ? files[full] : null;
        },
        async write(body: string): Promise<void> {
          files[full] = body;
          writeLog.push({ path: full, body });
        },
        child: () => {
          throw new Error('child of child not used');
        },
      };
    },
  } as unknown as import('@sdk').FSRef;
}

const INITIAL_BOARD = JSON.stringify({
  kind: 'excalidraw',
  version: 1,
  data: { elements: [], appState: {}, files: {} },
});

describe('WhiteboardAssetEditor', () => {
  let writeLog: Array<{ path: string; body: string }>;
  let files: Record<string, string>;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    exportToSvgMock.mockClear();
    parseMermaidMock.mockClear();
    writeLog = [];
    files = {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lazy-mounts Excalidraw and fires no PUTs on idle', async () => {
    files['root/board.json'] = INITIAL_BOARD;
    const fsRef = makeFsRef('root', files, writeLog);

    renderEditor(fsRef);

    await waitFor(() => expect(screen.queryByTestId('whiteboard-editor')).not.toBeNull());
    await waitFor(() => expect(screen.queryByTestId('trigger-change')).not.toBeNull());
    expect(writeLog).toHaveLength(0);
  });

  it('marks only durable canvas changes, not viewport-only callbacks', async () => {
    files['root/board.json'] = INITIAL_BOARD;
    const fsRef = makeFsRef('root', files, writeLog);
    const markEdit = vi.fn();

    renderEditor(fsRef, { markEdit } as unknown as import('@sdk').Whiteboard);

    await screen.findByTestId('excalidraw-stub');
    await userEvent.click(screen.getByTestId('trigger-viewport-change'));
    expect(markEdit).not.toHaveBeenCalled();

    await userEvent.click(screen.getByTestId('trigger-change'));
    expect(markEdit).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByTestId('trigger-change'));
    expect(markEdit).toHaveBeenCalledTimes(1);
  });

  it('loads plain Excalidraw scene JSON without treating it as an empty wrapped board', async () => {
    files['root/board.json'] = JSON.stringify({
      elements: [{ id: 'plain-1', type: 'rectangle' }],
      appState: { theme: 'light' },
      files: {},
    });
    const fsRef = makeFsRef('root', files, writeLog);

    renderEditor(fsRef);

    await screen.findByTestId('whiteboard-editor');
    await waitFor(() =>
      expect(screen.getByTestId('current-elements').textContent).toContain('plain-1'),
    );
    expect(writeLog).toHaveLength(0);
  });

  it('debounces onChange → one PUT each to board.json, WHITE_BOARD.md, thumbnail.svg', async () => {
    files['root/board.json'] = INITIAL_BOARD;
    files['root/WHITE_BOARD.md'] =
      '---\nname: t\n---\n\n# t\n\n<!-- BEGIN whiteboard:auto -->\n```mermaid\nold\n```\n<!-- END whiteboard:auto -->\n\n## Human notes\n\nKept verbatim with [[a link]].\n';
    const fsRef = makeFsRef('root', files, writeLog);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor(fsRef);

    const trigger = await screen.findByTestId('trigger-change');

    // Five rapid clicks → only one save after debounce window.
    for (let i = 0; i < 5; i++) await user.click(trigger);

    // Run pending timers (debounce + chained async writes).
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    // Allow the awaited writes inside persist() to settle.
    await waitFor(() =>
      expect(writeLog.filter((w) => w.path === 'root/board.json')).toHaveLength(1),
    );
    await waitFor(() =>
      expect(writeLog.filter((w) => w.path === 'root/WHITE_BOARD.md')).toHaveLength(1),
    );
    await waitFor(() =>
      expect(writeLog.filter((w) => w.path === 'root/thumbnail.svg')).toHaveLength(1),
    );

    const boardWrite = writeLog.find((w) => w.path === 'root/board.json')!;
    const parsed = JSON.parse(boardWrite.body);
    expect(parsed.kind).toBe('excalidraw');
    expect(parsed.version).toBe(1);
    expect(parsed.data.elements).toEqual([{ id: 'r1', type: 'rectangle' }]);

    const docWrite = writeLog.find((w) => w.path === 'root/WHITE_BOARD.md')!;
    expect(docWrite.body).toMatch(/<!-- BEGIN whiteboard:auto -->/);
    expect(docWrite.body).toMatch(/<!-- END whiteboard:auto -->/);
    expect(docWrite.body).toMatch(/N1\[Stub\]/);
    // Human content outside the markers MUST survive.
    expect(docWrite.body).toMatch(/## Human notes/);
    expect(docWrite.body).toMatch(/\[\[a link\]\]/);
    // The stale `old` content inside the markers must be gone.
    expect(docWrite.body).not.toMatch(/```mermaid\s*\nold/);
  });

  it('appends the mermaid block when WHITE_BOARD.md has no markers yet', async () => {
    files['root/board.json'] = INITIAL_BOARD;
    files['root/WHITE_BOARD.md'] = '---\nname: t\n---\n\n# t\n\nNo markers here.\n';
    const fsRef = makeFsRef('root', files, writeLog);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor(fsRef);

    const trigger = await screen.findByTestId('trigger-change');
    await user.click(trigger);

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(writeLog.filter((w) => w.path === 'root/WHITE_BOARD.md')).toHaveLength(1),
    );
    const docWrite = writeLog.find((w) => w.path === 'root/WHITE_BOARD.md')!;
    expect(docWrite.body).toMatch(/No markers here\./); // preserved
    expect(docWrite.body).toMatch(/<!-- BEGIN whiteboard:auto -->[\s\S]*N1\[Stub\][\s\S]*<!-- END whiteboard:auto -->/);
  });

  it('Import mermaid dialog → parseMermaidToExcalidraw → save', async () => {
    files['root/board.json'] = INITIAL_BOARD;
    files['root/WHITE_BOARD.md'] = '---\nname: t\n---\n\n# t\n';
    const fsRef = makeFsRef('root', files, writeLog);

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor(fsRef);

    // Wait for the Excalidraw stub to mount so the API ref is captured.
    await screen.findByTestId('trigger-change');

    await user.click(screen.getByTestId('open-import-mermaid'));
    const textarea = await screen.findByTestId('mermaid-import-textarea');
    await user.type(textarea, 'flowchart TD\\n  X-->Y');
    await user.click(screen.getByTestId('confirm-import-mermaid'));

    await waitFor(() => expect(parseMermaidMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(writeLog.filter((w) => w.path === 'root/board.json')).toHaveLength(1),
    );
    const boardWrite = writeLog.find((w) => w.path === 'root/board.json')!;
    const parsed = JSON.parse(boardWrite.body);
    // Imported elements come from the mermaid mock — two rectangles.
    expect(parsed.data.elements).toHaveLength(2);
    expect((parsed.data.elements as Array<{ id: string }>)[0].id).toBe('imp1');
  });
});
