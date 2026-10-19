/**
 * SnippetView renders what `/api/v1/snippet/*` answers and nothing more: the
 * region rules and saving are proven in `tests/unit/test_snippet.py`, the terminal
 * run in `tests/unit/test_shell_terminal_run.py`. Here: which regions show, that the
 * toggles persist, that edits are saved by region and flushed before a Run, and that
 * a Run is the file's terminal running its command — clock, exit line, Stop.
 *
 * Monaco is stubbed with a textarea and the terminal view with a div (jsdom cannot
 * host either); `apiClient` at the transport edge; the file's Shell is real, only
 * its HTTP answers stood in for.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrefKey, instancePreferences } from '@sdk';

const mocks = vi.hoisted(() => ({
  post: vi.fn(),
  fileChanged: null as null | (() => void),
  watched: [] as string[],
  // Monaco's setModelMarkers, by the model (the region's text) it was called for.
  markers: new Map<string, Array<Record<string, unknown>>>(),
  // The terminal view's clear(), called by Run.
  clear: vi.fn(),
}));

vi.mock('@sdk/client', () => ({ __esModule: true, default: { post: mocks.post } }));
vi.mock('@sdk/react/hooks', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useFileWatch: (_typeid: unknown, path: string | undefined, onChange: () => void) => {
    if (path) mocks.watched.push(path);
    mocks.fileChanged = onChange;
  },
}));
vi.mock('@src/components/code-editor/shikiMonaco', () => ({
  ensureShikiMonaco: () => Promise.resolve(),
  monacoTheme: () => 'dark-plus',
}));
vi.mock('@monaco-editor/react', async () => {
  const { useEffect } = await import('react');
  return {
    __esModule: true,
    loader: { init: () => Promise.resolve({}) },
    default: ({
      defaultValue,
      onChange,
      onMount,
    }: {
      defaultValue: string;
      onChange: (v: string) => void;
      onMount?: (editor: unknown, monaco: unknown) => void;
    }) => {
      useEffect(() => {
        const model = { region: defaultValue };
        onMount?.(
          { getContentHeight: () => 19, onDidContentSizeChange: () => undefined, getModel: () => model },
          { editor: { setModelMarkers: (m: typeof model, _owner: string, list: Array<Record<string, unknown>>) => mocks.markers.set(m.region, list) } },
        );
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return <textarea data-testid="region-editor" defaultValue={defaultValue} onChange={(e) => onChange(e.target.value)} />;
    },
  };
});

vi.mock('@src/components/terminal/interactive-terminal/ShellTerminal', async () => {
  const { forwardRef, useImperativeHandle } = await import('react');
  return {
    ShellTerminal: forwardRef(function ShellTerminal({ shellId }: { shellId: string }, ref) {
      useImperativeHandle(ref, () => ({ clear: mocks.clear, focus: () => undefined }));
      return <div data-testid="terminal" data-shell={shellId} />;
    }),
  };
});

const { SnippetView, regionLine, formatElapsed } = await import('@src/components/code-editor/SnippetView');
const { Shell, apiClient: sdkClient } = await import('@sdk');

const PATH = '/tmp/flowpad-snippets/t.py';
const SHELL_ID = '11111111-2222-4333-8444-555555555555';
const COMMAND = "python -m flow_sdk.snippet_launch '/tmp/flowpad-snippets/t.py'";
const b64 = (text: string) => Buffer.from(text, 'utf-8').toString('base64');

/** The file's terminal: a real Shell whose `run-command` answers a marker and whose output this
 *  test prints (`finish`); `interrupt` ends the run as Ctrl-C does (exit 130). */
