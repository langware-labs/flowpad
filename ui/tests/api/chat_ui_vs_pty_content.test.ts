/**
 * Chat-UI ⇄ PTY content benchmark.
 *
 * The interactive tab has two skins over the SAME session:
 *   - Advanced: the xterm, fed the raw PTY byte stream (immediate).
 *   - Standard: SimpleChatPane, fed `process.flowDataStream` which is
 *     transcript-derived (`loadHistory` → `get-history`, plus live deltas).
 *
 * We have seen the Standard/chat view LAG behind the PTY: the agent's answer
 * is already on screen in the terminal while the chat surface hasn't caught up.
 * This test reproduces the user's manual scenario as a fixed benchmark:
 *
 *   1. Run an instruction in the "xterm" (boot a visible claude worker whose
 *      launch prompt is the instruction — exactly what typing+Enter does).
 *   2. Wait for the turn to land in the PTY (the marker appears in the byte
 *      stream that the xterm renders).
 *   3. "Toggle to chat UI": read `flowDataStream` the way SimpleChatPane does
 *      (force `loadHistory`), and assert the SAME core content is there.
 *
 * The chat-catch-up budget below is the SLO under test, NOT a flake cushion:
 * if the chat view never converges on what the PTY already shows, that IS the
 * lag bug and the test must fail. (Do not raise it to make a run go green.)
 *
 * Runs against the disposable `dev-1` instance (skips if not launched), exactly
 * like agentic_survives_restart — never touches the main backend.
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

/** Strip ANSI/VT control sequences so a plain marker substring-match works. */
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[\]P^_].*?(?:\x07|\x1b\\)|[\x00-\x08\x0b\x0c\x0e-\x1f]/g;

/** Decode the framed PTY stream's output frames into the plain text the xterm shows. */
function ptyPlainText(stream: { events: Array<[string, ...unknown[]]> } | null): string {
  if (!stream?.events?.length) return '';
  const dec = new TextDecoder('utf-8', { fatal: false });
  let out = '';
  for (const ev of stream.events) {
    if (ev[0] === 'o' && typeof ev[1] === 'string') {
      const bytes = Uint8Array.from(atob(ev[1]), (c) => c.charCodeAt(0));
      out += dec.decode(bytes, { stream: true });
    }
  }
  out += dec.decode();
  return out.replace(ANSI, '');
}

suite('Chat-UI vs PTY core-content parity (dev-1)', () => {
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

  it('the marker the PTY shows also reaches the chat stream', async () => {
    // A single contiguous token (no spaces → never line-wrapped by the TUI),
    // unique per run so we never match a previous turn's scrollback.
    const MARKER = `FLOWPADBENCH${Date.now().toString(36).toUpperCase()}`;
    const instruction =
      `Output exactly this token on its own line and then stop. ` +
      `Do not run any tools, do not explain: ${MARKER}`;

    // 1. "Run it in the xterm": a visible claude worker booting with the
    //    instruction as its launch prompt. This is the PTY/Advanced side.
    const proc = await sdk.AgenticProcess.openTab('claude_code', instruction);
    expect(proc?.id).toBeTruthy();

    // The worker binds its shell asynchronously after boot. `getById` would
    // hand back the cached (pre-bind) entity, so read fresh server state over
    // REST and poll until `shell_id` is populated (the PTY the xterm attaches).
    const entityUrl = `${sdk.GRAPH_API_PREFIX}/${sdk.AgenticProcess.type}/${proc.id}`;
    let shellId = '';
    await vi.waitFor(
      async () => {
        const fresh: any = await sdk.apiClient.get(entityUrl).catch(() => null);
        if (!fresh?.shell_id) throw new Error('shell_id not bound yet');
        shellId = fresh.shell_id;
      },
      { timeout: 60_000, interval: 1_000 },
    );
    expect(shellId).toBeTruthy();

    const ptyText = async (): Promise<string> => {
      const stream = await sdk.apiClient
        .get(`/shell/${shellId}/pty-stream`)
        .catch(() => null);
      return ptyPlainText(stream as any);
    };

    // 2. Wait for the answer to land in the PTY byte stream (what the xterm
    //    renders). This is the source-of-truth "the user can see it now".
    const tStart = Date.now();
    await vi.waitFor(
      async () => {
        if (!(await ptyText()).includes(MARKER)) {
          throw new Error('marker not in PTY stream yet');
        }
      },
      { timeout: 90_000, interval: 1_000 }, // claude boot + first turn budget
    );
    const tPty = Date.now();

    // 3. "Toggle to chat UI": read the stream exactly like SimpleChatPane —
    //    force a history (re)load, then inspect flowDataStream items. Poll
    //    until the chat view converges on the same core content.
    const chatText = async (): Promise<string> => {
      await proc.loadHistory({ force: true }).catch(() => {});
      return (proc.flowDataStream.items as any[])
        .map((it) => it.content ?? '')
        .join('\n');
    };

    await vi.waitFor(
      async () => {
        if (!(await chatText()).includes(MARKER)) {
          throw new Error('chat stream has not caught up to the PTY');
        }
      },
      // SLO under test: once the PTY shows it, the chat surface must converge
      // within this budget. Failure here IS the lag bug — do not widen it.
      { timeout: 20_000, interval: 1_000 },
    );
    const tChat = Date.now();

    // Both skins of the same session must agree on the core content.
    expect(await ptyText()).toContain(MARKER);
    expect(await chatText()).toContain(MARKER);

    // Benchmark signal: how far the chat view trailed the terminal.
    const ptyLatency = tPty - tStart;
    const chatLag = tChat - tPty;
    // eslint-disable-next-line no-console
    console.log(
      `[chat-vs-pty] PTY showed marker after ${ptyLatency}ms; ` +
        `chat caught up ${chatLag}ms later.`,
    );
  }, 180_000);
});
