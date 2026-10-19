/**
 * The vibe display's turn-end refresh gate.
 *
 * The display is remounted at a turn edge because the CLI stream carries no
 * per-file write signal — but a turn that only talked (or only read) changed
 * nothing, and remounting it then tears down a running page for no reason. The
 * gate skips exactly that case and nothing else: anything that MAY have written
 * still refreshes, and so does every edge while work the agent backgrounded is
 * still running (it can write after its own turn ended).
 *
 * Frame shapes are copied from a live Claude vibe stream (dev instance, Oct
 * 2026): tool calls carry `tool-name` + `data.args`; `run_in_background` is NOT
 * forwarded in args; a background task's start and completion arrive as
 * `status` frames (`task_started` / `task_notification`) keyed by tool_use_id.
 */
import { describe, expect, it } from 'vitest';

import { FlowData, FlowDataSource, FlowElementTypes } from '@sdk';
import {
  advanceDisplayRefreshGate,
  EMPTY_DISPLAY_REFRESH_GATE,
  type DisplayRefreshGate,
} from '@src/pages/flow-page/display-refresh-gate';

let seq = 0;
const t = () => `2026-10-08T08:18:${String(seq % 60).padStart(2, '0')}.000Z`;

function user(text: string): FlowData {
  return new FlowData(FlowElementTypes.USER_MESSAGE, text, { i: String(seq++), t: t(), role: 'user' });
}

function chat(text: string): FlowData {
  return new FlowData(FlowElementTypes.CHAT, text, {
    i: String(seq++),
    t: t(),
    'data-type': 'string',
    role: 'assistant',
  });
}

function toolCall(name: string, args: Record<string, unknown>, id = `toolu_${seq}`): FlowData {
  return new FlowData(
    FlowElementTypes.TOOL_CALL,
    JSON.stringify({ tool_name: name, tool_use_id: id, tool_call_id: id, args }),
    { i: String(seq++), t: t(), 'data-type': 'object', 'tool-name': name, 'tool-use-id': id },
  );
}

function toolResult(id: string, content: string): FlowData {
  return new FlowData(
    FlowElementTypes.TOOL_RESULT,
    JSON.stringify({ tool_call_id: id, tool_use_id: id, content, output: content }),
    { i: String(seq++), t: t(), 'data-type': 'object', 'tool-use-id': id },
  );
}

function status(subtype: string, payload: Record<string, unknown> = {}): FlowData {
  return new FlowData(FlowElementTypes.STATUS, JSON.stringify({ type: 'system', subtype, ...payload }), {
    i: String(seq++),
    t: t(),
    'data-type': 'string',
    subtype,
  });
}

/** One turn's tail: what every measured turn ended with. */
const turnEnd = () => [
  new FlowData(FlowElementTypes.RESULT, JSON.stringify({ subtype: 'success' }), {
    i: String(seq++),
    t: t(),
    'data-type': 'object',
    outcome: 'success',
  }),
  new FlowData(FlowElementTypes.END, '', { i: String(seq++), t: t(), 'data-type': 'string' }),
];

/** Feed turns through the gate the way the workspace does: append, then edge. */
function run(turns: FlowData[][], start: DisplayRefreshGate = EMPTY_DISPLAY_REFRESH_GATE) {
  let gate = start;
  const items: FlowData[] = [];
  const decisions: boolean[] = [];
  for (const turn of turns) {
    items.push(...turn);
    const out = advanceDisplayRefreshGate(gate, [...items]);
    decisions.push(out.refresh);
    gate = out.gate;
  }
  return { decisions, gate, items };
}

/** A gate that has already seen a first turn, so later turns are judged alone. */
function primed(): { gate: DisplayRefreshGate; items: FlowData[] } {
  const items = [user('hi'), chat('hi'), ...turnEnd()];
  return { gate: advanceDisplayRefreshGate(EMPTY_DISPLAY_REFRESH_GATE, items).gate, items };
}

function nextTurn(prev: { gate: DisplayRefreshGate; items: FlowData[] }, turn: FlowData[]) {
  const items = [...prev.items, ...turn];
  const out = advanceDisplayRefreshGate(prev.gate, items);
  return { refresh: out.refresh, gate: out.gate, items };
}