function fileTerminal() {
  const shell = new Shell({ id: SHELL_ID, compute_node_id: crypto.randomUUID() });
  const typed: string[] = [];
  const actions: string[] = [];
  let marker = '';
  const finish = (code: number, out = 'ok\r\n') =>
    shell.ptyConnection.appendOutput(b64(`\x1b]7770;${marker};s\x07${out}\x1b]7770;${marker};${code}\x07`));
  vi.spyOn(shell as unknown as { post: (a: string, b: { command?: string; clear?: boolean }) => Promise<unknown> }, 'post').mockImplementation(
    async (action, body) => {
      actions.push(action);
      if (action === 'run-command') {
        typed.push(`${body.clear ? '[clear] ' : ''}${body.command ?? ''}`);
        marker = `__flow_m${typed.length}`;
        return { marker };
      }
      if (action === 'interrupt') {
        setTimeout(() => finish(130, ''), 0);
        return { stopped: true };
      }
      return null;
    },
  );
  vi.spyOn(shell, 'runState').mockResolvedValue({ running_pid: null, status: 'running' });
  vi.spyOn(Shell, 'getById').mockResolvedValue(shell);
  return { shell, typed, actions, finish: (code: number, out?: string) => finish(code, out) };
}
const REGIONS = [
  { index: 0, kind: 'hidden', shown: 'import json', line: 2 },
  { index: 1, kind: 'init', shown: 'd = 1', line: 4 },
  { index: 2, kind: 'snippet', shown: 'print(d)', line: 6 },
];

function backend(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  // The SDK's own entities (Shell.forSnippet) reach the ONE client instance, not this test's module
  // mock of it — so the instance answers the same way.
  vi.spyOn(sdkClient, 'post').mockImplementation(((url: string, body: Record<string, unknown>) => mocks.post(url, body)) as never);
  mocks.post.mockImplementation((url: string, body: Record<string, unknown>) => {
    calls.push([url, body]);
    if (url in overrides) return Promise.resolve(overrides[url]);
    if (url.endsWith('/read')) return Promise.resolve({ path: PATH, regions: REGIONS, text: 'READ TEXT' });
    if (url.endsWith('/save')) return Promise.resolve({ path: PATH, regions: REGIONS, text: 'FILE TEXT' });
    if (url.endsWith('/check')) return Promise.resolve({ path: PATH, diagnostics: [] });
    if (url.endsWith('/terminal')) return Promise.resolve({ shell_id: body.create === false ? null : SHELL_ID, command: COMMAND, path: PATH });
    return Promise.resolve(null);
  });
  return calls;
}

function view(props: Partial<Parameters<typeof SnippetView>[0]> = {}) {
  return render(
    <SnippetView path={PATH} language="python" revision="r1" onNotSnippet={vi.fn()} onSynced={vi.fn()} {...props} />,
  );
}

const editors = () => screen.getAllByTestId<HTMLTextAreaElement>('region-editor');

