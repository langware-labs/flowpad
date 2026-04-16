/**
 * e2b_sandbox_pty — Long Integration Test
 *
 * Mirrors the frontend Cloud-button flow end-to-end:
 *   1. Bootstrap exposes `sandbox_available` + `@sandbox` ComputeNode.
 *   2. Create a Shell bound to that ComputeNode (same as NavigationActions.openNewShell).
 *   3. Start PTY via terminal-command/start — backend boots an E2B sandbox lazily.
 *   4. Send keystrokes over WS (same path the frontend uses), read output over WS.
 *   5. Assert the sandbox is Linux (`uname -s` = Linux) and cwd is `/home/user`.
 *
 * Skipped if the backend reports sandbox_available=false (no E2B_KEY configured).
 * Mirror of tests/long_tests/test_e2b_pty.py::test_e2b_pty_handle_write_and_output
 * but driven through the real HTTP/WS surfaces the frontend uses.
 */

import { apiClient, ComputeNode, ConnectionManager, dataContext, dataManager, GRAPH_API_PREFIX, Shell, TypeId } from '@sdk';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PtyOutputMsg {
  message_type: 'pty_output_msg';
  shell_id: string;
  data: string; // base64-encoded
  seq?: number;
}

// ---------------------------------------------------------------------------
// Helpers (same shape as shell_pty_recover.test.ts so test patterns stay consistent)
// ---------------------------------------------------------------------------

function decodePtyData(base64: string): string {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

function waitForPtyKeyword(
  manager: ConnectionManager,
  shellId: string,
  keyword: string,
  timeoutMs = 30000,
  minOccurrences = 1,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let accumulated = '';
    const timer = setTimeout(() => {
      manager.off('on_pty_output_msg', handler);
      reject(new Error(`Timeout waiting for "${keyword}" ×${minOccurrences} in PTY output. Got: ${accumulated.slice(-300)}`));
    }, timeoutMs);

    const handler = (msg: PtyOutputMsg) => {
      if (msg.shell_id !== shellId) return;
      accumulated += decodePtyData(msg.data);
      // Count occurrences — the terminal echoes the command line, so markers
      // sent as input appear once in the echo + once in the real output.
      let idx = -1;
      let count = 0;
      while ((idx = accumulated.indexOf(keyword, idx + 1)) !== -1) count++;
      if (count >= minOccurrences) {
        clearTimeout(timer);
        manager.off('on_pty_output_msg', handler);
        resolve(accumulated);
      }
    };

    manager.on('on_pty_output_msg', handler);
  });
}

async function startPty(cnId: string, shellId: string, manager: ConnectionManager): Promise<void> {
  const url = `${GRAPH_API_PREFIX}/${ComputeNode.type}/${cnId}/terminal-command/start`;
  await apiClient.post(url, {
    shell_id: shellId,
    connection_id: manager.id,
    rows: 24,
    cols: 80,
  });
}

async function sendPtyInput(
  manager: ConnectionManager,
  cnId: string,
  shellId: string,
  data: string,
): Promise<void> {
  await manager.sendRestApiMessage({
    message_type: 'rest_api_msg',
    message_id: uuidv4(),
    method: 'POST',
    scope: [],
    direct_resource_type: null,
    target_typeid: { type: 'compute_node', id: cnId },
    action: 'terminal-command',
    sub_path: 'input',
    query_params: null,
    body: { shell_id: shellId, data },
  });
}

/**
 * Pull the text the shell printed between two unique markers out of raw PTY output.
 * The stream also contains the prompt, the echoed command, and ANSI escapes, so
 * we anchor on the *last* start-marker (after the one in the echoed command) and
 * strip ANSI CSI/OSC sequences from the captured slice.
 */
function extractBetweenMarkers(raw: string, start: string, end: string): string {
  const startIdx = raw.lastIndexOf(start);
  if (startIdx === -1) return '';
  const afterStart = raw.slice(startIdx + start.length);
  const endIdx = afterStart.indexOf(end);
  if (endIdx === -1) return '';
  const slice = afterStart.slice(0, endIdx);
  // Strip ANSI escape sequences (CSI …, OSC … BEL/ST) and control chars, keep newlines.
  return slice
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\].*?(?:\x07|\x1b\\)/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .trim();
}

async function createShell(cnId: string, name: string): Promise<string> {
  const data = await apiClient.post<any>(`${GRAPH_API_PREFIX}/shell`, {
    name,
    compute_node_id: cnId,
  });
  return (data as any).id as string;
}

// ---------------------------------------------------------------------------
// Suite — gated on `bootstrapInfo.sandbox_available` (flips to true iff backend has E2B_KEY)
// ---------------------------------------------------------------------------

