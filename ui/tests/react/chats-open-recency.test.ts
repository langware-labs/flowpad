/**
 * RCA repro (left-menu chat open ↛ list recency/highlight): opening an agentic
 * process from the Chats left menu stamps the entity server-side
 * (`AgenticProcess.last_active_at`, via the generic `activate` action fired by
 * `loadProcess`) — proven live — yet `useChatHistory()`:
 *
 *   1. never carries the materialized `agentic_process_id` onto the entry
 *      (worker-history is fetched ONCE; the id is minted BY the open), so the
 *      ChatsNavigator highlight (`entry.agentic_process_id === activeProcessId`)
 *      can never match;
 *   2. never re-sorts: the sort key (`tsOf` → `entry.last_active_time`) is the
 *      TRANSCRIPT's last content timestamp only — the open stamp is not part of
 *      the key, so an opened chat stays buried until a new message lands. This
 *      holds even after an explicit `refetch()` (the backend never surfaces
 *      `last_active_at` per row) — the two levers are independent;
 *   3. after closing tabs the order still reflects transcript time, not
 *      last-open time.
 *
 * Faithful, no-mock: sessions are REAL JSONL transcripts under
 * `~/.claude/projects/<dir>/` (exactly what the backend's worker-history walks);
 * the "open from the left menu" is the REAL production path minus the router —
 * `AgenticProcess.getByWorkerId` (the heal the navigator calls) + the
 * `activate` action + the Tab materialization `loadProcess` performs. Closes go
 * through the real `POST /graph/tab/<id>/close`.
 *
 * Expected to FAIL today on the `open →` / `close →` cases (the bug); the
 * "create" case locks the working baseline. Fix shape: worker-history surfaces
 * the entity `last_active_at` and the client sorts by
 * max(last_active_time, last_active_at) + reconciles `agentic_process_id`
 * after an open (refetch/patch, or navigator matches by worker_id).
 */
