/**
 * History merge validation.
 *
 * Exercises the full loadHistory → flowDataStream merge path without
 * requiring a live Claude CLI subprocess. The transcript JSONL is
 * crafted on disk under `~/.claude/projects/<test>/<session_id>.jsonl`;
 * the backend's `session_history.load_session_history` reads it, the
 * `get-history` action serializes to FlowData dicts, and the client's
 * `loadHistory` ingests them into `flowDataStream` with dedup.
 *
 * Two scenarios:
 *   1. Single-turn restore: empty stream + loadHistory → history items appear.
 *   2. Two-turn merge: stream pre-populated from turn 1 JSONL, then turn 2
 *      appended to JSONL, then loadHistory(force) again → merge adds the new
 *      turn without duplicating the first.
 *
 * Requires: running backend at localhost:9008. Does NOT require `claude` on PATH.
 */

import { AgenticProcess, FlowElementTypes } from '@sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

const TIMEOUT = 60_000;

// ── Transcript fixture helpers ─────────────────────────────────────────────

function claudeProjectsDir(): string {
  return path.join(os.homedir(), '.claude', 'projects');
}

function makeJsonlTranscript(sessionId: string, turns: Array<{ user: string; assistant: string }>): string {
  const projectsRoot = claudeProjectsDir();
  // Claude CLI encodes the workdir in the project-dir name. For our test we
  // just need any unique dir so the session file is findable via the "search
  // all projects" fallback in get_session_jsonl_path.
  const projectDir = path.join(projectsRoot, `-history-merge-test-${randomUUID()}`);
  fs.mkdirSync(projectDir, { recursive: true });

  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  const lines: string[] = [];
  for (const turn of turns) {
    lines.push(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: turn.user }] },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: turn.assistant }],
        },
      }),
    );
  }
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf-8');
  return jsonlPath;
}

function appendTurn(jsonlPath: string, user: string, assistant: string): void {
  const lines = [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: user }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: assistant }] },
    }),
  ];
  fs.appendFileSync(jsonlPath, lines.join('\n') + '\n', 'utf-8');
}

// Key a FlowData by (elementType, role, content). Matches the dedup pattern
// used inside AgenticProcess.loadHistory at line ~820.
function dedupKey(item: { elementType: string; attributes: Record<string, unknown>; content?: string }): string {
  const role = String(item.attributes?.role ?? '');
  return `${item.elementType}|${role}|${item.content ?? ''}`;
}

describe('AgenticProcess history merge (from JSONL)', () => {
  let jsonlPath: string | null = null;

  beforeEach(async (ctx: any) => {
    await apiTestSetup(getTestSignupInfo(), ctx.task.name);
    jsonlPath = null;
  });

  it('single-turn: loadHistory restores a user + assistant message into an empty stream', async () => {
    const sessionId = randomUUID();
    jsonlPath = makeJsonlTranscript(sessionId, [
      { user: 'MERGE TEST prompt ONE', assistant: 'MERGE TEST reply ONE' },
    ]);

    // Save the process server-side with the crafted session_id so the
    // get-history action (which reads self.session_id on the server) can
    // resolve to our fixture JSONL.
    const proc = await new AgenticProcess({ session_id: sessionId } as any).save([]);
    expect(proc.flowDataStream.items.length, 'stream starts empty').toBe(0);

    await proc.loadHistory({ force: true });

    const items = proc.flowDataStream.items;
    console.log(
      '[history_merge] single-turn restored:',
      items.map((i) => `${i.elementType}(${i.attributes?.role ?? ''})`).join(', '),
    );

    expect(items.length, 'stream should have history items').toBeGreaterThan(0);

    const userItems = items.filter((i) => i.attributes?.role === 'user');
    const assistantItems = items.filter((i) => i.attributes?.role === 'assistant');
    expect(userItems.length, 'exactly one user message').toBe(1);
    expect(assistantItems.length, 'at least one assistant message').toBeGreaterThanOrEqual(1);

    expect(String(userItems[0].content ?? userItems[0].data ?? '')).toContain('MERGE TEST prompt ONE');
    expect(
      assistantItems.map((a) => String(a.content ?? a.data ?? '')).join(' '),
    ).toContain('MERGE TEST reply ONE');
  }, TIMEOUT);

  it('two-turn: second loadHistory merges a new turn without duplicating the first', async () => {
    const sessionId = randomUUID();
    jsonlPath = makeJsonlTranscript(sessionId, [
      { user: 'MERGE TEST prompt TWO-A', assistant: 'MERGE TEST reply TWO-A' },
    ]);

    const proc = await new AgenticProcess({ session_id: sessionId } as any).save([]);

    // First load — turn 1.
    await proc.loadHistory({ force: true });
    const afterTurn1 = proc.flowDataStream.items.slice();
    expect(afterTurn1.length, 'turn 1 should populate the stream').toBeGreaterThan(0);

    const turn1UserCount = afterTurn1.filter((i) => i.attributes?.role === 'user').length;
    expect(turn1UserCount).toBe(1);

    // Append turn 2 to the same transcript.
    appendTurn(jsonlPath, 'MERGE TEST prompt TWO-B', 'MERGE TEST reply TWO-B');

    // Second load with force: merge should bring turn 2 in AND not duplicate turn 1.
    await proc.loadHistory({ force: true });
    const afterTurn2 = proc.flowDataStream.items;
    console.log(
      '[history_merge] after turn 2:',
      afterTurn2.map((i) => `${i.elementType}(${i.attributes?.role ?? ''}):${String(i.content ?? '').slice(0, 20)}`).join(' | '),
    );

    // Expect both turns visible.
    const userItems = afterTurn2.filter((i) => i.attributes?.role === 'user');
    const assistantItems = afterTurn2.filter((i) => i.attributes?.role === 'assistant');
    expect(userItems.length, 'two user messages after merge').toBe(2);
    expect(assistantItems.length, 'two assistant messages after merge').toBeGreaterThanOrEqual(2);

    const userContents = userItems.map((u) => String(u.content ?? u.data ?? ''));
    expect(userContents.some((c) => c.includes('TWO-A')), 'turn 1 user survives').toBe(true);
    expect(userContents.some((c) => c.includes('TWO-B')), 'turn 2 user appears').toBe(true);

    // No duplicates by content-hash.
    const keys = afterTurn2.map(dedupKey);
    const uniq = new Set(keys);
    expect(uniq.size, `no dupes in merged stream (keys=${keys.length})`).toBe(keys.length);

    // Order: turn-1 user appears before turn-2 user.
    const idxTurn1 = afterTurn2.findIndex((i) => String(i.content ?? '').includes('TWO-A') && i.attributes?.role === 'user');
    const idxTurn2 = afterTurn2.findIndex((i) => String(i.content ?? '').includes('TWO-B') && i.attributes?.role === 'user');
    expect(idxTurn1).toBeGreaterThanOrEqual(0);
    expect(idxTurn2).toBeGreaterThan(idxTurn1);
  }, TIMEOUT);
});