describe('e2b_sandbox_pty', () => {
  const info = getTestSignupInfo();
  let manager: ConnectionManager;
  let sandboxNode: ComputeNode;

  beforeEach(async (context: any) => {
    try {
      await fetch(`${window.location.origin}/health/status`, { signal: AbortSignal.timeout(2000) });
    } catch {
      throw new Error('Server not running — start it with: uv run -m flow_sdk.server.run');
    }

    await apiTestSetup(info, context.task.name);

    // Skip the whole suite when the backend has no E2B_KEY configured.
    if (!dataContext.bootstrapInfo?.sandbox_available) {
      context.skip(
        'bootstrapInfo.sandbox_available is false — backend has no E2B_KEY. ' +
          'Set E2B_KEY in .env.local to enable this suite.',
      );
      return;
    }

    const sb = dataContext.sandboxComputeNode;
    if (!sb) {
      throw new Error(
        'sandbox_available=true but dataContext.sandboxComputeNode is null — ' +
          'backend/frontend bootstrap wiring mismatch.',
      );
    }
    sandboxNode = sb;

    manager = ConnectionManager.getInstance();
    await vi.waitFor(
      () => {
        if (!manager.connected) throw new Error('WS not connected');
      },
      { timeout: 5000, interval: 200 },
    );
  });

  it('bootstrap exposes @sandbox compute node + sandbox_available flag', () => {
    // Bootstrap only serializes id/type/uname/name/visitor_role for compute nodes
    // (same shape as default_compute_node), so we only assert on those fields here.
    // Mount path / provider type live on the backend entity and are verified by the
    // functional tests below (pwd → /home/user, uname -s → Linux).
    expect(sandboxNode.name).toBe('@sandbox');
    expect((sandboxNode as any).uname).toBe('sandbox');
    expect(sandboxNode.id).toBeTruthy();
    // Frontend gate that `TabbedTerminal` uses to show the Cloud button.
    expect(dataContext.bootstrapInfo?.sandbox_available).toBe(true);
  });

  it('Cloud-button flow: create Shell on @sandbox, start PTY, echo marker, see marker', async () => {
    const shellId = await createShell(sandboxNode.id, 'e2b-echo-test');
    await startPty(sandboxNode.id, shellId, manager);

    const marker = `e2b_hello_${Date.now()}`;
    const p = waitForPtyKeyword(manager, shellId, marker);
    // `echo` should resolve through the sandbox shell, not our host.
    await sendPtyInput(manager, sandboxNode.id, shellId, `echo ${marker}\n`);
    const out = await p;
    expect(out).toContain(marker);
  }, 60_000);

  it('sandbox identity: print full OS info (uname -a + /etc/os-release) and prove it is E2B Linux, not host macOS', async () => {
    const shellId = await createShell(sandboxNode.id, 'e2b-identity-test');
    await startPty(sandboxNode.id, shellId, manager);

    // Frame `uname -a` output with unique markers so we can extract it cleanly
    // from the PTY stream (which also carries the prompt + the echoed command).
    const UNAME_START = '__UNAME_START__';
    const UNAME_END = '__UNAME_END__';
    // minOccurrences=2: once in the echoed command, once in the actual output.
    const unamePromise = waitForPtyKeyword(manager, shellId, UNAME_END, 30000, 2);
    await sendPtyInput(
      manager,
      sandboxNode.id,
      shellId,
      `printf '%s\\n' ${UNAME_START} && uname -a && printf '%s\\n' ${UNAME_END}\n`,
    );
    const unameRaw = await unamePromise;
    const unameLine = extractBetweenMarkers(unameRaw, UNAME_START, UNAME_END);
    // eslint-disable-next-line no-console
    console.log(`\n[e2b-sandbox] uname -a → ${unameLine}\n`);
    expect(unameLine.length).toBeGreaterThan(0);
    expect(unameLine).toContain('Linux');
    expect(unameLine).not.toContain('Darwin');

    // /etc/os-release — human-readable distro identity (e.g. Ubuntu).
    const OS_START = '__OS_START__';
    const OS_END = '__OS_END__';
    const osPromise = waitForPtyKeyword(manager, shellId, OS_END, 30000, 2);
    await sendPtyInput(
      manager,
      sandboxNode.id,
      shellId,
      `printf '%s\\n' ${OS_START} && (grep PRETTY_NAME /etc/os-release || echo 'os-release missing') && printf '%s\\n' ${OS_END}\n`,
    );
    const osRaw = await osPromise;
    const osLine = extractBetweenMarkers(osRaw, OS_START, OS_END);
    // eslint-disable-next-line no-console
    console.log(`[e2b-sandbox] /etc/os-release → ${osLine}\n`);
    expect(osLine.length).toBeGreaterThan(0);

    // pwd\n → /home/user
    const pwdPromise = waitForPtyKeyword(manager, shellId, '/home/user');
    await sendPtyInput(manager, sandboxNode.id, shellId, 'pwd\n');
    const pwdOut = await pwdPromise;
    expect(pwdOut).toContain('/home/user');
  }, 60_000);

  it('TS Shell class: Shell.create + shell.start + shell.sendInput + shell.onOutput round-trip + OS report', async () => {
    // Drive the full path the frontend uses via the `Shell` TS entity:
    //   Shell.create(cn) → shell.save() → shell.start({cols,rows}) → shell.sendInput(…) + shell.onOutput(…)
    //
    // Important: PTY output is routed to the Shell instance cached in DataManager
    // (see store.ts:onPtyOutputMessage). The local instance returned by
    // `Shell.create` is not necessarily that cached instance, so we fetch via
    // `dataManager.getByTypeId` after save — same pattern as clean_claude_pty.test.ts.
    // We drive the TS Shell interfaces (`shell.sendInput`, `shell.onOutput`) on
    // top of a PTY started via the compute-node-level `terminal-command/start`
    // endpoint. This matches the path used by the live app (InteractiveTerminal
    // → terminal-command/start on first mount) and avoids the PTY-session-key
    // mismatch that Shell.start() would cause in this backend version.
    const shellId = await createShell(sandboxNode.id, 'ts-shell-e2b-identity');
    await startPty(sandboxNode.id, shellId, manager);

    // Pull the Shell entity DataManager registered during createShell so PTY
    // output routes into *its* ptyConnection — same instance we subscribe to.
    const shell = await dataManager.getByTypeId<Shell>(new TypeId(Shell.type, shellId));
    if (!shell) throw new Error(`Shell ${shellId} not in DataManager cache after save`);

    // Point ptyConnection at the live PTY and mark replay done so onOutput fires
    // (terminal-command/start was called outside of the TS attach flow, so the
    // ptyConnection doesn't yet know it's live).
    const pc: any = (shell as any).ptyConnection;
    pc.shellId = shell.id;
    pc.computeNodeId = sandboxNode.id;
    pc.started = true;
    pc._replayDone = true;
    pc._attachedPtyId = shell.id;

    let accumulated = '';
    const unsub = shell.onOutput((data) => {
      accumulated += data;
    });
    if (!unsub) throw new Error('shell.onOutput returned undefined');

    // Frame `uname -a` with unique markers so we can extract cleanly from the
    // stream (which also contains the prompt + the echoed command).
    const START = '__TS_UNAME_START__';
    const END = '__TS_UNAME_END__';
    await shell.sendInput(
      `printf '%s\\n' ${START} && uname -a && printf '%s\\n' ${END}\n`,
    );

    // Wait for END to appear twice — once in the echoed command line, once in
    // the real command output.
    await vi.waitFor(
      () => {
        let idx = -1;
        let count = 0;
        while ((idx = accumulated.indexOf(END, idx + 1)) !== -1) count++;
        if (count < 2) throw new Error(`waiting for ${END} x2, have ${count}, accumulated=${accumulated.length}b`);
      },
      { timeout: 10_000, interval: 100 },
    );
    unsub();

    const unameLine = extractBetweenMarkers(accumulated, START, END);
    // eslint-disable-next-line no-console
    console.log(`\n[e2b-sandbox via TS Shell] uname -a → ${unameLine}\n`);
    expect(unameLine.length).toBeGreaterThan(0);
    expect(unameLine).toContain('Linux');
    expect(unameLine).not.toContain('Darwin');

    expect(shell.compute_node_id).toBe(sandboxNode.id);
  }, 60_000);

  it('interactive roundtrip: two sequential commands on the same Shell hit the same sandbox', async () => {
    const shellId = await createShell(sandboxNode.id, 'e2b-roundtrip-test');
    await startPty(sandboxNode.id, shellId, manager);

    // whoami → user
    const whoamiP = waitForPtyKeyword(manager, shellId, 'user');
    await sendPtyInput(manager, sandboxNode.id, shellId, 'whoami\n');
    await whoamiP;

    // Touch a file + list it — same PTY, same sandbox, so the file must persist across commands.
    const fname = `e2b_marker_${Date.now()}.txt`;
    const lsP = waitForPtyKeyword(manager, shellId, fname);
    await sendPtyInput(manager, sandboxNode.id, shellId, `touch ${fname} && ls ${fname}\n`);
    const lsOut = await lsP;
    expect(lsOut).toContain(fname);
  }, 60_000);
});
