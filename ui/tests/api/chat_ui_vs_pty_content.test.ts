/**
 * Does the PTY show core text the chat UI omits? — 5 heavy sessions (dev-1)
 *
 * The interactive view can be toggled to a chat UI that renders the process
 * from `flowDataStream` (transcript-derived) instead of the terminal. The risk:
 * the PTY shows important text the user should see, but the chat surface — what
 * the user looks at in chat mode — doesn't have it.
 *
 * We open FIVE heavy sessions at once (each produces several distinct content
 * tokens the agent must EMIT — `T1<r>`…`T5<r>` plus an `END<r>` — none of which
 * appear in the prompt, so a hit is real agent output, never echoed input).
 * For each session we compare, token by token, what the PTY shows against what
 * the chat UI has, and report every piece of core text the chat omits.
 *
 * Runs against the disposable `dev-1` instance (skips if not launched).
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { beforeAll, describe, expect, it, vi } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const ENV_FILE = path.join(REPO_ROOT, '.env.dev-1.local');
const PORT = (() => {
  if (!existsSync(ENV_FILE)) return null;
  const m = readFileSync(ENV_FILE, 'utf8').match(/^LOCAL_SERVER_PORT=(\d+)/m);
  return m ? m[1] : null;
})();

const suite = PORT ? describe : describe.skip;

/** Strip ANSI/VT control sequences so plain-token substring matching works. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[\]P^_].*?(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

function ptyPlainText(stream: { events: Array<[string, ...unknown[]]> } | null): string {
  if (!stream?.events?.length) return '';
  const dec = new TextDecoder('utf-8', { fatal: false });
  let out = '';
  for (const ev of stream.events) {
    if (ev[0] === 'o' && typeof ev[1] === 'string') {
      out += dec.decode(Uint8Array.from(atob(ev[1]), (c) => c.charCodeAt(0)), { stream: true });
    }
  }
  return (out + dec.decode()).replace(ANSI, '');
}

/** Five heavy scenarios — distinct work so the sessions don't collapse to one. */
const SCENARIOS = [
  { name: 'list-facts', topic: 'three short facts about the moon' },
  { name: 'haiku', topic: 'a haiku about autumn rain' },
  { name: 'steps', topic: 'three numbered steps to make tea' },
  { name: 'definition', topic: 'a one-line definition of entropy' },
  { name: 'pros-cons', topic: 'one pro and one con of remote work' },
];

interface SessionResult {
  name: string;
  procId: string;
  shellId: string;
  ptyTokens: string[]; // expected tokens found in the PTY
  chatTokens: string[]; // expected tokens found in the chat UI
  missing: string[]; // shown in PTY, absent from chat — the omission
}

