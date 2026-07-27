/**
 * PTY stream replay route contract — `GET /api/v1/shell/{shell_id}/pty-stream`
 * consumed through the SDK-facing `fetchPtyStream` helper.
 *
 * This is the frontend entry point for attach-time history replay (see
 * ui/src/components/terminal/interactive-terminal/pty-replay.ts). It must:
 *   - return the framed stream ({v, cols, rows, events}) for a LIVE shell that
 *     has recorded output, and
 *   - return `null` (the 404 branch) for an unknown shell id.
 *
 * Drives the real backend end-to-end: a plain PTY is started through
 * `terminal-command/start`, output is produced through `terminal-command/input`,
 * and the stream is fetched through `fetchPtyStream`. Runs against a dedicated
 * instance_ctl backend selected via FLOW_INSTANCE (never the user's dev server).
 */

import { apiClient, ComputeNode, ConnectionManager, GRAPH_API_PREFIX } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { v4 as uuidv4 } from 'uuid';
import { apiTestSetup, get_local_compute_node, getTestSignupInfo } from '../utils/test-utils';
import { installCleanup, trackTypeId } from '../_cleanup';
import { fetchPtyStream } from '../../src/components/terminal/interactive-terminal/pty-replay';

installCleanup();

describe('pty_stream_replay', () => {
  const info = getTestSignupInfo();
  let computeNode: ComputeNode;

  beforeEach(async (context: any) => {
    await apiTestSetup(info, context.task.name);
    computeNode = await get_local_compute_node('pty-stream-node');
    await computeNode.setup();
  });

  it('fetchPtyStream returns a framed stream (200) for a live shell', async () => {
    const manager = ConnectionManager.getInstance();
    const shellId = uuidv4(); // pure UUID → a Shell entity is materialised
    trackTypeId('shell', shellId);

    const startUrl = `${GRAPH_API_PREFIX}/${ComputeNode.type}/${computeNode.id}/terminal-command/start`;
    await apiClient.post(startUrl, { shell_id: shellId, connection_id: manager.id, rows: 24, cols: 80 });

    // Produce deterministic output so the framed stream is non-empty. The PTY
    // may not be at its prompt on the first keystroke, so resend on each poll
    // until output is recorded (bounded — never a growing wait).
    const inputUrl = `${GRAPH_API_PREFIX}/${ComputeNode.type}/${computeNode.id}/terminal-command/input`;
    const marker = `REPLAY_MARKER_${uuidv4().replace(/-/g, '').slice(0, 12)}`;

    let stream = await fetchPtyStream(shellId);
    const deadline = Date.now() + 12000; // do not increase timeout without approval
    while (Date.now() < deadline && !(stream && stream.events.length > 0)) {
      await apiClient.post(inputUrl, { shell_id: shellId, data: `echo ${marker}\r` });
      await new Promise((r) => setTimeout(r, 300));
      stream = await fetchPtyStream(shellId);
    }

    expect(stream).not.toBeNull();
    expect(Array.isArray(stream!.events)).toBe(true);
    expect(stream!.events.length).toBeGreaterThan(0);
    // Framed v1 header with a real winsize — what replayPtyStream needs.
    expect(stream!.v).toBe(1);
    expect(typeof stream!.cols).toBe('number');
    expect(typeof stream!.rows).toBe('number');
  }, 15000);

  it('fetchPtyStream returns null (404) for an unknown shell id', async () => {
    const stream = await fetchPtyStream(uuidv4());
    expect(stream).toBeNull();
  }, 15000);
});
