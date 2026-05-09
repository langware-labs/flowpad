/**
 * docker_container_pty — Long Integration Test
 *
 * Mirrors e2b_sandbox_pty.test.ts for the Docker compute provider:
 *   1. Bootstrap exposes docker_available + docker_compute_nodes (≥1 entry).
 *   2. Create a Shell bound to the first docker CN.
 *   3. Start PTY via terminal-command/start — backend's DockerComputeProvider
 *      sends RPC to the in-container worker which spawns a real bash PTY.
 *   4. Send keystrokes over WS, read output over WS.
 *   5. Assert `uname -s` returns Linux (container kernel, not host).
 *
 * Skipped when the backend has no docker workers registered. To enable:
 *   flow compute connect <container> --start
 */

import { apiClient, ComputeNode, ConnectionManager, dataContext, GRAPH_API_PREFIX, Shell, TypeId } from '@sdk';
import { v4 as uuidv4 } from 'uuid';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

interface PtyOutputMsg {
  message_type: 'pty_output_msg';
  shell_id: string;
  data: string;
  seq?: number;
}

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
      reject(new Error(`Timeout waiting for "${keyword}" ×${minOccurrences}. Got: ${accumulated.slice(-300)}`));
    }, timeoutMs);

    const handler = (msg: PtyOutputMsg) => {
      if (msg.shell_id !== shellId) return;
      accumulated += decodePtyData(msg.data);
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

function extractBetweenMarkers(raw: string, start: string, end: string): string {
  const startIdx = raw.lastIndexOf(start);
  if (startIdx === -1) return '';
  const afterStart = raw.slice(startIdx + start.length);
  const endIdx = afterStart.indexOf(end);
  if (endIdx === -1) return '';
  const slice = afterStart.slice(0, endIdx);
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
// Suite
// ---------------------------------------------------------------------------

describe('docker_container_pty', () => {
  const info = getTestSignupInfo();
  let manager: ConnectionManager;
  let dockerNode: ComputeNode;

  beforeEach(async (context: any) => {
    try {
      await fetch(`${window.location.origin}/health/status`, { signal: AbortSignal.timeout(2000) });
    } catch {
      throw new Error('Server not running — start it with: uv run -m flow_sdk.server.run');
    }

    await apiTestSetup(info, context.task.name);

    if (!dataContext.bootstrapInfo?.docker_available || dataContext.dockerComputeNodes.length === 0) {
      context.skip(
        'No docker compute nodes registered. Run `flow compute connect <container> --start` first.',
      );
      return;
    }
    dockerNode = dataContext.dockerComputeNodes[0];

    manager = ConnectionManager.getInstance();
    await vi.waitFor(
      () => { if (!manager.connected) throw new Error('WS not connected'); },
      { timeout: 5000, interval: 200 },
    );
  });

  it('bootstrap exposes @docker-* compute node + docker_available flag', () => {
    expect((dockerNode as any).uname).toMatch(/^docker-/);
    expect(dockerNode.id).toBeTruthy();
    expect(dataContext.bootstrapInfo?.docker_available).toBe(true);
  });

  it('Container-button flow: create Shell on @docker-*, start PTY, echo marker, see marker', async () => {
    const shellId = await createShell(dockerNode.id, 'docker-echo-test');
    await startPty(dockerNode.id, shellId, manager);

    const marker = `docker_hello_${Date.now()}`;
    const p = waitForPtyKeyword(manager, shellId, marker);
    await sendPtyInput(manager, dockerNode.id, shellId, `echo ${marker}\n`);
    const out = await p;
    expect(out).toContain(marker);
  }, 60_000);

  it('container identity: uname -a returns Linux (proves PTY is in the container, not the host)', async () => {
    const shellId = await createShell(dockerNode.id, 'docker-identity-test');
    await startPty(dockerNode.id, shellId, manager);

    const START = '__DOCKER_UNAME_START__';
    const END = '__DOCKER_UNAME_END__';
    const promise = waitForPtyKeyword(manager, shellId, END, 30000, 2);
    await sendPtyInput(
      manager,
      dockerNode.id,
      shellId,
      `printf '%s\\n' ${START} && uname -a && printf '%s\\n' ${END}\n`,
    );
    const raw = await promise;
    const line = extractBetweenMarkers(raw, START, END);
    // eslint-disable-next-line no-console
    console.log(`\n[docker-container] uname -a → ${line}\n`);
    expect(line.length).toBeGreaterThan(0);
    expect(line).toContain('Linux');
    expect(line).not.toContain('Darwin');
  }, 60_000);

  it('TS Shell class: shell.sendInput + shell.onOutput round-trip + OS report', async () => {
    const shellId = await createShell(dockerNode.id, 'ts-shell-docker-identity');
    await startPty(dockerNode.id, shellId, manager);

    const { dataManager } = await import('@sdk');
    const shell = await dataManager.getByTypeId<Shell>(new TypeId(Shell.type, shellId));
    if (!shell) throw new Error(`Shell ${shellId} not in DataManager cache after save`);

    const pc: any = (shell as any).ptyConnection;
    pc.shellId = shell.id;
    pc.computeNodeId = dockerNode.id;
    pc.started = true;
    pc._replayDone = true;
    pc._attachedPtyId = shell.id;

    let accumulated = '';
    const unsub = shell.onOutput((data) => { accumulated += data; });
    if (!unsub) throw new Error('shell.onOutput returned undefined');

    const START = '__DOCKER_TS_START__';
    const END = '__DOCKER_TS_END__';
    await shell.sendInput(`printf '%s\\n' ${START} && uname -a && printf '%s\\n' ${END}\n`);

    await vi.waitFor(
      () => {
        let idx = -1; let count = 0;
        while ((idx = accumulated.indexOf(END, idx + 1)) !== -1) count++;
        if (count < 2) throw new Error(`waiting ${END} x2, have ${count}`);
      },
      { timeout: 10_000, interval: 100 },
    );
    unsub();

    const line = extractBetweenMarkers(accumulated, START, END);
    // eslint-disable-next-line no-console
    console.log(`\n[docker-container via TS Shell] uname -a → ${line}\n`);
    expect(line).toContain('Linux');
    expect(line).not.toContain('Darwin');
    expect(shell.compute_node_id).toBe(dockerNode.id);
  }, 60_000);

  it('Shell.start() on @docker-* routes sendInput/onOutput through the real docker PTY', async () => {
    const draft = Shell.create(dockerNode, { name: 'ts-shell-docker-start' });
    await draft.save();
    const { dataManager } = await import('@sdk');
    const shell = await dataManager.getByTypeId<Shell>(new TypeId(Shell.type, draft.id));
    if (!shell) throw new Error(`Shell ${draft.id} not in DataManager cache after save`);

    await shell.start({ cols: 80, rows: 24 });

    await vi.waitFor(
      () => {
        const probe = shell.onOutput(() => {});
        if (!probe) throw new Error('PtyConnection not ready');
        probe();
      },
      { timeout: 10_000, interval: 100 },
    );

    let accumulated = '';
    const unsub = shell.onOutput((data) => { accumulated += data; });
    if (!unsub) throw new Error('onOutput returned undefined');

    await shell.sendInput('echo docker_shell_start_ok\n');

    await vi.waitFor(
      () => {
        if (!accumulated.includes('docker_shell_start_ok')) {
          const pc: any = (shell as any).ptyConnection;
          throw new Error(
            `no output; state: started=${pc?.started} replayDone=${pc?.replayDone} isLive=${pc?.isLive} lastSeq=${pc?.lastSeq} accumulated=${accumulated.length}b`,
          );
        }
      },
      { timeout: 10_000, interval: 150 },
    );
    unsub();
  }, 30_000);
});