describe('display refresh gate', () => {
  it('a text-only turn does not refresh', () => {
    const p = primed();
    const r = nextTurn(p, [user('reply pong'), status('init'), chat('pong'), ...turnEnd()]);
    expect(r.refresh).toBe(false);
  });

  it('a turn that only used read-only tools does not refresh', () => {
    const p = primed();
    const r = nextTurn(p, [
      user('look'),
      toolCall('Read', { file_path: '/tmp/page.html' }, 'toolu_r'),
      toolResult('toolu_r', '1\t<!doctype html>'),
      toolCall('Grep', { pattern: 'li' }, 'toolu_g'),
      toolCall('Glob', { pattern: '*.html' }, 'toolu_gl'),
      chat('it has one item'),
      ...turnEnd(),
    ]);
    expect(r.refresh).toBe(false);
  });

  it.each([
    ['Edit', { file_path: '/tmp/page.html', edits: [] }],
    ['Write', { file_path: '/tmp/page.html', content: 'x' }],
    ['MultiEdit', { file_path: '/tmp/page.html', edits: [] }],
    ['NotebookEdit', { notebook_path: '/tmp/n.ipynb' }],
    ['Bash', { command: 'flow show file /tmp/page.html' }],
    ['some_unknown_tool', {}],
  ])('a turn that used %s refreshes', (name, args) => {
    const p = primed();
    const r = nextTurn(p, [
      user('do it'),
      toolCall('Read', { file_path: '/x' }),
      toolCall(name, args),
      chat('done'),
      ...turnEnd(),
    ]);
    expect(r.refresh).toBe(true);
  });

  it('a tool call whose name cannot be read refreshes', () => {
    const p = primed();
    const nameless = new FlowData(FlowElementTypes.TOOL_CALL, JSON.stringify({ args: {} }), {
      i: String(seq++),
      t: t(),
      'data-type': 'object',
    });
    expect(nextTurn(p, [nameless, ...turnEnd()]).refresh).toBe(true);
  });

  it('background work refreshes every edge until its completion arrives, then text turns stop refreshing', () => {
    const id = 'toolu_01FvKZMJiSTZnjjvRsHpMqWF';
    const { decisions } = run([
      [user('hi'), chat('hi'), ...turnEnd()],
      // (c) the launch, exactly as measured: Bash args carry no run_in_background,
      // the backgrounding is only visible on the task_started status frame.
      [
        user('start it in the background'),
        toolCall('Bash', { command: 'sleep 15 && sed -i ...' }, id),
        status('background_tasks_changed', { tasks: [{ task_id: 'bgeaeopfa', task_type: 'local_bash' }] }),
        status('task_started', {
          task_id: 'bgeaeopfa',
          tool_use_id: id,
          is_backgrounded: true,
          task_type: 'local_bash',
        }),
        toolResult(id, 'Command running in background with ID: bgeaeopfa.'),
        chat('started'),
        ...turnEnd(),
      ],
      // A text-only turn while it still runs — it may write any moment.
      [user('still there?'), chat('yes'), ...turnEnd()],
      // (d) the completion turn: no tools, but the background work wrote.
      [
        status('task_updated', { task_id: 'bgeaeopfa', patch: { status: 'completed' } }),
        status('task_notification', { task_id: 'bgeaeopfa', tool_use_id: id, status: 'completed' }),
        status('background_tasks_changed', { tasks: [] }),
        chat('bg finished'),
        ...turnEnd(),
      ],
      // Closed: a text-only turn is quiet again.
      [user('thanks'), chat('np'), ...turnEnd()],
    ]);
    expect(decisions.slice(1)).toEqual([true, true, true, false]);
  });

  it.each([
    ['Agent', { description: 'x', prompt: 'y' }],
    ['Task', { description: 'x', prompt: 'y' }],
    ['Bash', { command: 'sleep 9', run_in_background: true }],
  ])('a %s launch stays open until its task_notification', (name, args) => {
    const id = `toolu_${name}`;
    const { decisions } = run([
      [user('hi'), chat('hi'), ...turnEnd()],
      [toolCall(name, args, id), toolResult(id, 'launched'), ...turnEnd()],
      [user('?'), chat('waiting'), ...turnEnd()],
      [
        status('task_notification', { task_id: 'tsk', tool_use_id: id, status: 'completed' }),
        chat('done'),
        ...turnEnd(),
      ],
      [user('ok'), chat('ok'), ...turnEnd()],
    ]);
    expect(decisions.slice(1)).toEqual([true, true, true, false]);
  });

  it('a completion whose payload was truncated mid-string still closes its task', () => {
    // Measured: status payloads arrive cut at 400 chars, so the JSON does not
    // parse — the ids sit near the front and must still be read.
    const id = 'toolu_01Ef4LcFAbQ3z3uj4Fvi2gAh';
    const full = JSON.stringify({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'btosv62wf',
      run_id: '0muz9w5k9-0d602d6f',
      tool_use_id: id,
      status: 'completed',
      output_file: '/private/tmp/claude-501/x/tasks/btosv62wf.output',
      summary: 'Background command "Run delayed file edit in background" completed (exit code 0)'.repeat(5),
    });
    const truncated = new FlowData(FlowElementTypes.STATUS, full.slice(0, 400), {
      i: String(seq++),
      t: t(),
      'data-type': 'string',
      subtype: 'task_notification',
    });
    const { decisions, gate } = run([
      [user('hi'), chat('hi'), ...turnEnd()],
      [
        toolCall('Bash', { command: 'sleep 15' }, id),
        status('task_started', { task_id: 'btosv62wf', tool_use_id: id, is_backgrounded: true }),
        ...turnEnd(),
      ],
      [truncated, chat('bg finished'), ...turnEnd()],
      [user('ok'), chat('ok'), ...turnEnd()],
    ]);
    expect(decisions.slice(1)).toEqual([true, true, false]);
    expect(gate.openBackground.size).toBe(0);
  });

  it('a background launch without an id never closes (degrades to always-refresh)', () => {
    const { decisions } = run([
      [user('hi'), chat('hi'), ...turnEnd()],
      [status('task_started', { is_backgrounded: true }), ...turnEnd()],
      [status('task_notification', { status: 'completed' }), ...turnEnd()],
      [user('ok'), chat('ok'), ...turnEnd()],
    ]);
    expect(decisions.slice(1)).toEqual([true, true, true]);
  });

  it('a stream that was reset since the last edge refreshes', () => {
    const p = primed();
    // Same conversation replayed as NEW objects (history reload): nothing the
    // gate saw survives, so it cannot tell what is new.
    const replay = [user('hi'), chat('hi'), ...turnEnd()];
    expect(advanceDisplayRefreshGate(p.gate, replay).refresh).toBe(true);
    expect(advanceDisplayRefreshGate(p.gate, []).refresh).toBe(true);
  });

  it('a retired optimistic echo (one frame dropped) is not a reset', () => {
    const echo = user('reply pong');
    const first = [user('hi'), chat('hi'), ...turnEnd(), echo];
    const gate = advanceDisplayRefreshGate(EMPTY_DISPLAY_REFRESH_GATE, first).gate;
    const next = [...first.filter((f) => f !== echo), user('reply pong'), chat('pong'), ...turnEnd()];
    expect(advanceDisplayRefreshGate(gate, next).refresh).toBe(false);
  });

  it('the first edge after a mount does not count the history replay as a write', () => {
    // Measured: a reload replays user-message/chat/tool-call frames with
    // source=history and no status frames, before the user's next turn.
    const replayed = [
      user('edit it'),
      toolCall('Edit', { file_path: '/x' }),
      chat('done'),
      toolCall('Bash', { command: 'flow show file /x' }),
    ];
    for (const f of replayed) f.source = FlowDataSource.History;
    const live = [user('reply ping'), chat('ping'), ...turnEnd()];
    const first = advanceDisplayRefreshGate(EMPTY_DISPLAY_REFRESH_GATE, [...replayed, ...live]);
    expect(first.refresh).toBe(false);
    // ...but a live write in that same first turn still refreshes.
    const liveEdit = [user('edit'), toolCall('Edit', { file_path: '/x' }), ...turnEnd()];
    expect(advanceDisplayRefreshGate(EMPTY_DISPLAY_REFRESH_GATE, [...replayed, ...liveEdit]).refresh).toBe(true);
  });

  it('an Agent call in the history replay does not hold background work open', () => {
    // The replay carries no status frames, so its completion never arrives:
    // opening on it would make every later edge refresh for the whole session.
    const replayed = [user('build it'), toolCall('Agent', { prompt: 'x' }, 'toolu_old'), chat('launched')];
    for (const f of replayed) f.source = FlowDataSource.History;
    const items = [...replayed, user('reply ping'), chat('ping'), ...turnEnd()];
    const first = advanceDisplayRefreshGate(EMPTY_DISPLAY_REFRESH_GATE, items);
    expect(first.refresh).toBe(false);
    expect(nextTurn({ gate: first.gate, items }, [user('ess'), chat('short'), ...turnEnd()]).refresh).toBe(false);
  });

  it('history frames after the first edge are judged like any other', () => {
    const p = primed();
    const late = toolCall('Edit', { file_path: '/x' });
    late.source = FlowDataSource.History;
    expect(nextTurn(p, [late, ...turnEnd()]).refresh).toBe(true);
  });

  it('a completion whose launch was never seen (launched before a reload) refreshes its edge', () => {
    const p = primed();
    const r = nextTurn(p, [
      status('task_notification', { task_id: 'bgold', tool_use_id: 'toolu_old', status: 'completed' }),
      chat('bg finished'),
      ...turnEnd(),
    ]);
    expect(r.refresh).toBe(true);
    expect(nextTurn(r, [user('ok'), chat('ok'), ...turnEnd()]).refresh).toBe(false);
  });

  it('a write frame that lands after its edge is judged at the next edge', () => {
    const p = primed();
    // The edge fired before the Edit frame was appended (measured: the
    // workerStatus edge can beat the turn's last frames)...
    const early = nextTurn(p, [user('edit it'), chat('working')]);
    expect(early.refresh).toBe(false);
    // ...so the next edge still sees it.
    expect(nextTurn(early, [toolCall('Edit', { file_path: '/x' }), ...turnEnd()]).refresh).toBe(true);
  });
});
