/**
 * SnippetView renders what `/api/v1/snippet/*` answers and nothing more: the
 * region rules, saving and running are proven in `tests/unit/test_snippet.py`.
 * Here: which regions show, that the toggles persist, that edits are saved by
 * region and flushed before a Run, and that each kind of run result renders.
 *
 * Monaco is stubbed with a textarea (jsdom cannot host it); `apiClient` at the
 * transport edge.
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

const { SnippetView, regionLine, formatElapsed } = await import('@src/components/code-editor/SnippetView');

const PATH = '/tmp/flowpad-snippets/t.py';
const REGIONS = [
  { index: 0, kind: 'hidden', shown: 'import json', line: 2 },
  { index: 1, kind: 'init', shown: 'd = 1', line: 4 },
  { index: 2, kind: 'snippet', shown: 'print(d)', line: 6 },
];

function backend(overrides: Record<string, unknown> = {}) {
  const calls: Array<[string, Record<string, unknown>]> = [];
  mocks.post.mockImplementation((url: string, body: Record<string, unknown>) => {
    calls.push([url, body]);
    if (url in overrides) return Promise.resolve(overrides[url]);
    if (url.endsWith('/read')) return Promise.resolve({ path: PATH, regions: REGIONS, text: 'READ TEXT' });
    if (url.endsWith('/save')) return Promise.resolve({ path: PATH, regions: REGIONS, text: 'FILE TEXT' });
    if (url.endsWith('/check')) return Promise.resolve({ path: PATH, diagnostics: [] });
    return Promise.resolve({ returncode: 0, stdout: 'ok\n', stderr: '', timed_out: false, duration_s: 0.12 });
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
    instancePreferences.set(PrefKey.SNIPPET_RUN_TIMEOUT, 30);
  });

  afterEach(() => {
    cleanup();
    mocks.post.mockReset();
    mocks.fileChanged = null;
    mocks.watched = [];
    mocks.markers.clear();
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

  it('saves an edit by region, and a Run flushes it first', async () => {
    const calls = backend();
    const onSynced = vi.fn();
    view({ onSynced });
    await screen.findByTestId('snippet-region-snippet');
    fireEvent.change(editors()[0], { target: { value: 'print(d + 1)' } });
    fireEvent.click(screen.getByTestId('snippet-run'));
    await screen.findByTestId('snippet-console');

    const urls = calls.map(([url]) => url);
    const save = urls.indexOf('/api/v1/snippet/save');
    expect(save).toBeGreaterThan(-1);
    expect(save).toBeLessThan(urls.indexOf('/api/v1/snippet/run'));
    expect(calls[save][1]).toEqual({ path: PATH, index: 2, kind: 'snippet', shown: 'print(d + 1)', base: 'print(d)' });
    expect(calls.find(([url]) => url.endsWith('/run'))?.[1]).toEqual({ path: PATH, timeout_seconds: 30, run_id: expect.any(String), connection_id: expect.any(String) });
    expect(onSynced).toHaveBeenCalledWith('READ TEXT');
    expect(onSynced).toHaveBeenCalledWith('FILE TEXT');
    expect(editors()[0].value).toBe('print(d + 1)');
    // The flushed edit's debounce timer must not fire a second save afterwards.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(calls.filter(([url]) => url.endsWith('/save'))).toHaveLength(1);
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

  it.each([
    [{ returncode: 0, stdout: 'hi\n', stderr: '', timed_out: false, duration_s: 0.1 }, 'hi', null, /exit 0/],
    [{ returncode: 1, stdout: '', stderr: 'ValueError: boom', timed_out: false, duration_s: 0.1 }, null, 'ValueError: boom', /exit 1/],
    // The backend writes a sentence for EVERY run that does not succeed — a failed
    // run is not a stopped one just because it has a detail (the bug: it read so).
    [{ exit_code: 1, returncode: 1, stdout: '', stderr: 'boom', timed_out: false, duration_s: 0.1, detail: 'The command exited 1.' }, null, 'boom', /exit 1/],
    [{ exit_code: 4, returncode: null, stdout: '', stderr: 'snippet file not found', timed_out: false, duration_s: 0, detail: 'snippet file not found: /x.py' }, null, 'not found', /snippet file not found/],
    [{ returncode: -9, stdout: 'step 1\n', stderr: '', timed_out: true, duration_s: 2 }, 'step 1', null, /timed out after 30s/],
    [{ returncode: null, stdout: '', stderr: "no runner for '.cobol' files", timed_out: false, duration_s: 0 }, null, 'no runner', /did not run/],
  ])('renders a run result: %#', async (result, stdout, stderr, status) => {
    backend({ '/api/v1/snippet/run': result });
    view();
    fireEvent.click(await screen.findByTestId('snippet-run'));
    await screen.findByTestId('snippet-console');
    if (stdout) expect(screen.getByTestId('snippet-stdout').textContent).toContain(stdout);
    else expect(screen.queryByTestId('snippet-stdout')).toBeNull();
    if (stderr) expect(screen.getByTestId('snippet-stderr').textContent).toContain(stderr);
    expect(screen.getByTestId('snippet-status').textContent).toMatch(status);
  });

  it('an answer without text never hands the host an empty file', async () => {
    backend({ '/api/v1/snippet/read': { path: PATH, regions: REGIONS }, '/api/v1/snippet/save': { path: PATH, regions: REGIONS } });
    const onSynced = vi.fn();
    view({ onSynced });
    await screen.findByTestId('snippet-region-snippet');
    fireEvent.change(editors()[0], { target: { value: 'x' } });
    fireEvent.click(screen.getByTestId('snippet-run'));
    await screen.findByTestId('snippet-console');
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

  it('Stop kills the run in flight by its id, and the result says it was stopped', async () => {
    let finishRun: (value: unknown) => void = () => undefined;
    const calls = backend({
      '/api/v1/snippet/run': new Promise((resolve) => (finishRun = resolve)),
      '/api/v1/snippet/stop': { stopped: true },
    });
    view();
    fireEvent.click(await screen.findByTestId('snippet-run'));
    fireEvent.click(await screen.findByTestId('snippet-stop'));
    await waitFor(() => expect(calls.some(([url]) => url.endsWith('/stop'))).toBe(true));
    const runId = calls.find(([url]) => url.endsWith('/run'))?.[1].run_id;
    expect(typeof runId).toBe('string');
    expect(calls.find(([url]) => url.endsWith('/stop'))?.[1]).toEqual({ run_id: runId });
    // What a killed run really answers with: the reason is the backend's own sentence.
    finishRun({ returncode: -9, stdout: 'started\n', stderr: '', timed_out: false, duration_s: 0.4, detail: 'The run was stopped.' });
    expect((await screen.findByTestId('snippet-status')).textContent).toMatch(/stopped/);
    expect(screen.getByTestId('snippet-stdout').textContent).toContain('started');
    expect(screen.getByTestId('snippet-run')).toBeTruthy();
  });

  it('Run clears the last run\'s console the moment it is clicked, not when the new run answers', async () => {
    backend({ '/api/v1/snippet/run': { returncode: 1, stdout: 'old out\n', stderr: 'old err', timed_out: false, duration_s: 0.1 } });
    view();
    fireEvent.click(await screen.findByTestId('snippet-run'));
    expect((await screen.findByTestId('snippet-stdout')).textContent).toContain('old out');
    await screen.findByTestId('snippet-run');
    backend({ '/api/v1/snippet/run': new Promise(() => undefined) });
    fireEvent.click(screen.getByTestId('snippet-run'));
    await screen.findByTestId('snippet-stop');
    expect(screen.queryByTestId('snippet-stdout')).toBeNull();
    expect(screen.queryByTestId('snippet-stderr')).toBeNull();
    expect(screen.queryByTestId('snippet-status')).toBeNull();
  });

  it('a clock beside Stop counts the run in flight, and goes when the run ends', async () => {
    let finishRun: (value: unknown) => void = () => undefined;
    backend({ '/api/v1/snippet/run': new Promise((resolve) => (finishRun = resolve)) });
    view();
    fireEvent.click(await screen.findByTestId('snippet-run'));
    const clock = await screen.findByTestId('snippet-clock');
    expect(clock.textContent).toMatch(/^0\.\ds$/);
    await waitFor(() => expect(clock.textContent).not.toBe('0.0s'), { timeout: 1000 });
    finishRun({ returncode: 0, stdout: 'done\n', stderr: '', timed_out: false, duration_s: 0.3 });
    await screen.findByTestId('snippet-run');
    expect(screen.queryByTestId('snippet-clock')).toBeNull();
  });

  it('formats elapsed time as tenths under a minute, then m:ss', () => {
    expect(formatElapsed(0)).toBe('0.0s');
    expect(formatElapsed(3240)).toBe('3.2s');
    expect(formatElapsed(59_949)).toBe('59.9s');
    expect(formatElapsed(65_000)).toBe('1:05');
  });

  it('clicks before the button turns into Stop start one run, not one each', async () => {
    const calls = backend({ '/api/v1/snippet/run': new Promise(() => undefined) });
    view();
    const runButton = await screen.findByTestId('snippet-run');
    fireEvent.click(runButton);
    fireEvent.click(runButton);
    fireEvent.click(runButton);
    await screen.findByTestId('snippet-stop');
    expect(calls.filter(([url]) => url.endsWith('/run'))).toHaveLength(1);
  });

  it('leaving the view mid-run stops the run', async () => {
    const calls = backend({ '/api/v1/snippet/run': new Promise(() => undefined), '/api/v1/snippet/stop': { stopped: true } });
    const { unmount } = view();
    fireEvent.click(await screen.findByTestId('snippet-run'));
    await screen.findByTestId('snippet-stop');
    unmount();
    const runId = calls.find(([url]) => url.endsWith('/run'))?.[1].run_id;
    await waitFor(() => expect(calls.find(([url]) => url.endsWith('/stop'))?.[1]).toEqual({ run_id: runId }));
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
