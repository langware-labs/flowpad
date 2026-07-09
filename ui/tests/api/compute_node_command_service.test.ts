/**
 * ComputeNode TS SDK: executeCommand / executeCommandStreaming, findSession,
 * and artifact service-control (docs/interface/compute-node.md).
 *
 * Drives the TS ComputeNode methods against a LIVE backend (the instance
 * selected by FLOW_INSTANCE — an own instance_ctl instance):
 *   - executeCommand      → parses the XML flow stream into {stdout, stderr, exitCode}
 *   - executeCommandStreaming → progressive stdout/stderr deltas + final exit code
 *   - findSession         → null on 404 (unknown session id)
 *   - get/stop/start/restartArtifactProcess → machine-status port lookup +
 *     the documented ServiceControlError guards; a spawn-based happy path runs
 *     where the OS lets us enumerate listening ports (skipped otherwise — macOS
 *     blocks psutil.net_connections without root, so the backend reports an
 *     empty network list and no port can be resolved).
 *
 * The compute node is created + saved via the SDK and tracked for cleanup.
 */

import { spawn, type ChildProcess } from 'node:child_process';

import { ComputeNode, ServiceControlError, ShellInputFlowData } from '@sdk';
import type { Artifact, ShellCmdProgress } from '@sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trackForCleanup } from '../_cleanup';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';

/** Minimal Artifact stand-in — the service-control methods only read id/port/start_cmd. */
function fakeArtifact(fields: { id?: string; port?: string; start_cmd?: string }): Artifact {
  return { id: 'artifact-fake', ...fields } as unknown as Artifact;
}

/** A high port unlikely to collide, unique per run. */
function pickPort(): number {
  return 8300 + Math.floor(Math.random() * 1500);
}

describe('compute_node_command_service', () => {
  const info = getTestSignupInfo();
  let computeNode: ComputeNode;

  beforeAll(async (context: any) => {
    await apiTestSetup(info, context.task?.name ?? 'compute_node_command_service');
    computeNode = trackForCleanup(await get_local_compute_node('cn-cmd-service-node'));
    await computeNode.setup();
  });

  // ---- executeCommand ----------------------------------------------------

  it('executeCommand parses stdout + exit code', async () => {
    const out = await computeNode.executeCommand(new ShellInputFlowData('echo exec-marker', 'cmd-1'));
    expect(out.stdout).toContain('exec-marker');
    expect(out.exitCode).toBe(0);
    expect(out.isComplete).toBe(true);
  }, 15000);

  it('executeCommand captures stderr and a non-zero exit code', async () => {
    const out = await computeNode.executeCommand(
      new ShellInputFlowData('echo boom 1>&2; exit 4', 'cmd-2'),
    );
    expect(out.stderr).toContain('boom');
    expect(out.exitCode).toBe(4);
  }, 15000);

  // ---- executeCommandStreaming ------------------------------------------

  it('executeCommandStreaming reports progressive stdout and a final exit code', async () => {
    let stdout = '';
    let finalExit: number | null = null;
    await computeNode.executeCommandStreaming(
      new ShellInputFlowData('echo stream-marker', 'cmd-3'),
      (p: ShellCmdProgress) => {
        stdout += p.stdoutDelta;
        if (p.exitCode !== null) finalExit = p.exitCode;
      },
    );
    expect(stdout).toContain('stream-marker');
    expect(finalExit).toBe(0);
  }, 15000);

  it('executeCommandStreaming interleaves stdout and stderr channels', async () => {
    let stdout = '';
    let stderr = '';
    await computeNode.executeCommandStreaming(
      new ShellInputFlowData("printf 'out-line\\n'; printf 'err-line\\n' 1>&2", 'cmd-4'),
      (p: ShellCmdProgress) => {
        stdout += p.stdoutDelta;
        stderr += p.stderrDelta;
      },
    );
    expect(stdout).toContain('out-line');
    expect(stderr).toContain('err-line');
  }, 15000);

  // ---- findSession -------------------------------------------------------

  it('findSession returns null for an unknown session id (404)', async () => {
    const result = await computeNode.findSession('00000000-0000-4000-8000-000000000000');
    expect(result).toBeNull();
  }, 15000);

  // ---- artifact service-control: documented guards -----------------------

  it('getArtifactProcess throws ServiceControlError when the artifact has no port', async () => {
    await expect(computeNode.getArtifactProcess(fakeArtifact({}))).rejects.toMatchObject({
      name: 'ServiceControlError',
      operation: 'get',
    });
  }, 15000);

  it('getArtifactProcess returns null when nothing is listening on the port', async () => {
    const result = await computeNode.getArtifactProcess(fakeArtifact({ port: String(pickPort()) }));
    expect(result).toBeNull();
  }, 15000);

  it('stopArtifactProcess throws ServiceControlError(stop) when the service is not running', async () => {
    await expect(
      computeNode.stopArtifactProcess(fakeArtifact({ port: String(pickPort()) })),
    ).rejects.toMatchObject({ name: 'ServiceControlError', operation: 'stop' });
  }, 15000);

  it('startArtifactProcess throws ServiceControlError(start) without a start_cmd', async () => {
    await expect(
      computeNode.startArtifactProcess(fakeArtifact({ port: String(pickPort()) })),
    ).rejects.toMatchObject({ name: 'ServiceControlError', operation: 'start' });
  }, 15000);

  it('restartArtifactProcess swallows the not-running stop, then fails on missing start_cmd', async () => {
    // stop → ServiceControlError(stop) is swallowed; start → throws(start).
    await expect(
      computeNode.restartArtifactProcess(fakeArtifact({ port: String(pickPort()) })),
    ).rejects.toMatchObject({ name: 'ServiceControlError', operation: 'start' });
  }, 15000);

  // ---- artifact service-control: spawn-based happy path (guarded) --------

  it('getArtifactProcess finds a spawned service and stopArtifactProcess kills it', async (ctx) => {
    const port = pickPort();
    const artifact = fakeArtifact({ port: String(port) });
    let child: ChildProcess | null = null;
    try {
      child = spawn('python3', ['-m', 'http.server', String(port)], { stdio: 'ignore' });
      // Give the server a moment to bind the port.
      await new Promise((r) => setTimeout(r, 1200));

      const found = await computeNode.getArtifactProcess(artifact);
      if (found === null) {
        // Platform can't enumerate listening ports (e.g. macOS psutil AccessDenied
        // → empty network list). Not a bug in the interface — skip the happy path.
        const status = await computeNode.getMachineStatus();
        expect(status.network.length).toBe(0);
        ctx.skip();
        return;
      }

      expect(found.pid).toBeGreaterThan(0);

      const killed = await computeNode.stopArtifactProcess(artifact);
      expect(killed.pid).toBe(found.pid);

      // After the kill the port is free again.
      await new Promise((r) => setTimeout(r, 500));
      const after = await computeNode.getArtifactProcess(artifact);
      expect(after).toBeNull();
    } finally {
      if (child && !child.killed) child.kill('SIGKILL');
    }
  }, 15000);

  afterAll(() => {
    // No spawned processes survive individual tests (each cleans up in finally).
  });
});