describe('SnippetView', () => {
  beforeEach(() => {
    instancePreferences.set(PrefKey.SNIPPET_SHOW_INIT, false);
    instancePreferences.set(PrefKey.SNIPPET_SHOW_IMPORTS, false);
  });

  afterEach(() => {
    cleanup();
    mocks.post.mockReset();
    mocks.fileChanged = null;
    mocks.watched = [];
    mocks.markers.clear();
    mocks.clear.mockReset();
    vi.restoreAllMocks();
  });

  const problem = (line: number, message: string, kind = 'name') => ({ line, col: 1, end_line: line, end_col: 4, severity: 'error', kind, message });

  it('marks each problem on the region that holds its line, and counts folded regions too', async () => {
    backend({ '/api/v1/snippet/check': { diagnostics: [problem(2, "No module named 'jsonx'", 'import'), problem(6, "name 'NOTES' is not defined")] } });
    view();
    const chip = await screen.findByTestId('snippet-check');
    await waitFor(() => expect(chip.textContent).toContain('2 problems'));
    // the snippet region starts at file line 6: the problem is its line 1
    await waitFor(() => expect(mocks.markers.get('print(d)')).toEqual([expect.objectContaining({ startLineNumber: 1, message: "name 'NOTES' is not defined", severity: 8 })]));
    expect(mocks.markers.has('import json')).toBe(false); // imports are folded — only the chip counts it
    fireEvent.click(screen.getByTestId('snippet-toggle-imports'));
    await waitFor(() => expect(mocks.markers.get('import json')).toEqual([expect.objectContaining({ startLineNumber: 1 })]));
  });

  it('says the checks pass when the file is clean, and asks again after each save', async () => {
    const calls = backend();
    view();
    await waitFor(() => expect(screen.getByTestId('snippet-check').textContent).toContain('checks pass'));
    fireEvent.change(editors()[0], { target: { value: 'print(d + 1)' } });
    await waitFor(() => expect(calls.map(([url]) => url).lastIndexOf('/api/v1/snippet/check')).toBeGreaterThan(calls.map(([url]) => url).indexOf('/api/v1/snippet/save')));
  });

  it('maps a file line to its region, and a marker line to none', () => {
    const regions = REGIONS as Parameters<typeof regionLine>[0];
    expect(regionLine(regions, 6)).toEqual({ index: 2, line: 1 });
    expect(regionLine(regions, 5)).toBeNull(); // the `# %% flowpad:snippet` line
  });

  it('shows only the snippet region until init and imports are asked for, and remembers', async () => {
    backend();
    view();
    await screen.findByTestId('snippet-region-snippet');
    expect(screen.queryByTestId('snippet-region-init')).toBeNull();
    expect(screen.queryByTestId('snippet-region-hidden')).toBeNull();
    expect(editors().map((e) => e.value)).toEqual(['print(d)']);

    fireEvent.click(screen.getByTestId('snippet-toggle-init'));
    fireEvent.click(screen.getByTestId('snippet-toggle-imports'));
    expect(editors().map((e) => e.value)).toEqual(['import json', 'd = 1', 'print(d)']);
    expect(instancePreferences.get(PrefKey.SNIPPET_SHOW_INIT)).toBe(true);
    expect(instancePreferences.get(PrefKey.SNIPPET_SHOW_IMPORTS)).toBe(true);

    cleanup();
    view();
    await screen.findByTestId('snippet-region-hidden');
  });

  it('offers no toggle for a region the file does not have', async () => {
    backend({ '/api/v1/snippet/read': { path: PATH, regions: [REGIONS[2]] } });
    view();
    await screen.findByTestId('snippet-region-snippet');
    expect(screen.queryByTestId('snippet-toggle-init')).toBeNull();
    expect(screen.queryByTestId('snippet-toggle-imports')).toBeNull();
  });

  it('50 fast keystrokes in two regions save once per region with the final text', async () => {
    const calls = backend();
    instancePreferences.set(PrefKey.SNIPPET_SHOW_INIT, true);
    view();
    await screen.findByTestId('snippet-region-init');
    const [init, snippet] = editors();
    for (let i = 0; i < 50; i++) {
      fireEvent.change(i % 2 ? snippet : init, { target: { value: `v${i}` } });
    }
    await waitFor(() => expect(calls.filter(([url]) => url.endsWith('/save'))).toHaveLength(2), { timeout: 2000 });
    const saves = calls.filter(([url]) => url.endsWith('/save')).map(([, body]) => [body.kind, body.shown]);
    expect(saves).toEqual(expect.arrayContaining([['init', 'v48'], ['snippet', 'v49']]));
  });

  it('an answer without text never hands the host an empty file', async () => {
    fileTerminal();
    backend({ '/api/v1/snippet/read': { path: PATH, regions: REGIONS }, '/api/v1/snippet/save': { path: PATH, regions: REGIONS } });
    const onSynced = vi.fn();
    view({ onSynced });
    await screen.findByTestId('snippet-region-snippet');
    fireEvent.change(editors()[0], { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('snippet-run'));
    await waitFor(() => expect(mocks.post.mock.calls.some(([url]) => String(url).endsWith('/terminal'))).toBe(true));
    expect(onSynced).not.toHaveBeenCalled();
  });

  it('a save refused as STALE reloads the file and says why', async () => {
    const calls = backend({ '/api/v1/snippet/save': { error_code: 'STALE' } });
    const { rerender } = view();
    await screen.findByTestId('snippet-region-snippet');
    backend({
      '/api/v1/snippet/save': { error_code: 'STALE' },
      '/api/v1/snippet/read': { path: PATH, regions: [REGIONS[0], REGIONS[1], { ...REGIONS[2], shown: 'print(theirs)' }] },
    });
    fireEvent.change(editors()[0], { target: { value: 'print(mine)' } });
    await waitFor(() => expect(editors()[0].value).toBe('print(theirs)'), { timeout: 2000 });
    expect(await screen.findByText(/changed outside the editor/)).toBeTruthy();
    // The host's raw copy updates too, which re-reads: the notice must survive it.
    rerender(<SnippetView path={PATH} language="python" revision="r9" onNotSnippet={vi.fn()} onSynced={vi.fn()} />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText(/changed outside the editor/)).toBeTruthy();
    expect(calls).toBeDefined();
  });

  it('a first read that fails hands the file to the raw editor instead of spinning', async () => {
    mocks.post.mockImplementation(() => Promise.reject(new Error('Network Error')));
    const onNotSnippet = vi.fn();
    view({ onNotSnippet });
    await waitFor(() => expect(onNotSnippet).toHaveBeenCalled());
  });

  it('saves an edit by region, and a Run flushes it first — then runs the file in its terminal', async () => {
    const calls = backend();
    const { typed, finish } = fileTerminal();
    const onSynced = vi.fn();
    view({ onSynced });
    await screen.findByTestId('snippet-region-snippet');
    fireEvent.change(editors()[0], { target: { value: 'print(d + 1)' } });
    fireEvent.click(screen.getByTestId('snippet-run'));
    await waitFor(() => expect(typed).toHaveLength(1));

    const urls = calls.map(([url]) => url);
    const save = urls.indexOf('/api/v1/snippet/save');
    expect(save).toBeGreaterThan(-1);
    expect(save).toBeLessThan(urls.lastIndexOf('/api/v1/snippet/terminal'));
    expect(calls[save][1]).toEqual({ path: PATH, index: 2, kind: 'snippet', shown: 'print(d + 1)', base: 'print(d)' });
    expect(typed).toEqual([`[clear] ${COMMAND}`]); // a clean screen, in the terminal's own grammar
    expect(screen.getByTestId('terminal').dataset.shell).toBe(SHELL_ID);
    expect(onSynced).toHaveBeenCalledWith('FILE TEXT');
    finish(0);
    expect((await screen.findByTestId('snippet-status')).textContent).toMatch(/exit 0/);
    // The flushed edit's debounce timer must not fire a second save afterwards.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(calls.filter(([url]) => url.endsWith('/save'))).toHaveLength(1);
  });

  it('shows the file\'s terminal on arrival when it has one, and makes none for a file never run', async () => {
    const calls = backend();
    view();
    await screen.findByTestId('snippet-region-snippet');
    await waitFor(() => expect(calls.some(([url, body]) => url.endsWith('/terminal') && body.create === false)).toBe(true));
    expect(screen.queryByTestId('terminal')).toBeNull();
    cleanup();

    fileTerminal();
    backend({ '/api/v1/snippet/terminal': { shell_id: SHELL_ID, command: COMMAND, path: PATH } });
    view();
    expect((await screen.findByTestId('terminal')).dataset.shell).toBe(SHELL_ID);
  });

  it.each([
    [0, /exit 0 · /],
    [1, /exit 1 · /],
  ])('ends with the exit line: %s', async (code, status) => {
    backend();
    const { typed, finish } = fileTerminal();
    view();
    fireEvent.click(await screen.findByTestId('snippet-run'));
    await waitFor(() => expect(typed).toHaveLength(1));
    finish(code);
    expect((await screen.findByTestId('snippet-status')).textContent).toMatch(status);
    expect(screen.getByTestId('snippet-run')).toBeTruthy();
  });

  it('Stop interrupts the run in its terminal, and the line says it was stopped', async () => {
    backend();
    const { typed, actions } = fileTerminal();
    view();
    fireEvent.click(await screen.findByTestId('snippet-run'));
    await waitFor(() => expect(typed).toHaveLength(1));
    fireEvent.click(await screen.findByTestId('snippet-stop'));
    expect((await screen.findByTestId('snippet-status')).textContent).toMatch(/stopped after/);
    expect(actions).toContain('interrupt');
    expect(screen.getByTestId('terminal')).toBeTruthy(); // the terminal stays
  });

  it('Run clears the terminal the moment it is clicked', async () => {
    backend({ '/api/v1/snippet/terminal': { shell_id: SHELL_ID, command: COMMAND, path: PATH } });
    const { typed, finish } = fileTerminal();
    view();
    await screen.findByTestId('terminal');
    fireEvent.click(screen.getByTestId('snippet-run'));
    expect(mocks.clear).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(typed).toHaveLength(1));
    finish(0);
  });

  it('a clock beside Stop counts the run in flight, and goes when the run ends', async () => {
    backend();
    const { typed, finish } = fileTerminal();
    view();
    fireEvent.click(await screen.findByTestId('snippet-run'));
    const clock = await screen.findByTestId('snippet-clock');
    expect(clock.textContent).toMatch(/^0\.\ds$/);
    await waitFor(() => expect(clock.textContent).not.toBe('0.0s'), { timeout: 1000 });
    await waitFor(() => expect(typed).toHaveLength(1));
    finish(0);
    await screen.findByTestId('snippet-status');
    expect(screen.queryByTestId('snippet-clock')).toBeNull();
  });

  it('formats elapsed time as tenths under a minute, then m:ss', () => {
    expect(formatElapsed(0)).toBe('0.0s');
    expect(formatElapsed(3240)).toBe('3.2s');
    expect(formatElapsed(59_949)).toBe('59.9s');
    expect(formatElapsed(65_000)).toBe('1:05');
  });

  it('clicks before the button turns into Stop start one run, not one each', async () => {
    backend({ '/api/v1/snippet/terminal': { shell_id: SHELL_ID, command: COMMAND, path: PATH } });
    const { typed } = fileTerminal();
    view();
    await screen.findByTestId('terminal');
    const runButton = screen.getByTestId('snippet-run');
    fireEvent.click(runButton);
    fireEvent.click(runButton);
    fireEvent.click(runButton);
    await screen.findByTestId('snippet-stop');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(typed).toHaveLength(1);
  });

  it('leaving the view mid-run leaves the run going in its terminal', async () => {
    backend();
    const { typed, actions } = fileTerminal();
    const { unmount } = view();
    fireEvent.click(await screen.findByTestId('snippet-run'));
    await waitFor(() => expect(typed).toHaveLength(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(actions).not.toContain('interrupt');
  });

  it('watches its file, and a change on disk (the agent) reloads the regions', async () => {
    backend();
    view({ watch: { typeid: { toString: () => 'compute_node-@local' } as never, path: PATH } });
    await screen.findByTestId('snippet-region-snippet');
    expect(mocks.watched).toContain(PATH);
    backend({ '/api/v1/snippet/read': { path: PATH, regions: [REGIONS[0], REGIONS[1], { ...REGIONS[2], shown: 'print(agent)' }] } });
    mocks.fileChanged?.();
    await waitFor(() => expect(editors()[0].value).toBe('print(agent)'));
  });

  it('hands back to the raw editor when the file is not a snippet', async () => {
    backend({ '/api/v1/snippet/read': { error_code: 'NOT_A_SNIPPET' } });
    const onNotSnippet = vi.fn();
    view({ onNotSnippet });
    await waitFor(() => expect(onNotSnippet).toHaveBeenCalled());
  });

  it('picks up a change made under it (an agent edit) without a reload', async () => {
    backend();
    const { rerender } = view();
    await screen.findByTestId('snippet-region-snippet');
    backend({ '/api/v1/snippet/read': { path: PATH, regions: [REGIONS[0], REGIONS[1], { ...REGIONS[2], shown: 'print(99)' }] } });
    rerender(<SnippetView path={PATH} language="python" revision="r2" onNotSnippet={vi.fn()} onSynced={vi.fn()} />);
    await waitFor(() => expect(editors()[0].value).toBe('print(99)'));
  });
});