import { AgenticProcess, Tab } from '@sdk';
import { renderHook, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { useChatHistory } from '@src/components/chats-navigator/useChatHistory';
import { allScope } from '@sdk/utils/scope-filter';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

// ── Real on-disk session fixtures (what worker-history actually reads) ──────

/** One fixture project dir; a NON-scratch encoded name so worker-history does
 *  not filter it (unlike `-history-merge-test-` which is scratch-listed). */
const FIXTURE_DIR = path.join(
  os.homedir(),
  '.claude',
  'projects',
  `-rca-chats-open-recency-${randomUUID()}`,
);

/** Write a real Claude session JSONL whose last content `timestamp` (the
 *  worker-history sort key) and file mtime are both `ts`. */
function writeSession(sessionId: string, prompt: string, ts: Date): string {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  const jsonlPath = path.join(FIXTURE_DIR, `${sessionId}.jsonl`);
  const iso = ts.toISOString();
  const lines = [
    JSON.stringify({
      type: 'user',
      sessionId,
      timestamp: iso,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId,
      timestamp: iso,
      message: { role: 'assistant', content: [{ type: 'text', text: `reply to: ${prompt}` }] },
    }),
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf-8');
  fs.utimesSync(jsonlPath, ts, ts);
  return jsonlPath;
}

const S1 = randomUUID(); // newest transcript
const S2 = randomUUID(); // middle
const S3 = randomUUID(); // oldest transcript — the one we "open"
const FIXTURES = new Set([S1, S2, S3]);

const hourAgo = (h: number) => new Date(Date.now() - h * 3600_000);

/** The REAL left-menu open path, minus the router: the navigator's
 *  `getByWorkerId` heal, then exactly what `loadProcess` does on arrival —
 *  the server-side `activate` recency stamp and the Tab materialization.
 *  (`loadProcess` fires activate fire-and-forget; awaiting it here only makes
 *  the test deterministic — same action, same server clock.) */
async function openFromLeftMenu(workerId: string): Promise<{ p: AgenticProcess; tab: Tab }> {
  const p = await AgenticProcess.getByWorkerId(workerId, 'claude');
  expect(p, `getByWorkerId(${workerId}) must heal the on-disk session`).toBeTruthy();
  await p!.activate();
  const created = await Tab.newTab(`dock/${AgenticProcess.type}-${p!.id}`, {
    targetType: AgenticProcess.type,
    targetId: p!.id,
  });
  const tab = created.find((t) => t.target_id === p!.id);
  expect(tab, 'open must materialize a Tab').toBeTruthy();
  return { p: p!, tab: tab! };
}

type HookResult = ReturnType<typeof useChatHistory>;

/** Flatten buckets (bucketize preserves the global sort) → our fixtures only. */
function fixtureOrder(r: HookResult): string[] {
  return r.buckets
    .flatMap((b) => b.entries)
    .filter((e) => FIXTURES.has(e.worker_id))
    .map((e) => e.worker_id);
}

function renderChatHistory() {
  return renderHook(() => useChatHistory({ scope: allScope(), search: '' }));
}

async function settled(rendered: ReturnType<typeof renderChatHistory>): Promise<void> {
  await waitFor(
    () => {
      expect(rendered.result.current.isLoading).toBe(false);
      expect(fixtureOrder(rendered.result.current)).toHaveLength(3);
    },
    { timeout: 8000 },
  );
}

const openedTabs: Tab[] = [];

describe('useChatHistory — open/close recency + highlight linkage matrix', () => {
  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo(), 'chats-open-recency');
    writeSession(S1, 'RCA fixture one', hourAgo(1));
    writeSession(S2, 'RCA fixture two', hourAgo(2));
    writeSession(S3, 'RCA fixture three', hourAgo(3));
  });

  afterAll(async () => {
    for (const tab of openedTabs) {
      await Tab.closeById(tab.id).catch(() => {});
    }
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
  });

  it('create: fabricated sessions appear, recency-sorted by transcript time', async () => {
    const rendered = renderChatHistory();
    await settled(rendered);
    expect(fixtureOrder(rendered.result.current)).toEqual([S1, S2, S3]);
    rendered.unmount();
  });

  it('open: the entry carries the materialized agentic_process_id (highlight contract)', async () => {
    const rendered = renderChatHistory();
    await settled(rendered);

    const { p, tab } = await openFromLeftMenu(S3);
    openedTabs.push(tab);

    // The ChatsNavigator highlight is `entry.agentic_process_id === activeProcessId`
    // (URL-first: the URL now holds p.id). The hook must expose that linkage.
    await waitFor(
      () => {
        const entry = rendered.result.current.buckets
          .flatMap((b) => b.entries)
          .find((e) => e.worker_id === S3);
        expect(entry?.agentic_process_id).toBe(p.id);
      },
      { timeout: 5000 },
    );
    rendered.unmount();
  });

  it('open: the opened chat sorts to the top (last-active OR last-opened)', async () => {
    const rendered = renderChatHistory();
    await settled(rendered);

    // S3 was opened (and its entity activate-stamped) in the previous case —
    // its open stamp is newer than every fixture transcript. It must lead.
    await waitFor(
      () => expect(fixtureOrder(rendered.result.current)[0]).toBe(S3),
      { timeout: 5000 },
    );
    rendered.unmount();
  });

  it('open: sort reflects the open stamp even after an explicit refetch', async () => {
    const rendered = renderChatHistory();
    await settled(rendered);

    // Isolates the sort lever from the staleness lever: with provably FRESH
    // data (post-open refetch), the opened chat must still lead. Today the
    // backend row never carries last_active_at and tsOf() reads only the
    // transcript timestamp, so this fails even fresh.
    await rendered.result.current.refetch();
    await waitFor(
      () => expect(fixtureOrder(rendered.result.current)[0]).toBe(S3),
      { timeout: 5000 },
    );
    rendered.unmount();
  });

  it('close two: entries survive and order still reflects last-open recency', async () => {
    // Open the remaining two (S1 then S2, strictly after S3's open) → open
    // recency is now S2 > S1 > S3, all newer than any transcript timestamp.
    const o1 = await openFromLeftMenu(S1);
    const o2 = await openFromLeftMenu(S2);
    openedTabs.push(o1.tab, o2.tab);

    // Close two of the three tabs through the real strip action. Closing is
    // not an activity signal: it must neither drop the entries nor reorder.
    await Tab.closeById(o2.tab.id);
    await Tab.closeById(o1.tab.id);

    const rendered = renderChatHistory();
    await settled(rendered);
    expect(fixtureOrder(rendered.result.current)).toEqual([S2, S1, S3]);
    rendered.unmount();
  });
});
