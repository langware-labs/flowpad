/**
 * A received transcript's chip must stop being dashed the moment it installs —
 * without a page reload.
 *
 * The chip renders `chipStateFor(!!data, ma, forceShow)`, where `data` is
 * `useEntity(claude_session-<id>)`. Before install the backend answers 404 on
 * purpose (`ClaudeSession._arrived_as_attachment` refuses to invent the
 * SENDER's transcript for a not-yet-installed attachment). Installing flips
 * that: the same GET then resolves.
 *
 * But the client marked the first 404 TERMINAL. `dataManager` keeps a negative
 * cache keyed by TypeId and short-circuits every later ask — measured live at
 * 36ms for the first ask vs 0ms after — and nothing invalidates it when the
 * attachment installs (useEntity's fetch effect keys on
 * [enabled, type, id, query], none of which change; and no WS op can arrive
 * because this entity has no DB row, so nothing is ever saved or announced).
 * A reload builds a fresh dataManager, which is why only refreshing works.
 *
 * Enters through the same call the chip's `useEntity` makes —
 * `dataManager.getByTypeId(typeId)` — against a real backend, with a real
 * MessageAttachment row and a real transcript on disk. Nothing is mocked.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { config, dataManager, MessageAttachment, TypeId } from '@sdk';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

const SESSION_TYPE = 'claude_session';

/** The sender's transcript, in the store the backend's resolver actually reads. */
function writeSenderTranscript(sessionId: string, cwd: string): string {
  const claudeHome = process.env.FLOWPAD_CLAUDE_HOME || path.join(os.homedir(), '.claude');
  const dir = path.join(claudeHome, 'projects', cwd.replace(/\//g, '-'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(
    file,
    JSON.stringify({ sessionId, cwd, type: 'user', timestamp: new Date(0).toISOString() }) + '\n',
    'utf-8',
  );
  return file;
}

async function postEntity(body: { type: string } & Record<string, unknown>): Promise<void> {
  const r = await fetch(`${config.SERVER_URL}/graph/${body.type}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`POST ${body.type} failed: ${r.status} ${await r.text()}`);
}

/** Ground truth, straight off the wire — did the BACKEND flip? */
async function serverResolves(sessionId: string): Promise<boolean> {
  const r = await fetch(`${config.SERVER_URL}/graph/${SESSION_TYPE}/${sessionId}`);
  if (!r.ok) return false;
  const body = await r.json();
  return body?.status === 'SUCCESS' && body?.data?.id === sessionId;
}

describe('api: received transcript chip reactivity', () => {
  const signupInfo = getTestSignupInfo();
  const created: string[] = [];

  beforeEach(async (context: any) => {
    await apiTestSetup(signupInfo, context.task.name);
  });

  afterAll(() => {
    for (const f of created) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        /* best effort */
      }
    }
  });

  it('resolves the session as soon as the attachment installs, with no reload', async () => {
    const sessionId = crypto.randomUUID();
    const cwd = path.join(os.tmpdir(), `rca-sender-${sessionId.slice(0, 8)}`);
    created.push(writeSenderTranscript(sessionId, cwd));

    const maId = crypto.randomUUID();
    const maBase = {
      id: maId,
      type: MessageAttachment.type,
      asset_type: SESSION_TYPE,
      asset_id: sessionId,
      flow_message_id: crypto.randomUUID(),
      conversation_id: crypto.randomUUID(),
      name: 'shared transcript',
    };

    // --- staged: the chip mounts and asks once ---------------------------
    await postEntity({ ...maBase, scope: null });

    const typeId = new TypeId(SESSION_TYPE, sessionId);
    const whileStaged = await dataManager.getByTypeId(typeId);
    expect(whileStaged, 'a staged transcript must NOT resolve — the chip is correctly dashed').toBeNull();
    expect(await serverResolves(sessionId)).toBe(false);

    // --- install ----------------------------------------------------------
    await postEntity({ ...maBase, scope: 'project', installed_root: cwd });

    // Cross-check: the BACKEND really flipped, so a still-dashed chip can only
    // be the client's doing.
    expect(await serverResolves(sessionId), 'backend must resolve it once installed').toBe(true);

    // --- the chip asks again (what a re-render would do) -------------------
    const afterInstall = await dataManager.getByTypeId(typeId);
    expect(
      afterInstall,
      'the client still answers from its terminal not-found cache, so the chip stays dashed until reload',
    ).not.toBeNull();
  }, 20_000);
});