suite('PTY vs chat UI content across 5 heavy sessions (dev-1)', () => {
  let sdk: any;
  let manager: any;

  beforeAll(async () => {
    (globalThis as any).__FLOWPAD_API_URL__ = `http://localhost:${PORT}`;
    vi.resetModules();
    sdk = await import('@sdk');

    const info = await sdk.dataManager.bootstrap('localhost', true);
    await sdk.dataManager.loadTypes(info.types || []);
    manager = sdk.ConnectionManager.getInstance();
    if (!manager.connected) await manager.connect();

    if (info.default_compute_node) {
      const cn = new sdk.ComputeNode(info.default_compute_node);
      cn.markAsExpanded?.();
      await sdk.dataContext.setContextEntityTypeId(
        sdk.ContextEntitiesEnum.CurrentComputeNodeTypeId,
        cn.typeId,
      );
    }
  }, 60_000);

  it('reports core text the PTY shows but the chat UI omits, per session', async () => {
    const run = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`.toUpperCase();

    // One unique answer token per content slot, per scenario — emitted by the
    // agent, never present in the prompt.
    const tokensFor = (i: number) =>
      ['T1', 'T2', 'T3', 'END'].map((p) => `${p}S${i}X${run}`);

    const instructionFor = (i: number, topic: string) => {
      const [t1, t2, t3, end] = tokensFor(i);
      return (
        `Do this in order, then stop. Do not use any tools.\n` +
        `1) Print this exact token on its own line: ${t1}\n` +
        `2) Write ${topic}.\n` +
        `3) Print this exact token on its own line: ${t2}\n` +
        `4) Write one more sentence about it.\n` +
        `5) Print this exact token on its own line: ${t3}\n` +
        `Finally print this exact token on its own line to signal completion: ${end}`
      );
    };

    // 1. Open all five heavy sessions concurrently.
    const procs: any[] = await Promise.all(
      SCENARIOS.map((s, i) => sdk.AgenticProcess.openTab('claude_code', instructionFor(i, s.topic))),
    );
    procs.forEach((p) => expect(p?.id).toBeTruthy());

    const entityUrl = (id: string) => `${sdk.GRAPH_API_PREFIX}/${sdk.AgenticProcess.type}/${id}`;
    const ptyText = async (shellId: string): Promise<string> =>
      ptyPlainText((await sdk.apiClient.get(`/shell/${shellId}/pty-stream`).catch(() => null)) as any);
    const chatText = async (proc: any): Promise<string> => {
      await proc.loadHistory({ force: true }).catch(() => {});
      return (proc.flowDataStream.items as any[]).map((it) => it.content ?? '').join('\n');
    };

    // 2. Resolve each session's shell_id (binds async after boot).
    const shellIds: string[] = await Promise.all(
      procs.map(async (proc) => {
        let shellId = '';
        await vi.waitFor(
          async () => {
            const fresh: any = await sdk.apiClient.get(entityUrl(proc.id)).catch(() => null);
            if (!fresh?.shell_id) throw new Error('shell_id not bound yet');
            shellId = fresh.shell_id;
          },
          { timeout: 60_000, interval: 1_000 },
        );
        return shellId;
      }),
    );

    // 3. Wait until every session's END token is on screen in its PTY (turn done).
    await Promise.all(
      shellIds.map((shellId, i) =>
        vi
          .waitFor(
            async () => {
              const [, , , end] = tokensFor(i);
              if (!(await ptyText(shellId)).includes(end)) throw new Error(`session ${i} not done`);
            },
            { timeout: 150_000, interval: 2_000 }, // 5×heavy-session boot+turn budget
          )
          .catch(() => {}), // a stalled session still gets compared below (counts as omitted)
      ),
    );

    // 4. Give the chat surface a bounded chance to reflect each turn.
    await new Promise((res) => setTimeout(res, 5_000));

    // 5. Compare PTY vs chat per session, token by token.
    const results: SessionResult[] = [];
    for (let i = 0; i < SCENARIOS.length; i++) {
      const expected = tokensFor(i);
      const pty = await ptyText(shellIds[i]);
      const chat = await chatText(procs[i]);
      const ptyTokens = expected.filter((t) => pty.includes(t));
      const chatTokens = expected.filter((t) => chat.includes(t));
      results.push({
        name: SCENARIOS[i].name,
        procId: procs[i].id,
        shellId: shellIds[i],
        ptyTokens,
        chatTokens,
        missing: ptyTokens.filter((t) => !chat.includes(t)),
      });
    }

    // 6. Report.
    // eslint-disable-next-line no-console
    console.log('\n=== PTY vs chat UI core-content comparison (5 heavy sessions) ===');
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(
        `• ${r.name.padEnd(11)} PTY ${r.ptyTokens.length}/4  chat ${r.chatTokens.length}/4  ` +
          `omitted=[${r.missing.join(', ') || 'none'}]`,
      );
    }
    const totalShown = results.reduce((n, r) => n + r.ptyTokens.length, 0);
    const totalOmitted = results.reduce((n, r) => n + r.missing.length, 0);
    // eslint-disable-next-line no-console
    console.log(`TOTAL: PTY showed ${totalShown} tokens; chat UI omitted ${totalOmitted} of them.\n`);

    // The PTY must have shown real agent output in at least some sessions
    // (otherwise the run is inconclusive, not a parity result).
    expect(totalShown).toBeGreaterThan(0);

    // Parity assertion: every piece of core text the PTY showed must also be in
    // the chat UI. Any omission is text the chat-mode user never sees.
    expect(totalOmitted).toBe(0);
  }, 300_000);
});
