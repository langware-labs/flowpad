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
 *   3. the recency sort must honor the anti-flicker stability window
 *      (`CHAT_SORT_STABILITY_MS`, 1 min in prod, 1 s here): deltas smaller
 *      than the window keep the current relative order;
 *   4. closing tabs is not an activity signal — entries survive and order
 *      still reflects last-open recency.
 *
 * Faithful, no-mock: sessions are REAL JSONL transcripts under the explicit
 * `$FLOWPAD_CLAUDE_HOME/projects/<dir>/` (exactly what worker-history
 * walks), with a real shared `cwd` (the heal 500s without one); the "open from
 * the left menu" is the REAL production path minus the router —
 * `AgenticProcess.getByWorkerId` (the heal the navigator calls) + the
 * `activate` action + the Tab materialization `loadProcess` performs. Closes
 * go through the real `POST /graph/tab/<id>/close`.
 *
 * Expected to FAIL today on every `open →` / `close →` case (the bug); the
 * "create" case locks the working baseline. Fix shape: worker-history
 * surfaces the entity `last_active_at`, the client sorts by
 * max(last_active_time, last_active_at) under the stability window, and the
 * entry's `agentic_process_id` is reconciled after an open.
 */
import { AgenticProcess, Project, Tab } from '@sdk';
import { renderHook, waitFor } from '@testing-library/react';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';

import { useChatHistory } from '@src/components/chats-navigator/useChatHistory';
import { allScope } from '@sdk/utils/scope-filter';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';

/** Test-mode stability window (prod: CHAT_SORT_STABILITY_MS = 1 min). Wide
 *  enough that two back-to-back opens (each a real heal + activate round trip)
 *  land INSIDE it; the achieved stamp delta is asserted as a precondition. */
const STABILITY_MS = 3000;
/** Comfortably ABOVE the window, for deterministic over-window decisions. */
const OVER_WINDOW_MS = STABILITY_MS + 600;

// ── Real on-disk session fixtures (what worker-history actually reads) ──────

const RUN = randomUUID();
const FLOW_INSTANCE = process.env.FLOW_INSTANCE?.trim() || '';
const CLAUDE_HOME = process.env.FLOWPAD_CLAUDE_HOME;
if (!CLAUDE_HOME || !path.isAbsolute(CLAUDE_HOME)) {
  throw new Error('FLOWPAD_CLAUDE_HOME must be an absolute cycle-owned path for chats-open-recency');
}
const FLOW_HOME = path.resolve(process.env.FLOW_HOME || path.join(os.homedir(), '.flow'));
/** NON-scratch encoded dir name so worker-history does not filter it (unlike
 *  `-history-merge-test-`, which is scratch-listed). */
const FIXTURE_DIR = path.join(CLAUDE_HOME, 'projects', `-rca-chats-open-recency-${RUN}`);
/** Shared real cwd for every fixture session: the `get_by_worker_id` heal
 *  refuses (500) a session with an unknown working directory, and a /tmp cwd
 *  would be scratch-filtered out of worker-history. */
const FIXTURE_CWD = path.join(FLOW_HOME, 'instances', FLOW_INSTANCE, 'react-fixtures', `chats-open-recency-${RUN}`);

function writeSession(sessionId: string, prompt: string, ts: Date): void {
  fs.mkdirSync(FIXTURE_DIR, { recursive: true });
  fs.mkdirSync(FIXTURE_CWD, { recursive: true });
  const jsonlPath = path.join(FIXTURE_DIR, `${sessionId}.jsonl`);
  const iso = ts.toISOString();
  const lines = [
    JSON.stringify({
      type: 'user',
      sessionId,
      timestamp: iso,
      cwd: FIXTURE_CWD,
      message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    }),
    JSON.stringify({
      type: 'assistant',
      sessionId,
      timestamp: iso,
      cwd: FIXTURE_CWD,
      message: { role: 'assistant', content: [{ type: 'text', text: `reply to: ${prompt}` }] },
    }),
  ];
  fs.writeFileSync(jsonlPath, lines.join('\n') + '\n', 'utf-8');
  fs.utimesSync(jsonlPath, ts, ts);
}

const S1 = randomUUID(); // newest transcript
const S2 = randomUUID(); // middle
const S3 = randomUUID(); // oldest transcript — opened first
const FIXTURES = new Set([S1, S2, S3]);

const hourAgo = (h: number) => new Date(Date.now() - h * 3600_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The REAL left-menu open path, minus the router: the navigator's
 *  `getByWorkerId` heal, then exactly what `loadProcess` does on arrival —
 *  the server-side `activate` recency stamp and the Tab materialization.
 *  (`loadProcess` fires activate fire-and-forget; awaiting it here only makes
 *  the test deterministic — same action, same server clock.) */
async function openFromLeftMenu(workerId: string): Promise<{ p: AgenticProcess; tab: Tab }> {
  const p = await AgenticProcess.getByWorkerId(workerId, 'claude');
  expect(p, `getByWorkerId(${workerId}) must heal the on-disk session`).toBeTruthy();
  await p!.activate();
  await Tab.newTab(`dock/${AgenticProcess.type}-${p!.id}`, {
    targetType: AgenticProcess.type,
    targetId: p!.id,
  });
  // `new_tab` responds with the BODY-scoped list (projectless here) while the
  // tab itself lands under the AP's project — resolve it via the global list.
  const all = await Tab.listAll();
  const tab = all.find((t) => t.target_id === p!.id);
  expect(tab, 'open must materialize a Tab').toBeTruthy();
  return { p: p!, tab: tab! };
}

type Rendered = ReturnType<typeof renderChatHistory>;

function renderChatHistory() {
  return renderHook(() => useChatHistory({ scope: allScope(), search: '' }, 50, STABILITY_MS));
}

/** Flatten buckets (bucketize preserves the global sort) → our fixtures only. */
function fixtureOrder(rendered: Rendered): string[] {
  return rendered.result.current.buckets
    .flatMap((b) => b.entries)
    .filter((e) => FIXTURES.has(e.worker_id))
    .map((e) => e.worker_id);
}

async function settled(rendered: Rendered): Promise<void> {
  await waitFor(
    () => {
      expect(rendered.result.current.isLoading).toBe(false);
      expect(fixtureOrder(rendered)).toHaveLength(3);
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
    // The heal adopts the fixture cwd into a minted Project — remove it (the
    // reactSetup sweep only covers agentic_process).
    try {
      const proj = await Project.getProjectByPath(FIXTURE_CWD);
      if (proj) await proj.delete();
    } catch {
      /* best-effort */
    }
    fs.rmSync(FIXTURE_DIR, { recursive: true, force: true });
    fs.rmSync(FIXTURE_CWD, { recursive: true, force: true });
  });

  it('create: fabricated sessions appear, recency-sorted by transcript time', async () => {
    const rendered = renderChatHistory();
    await settled(rendered);
    expect(fixtureOrder(rendered)).toEqual([S1, S2, S3]);
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
        const entry = rendered.result.current.buckets.flatMap((b) => b.entries).find((e) => e.worker_id === S3);
        expect(entry?.agentic_process_id).toBe(p.id);
      },
      { timeout: 5000 },
    );
    rendered.unmount();
  });

  it('open: the opened chat sorts to the top (last-active OR last-opened)', async () => {
    const rendered = renderChatHistory();
    await settled(rendered);

    // S3 was opened (activate-stamped) in the previous case; its open stamp
    // beats every fixture transcript by hours (≫ the stability window).
    await waitFor(() => expect(fixtureOrder(rendered)[0]).toBe(S3), { timeout: 5000 });
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
    await waitFor(() => expect(fixtureOrder(rendered)[0]).toBe(S3), { timeout: 5000 });
    rendered.unmount();
  });

  it('open ×2 honoring the stability window: under-window open must not overtake', async () => {
    // The stability window is about a LIVE list not shuffling under the user:
    // keep the hook MOUNTED across the opens, exactly like the real left menu.
    const rendered = renderChatHistory();
    await settled(rendered);

    // Open S2 well OVER the window after everything so far (S2 must lead),
    // then S1 back-to-back — UNDER the window after S2 (anti-flicker: S1 must
    // NOT jump over S2, but is over-window vs S3 so it outranks S3).
    await sleep(OVER_WINDOW_MS);
    const o2 = await openFromLeftMenu(S2);
    // Stability is relative to the last RENDERED order — let the S2 open land
    // on screen (as it would between two real clicks) before opening S1.
    await waitFor(() => expect(fixtureOrder(rendered)[0]).toBe(S2), { timeout: 5000 });
    const o1 = await openFromLeftMenu(S1);
    openedTabs.push(o2.tab, o1.tab);

    // Precondition, not behavior: the two real activate stamps must have
    // landed inside the window, or the scenario didn't happen as designed.
    const stampOf = (id: string) => Number(AgenticProcess.getByIdFromCache<AgenticProcess>(id)?.last_active_at ?? NaN);
    await waitFor(
      () => {
        const delta = Math.abs(stampOf(o1.p.id) - stampOf(o2.p.id));
        expect(Number.isFinite(delta)).toBe(true); // both stamps arrived
        expect(delta).toBeLessThan(STABILITY_MS);
      },
      { timeout: 3000 },
    );

    // Last-open recency with the stability window applied on the mounted list.
    // Transcript order would be [S1, S2, S3].
    await waitFor(() => expect(fixtureOrder(rendered)).toEqual([S2, S1, S3]), { timeout: 5000 });
    rendered.unmount();
  });

  it('close two: entries survive and the order does not change', async () => {
    // Depends on the opens above (tabs in `openedTabs`). Closing is not an
    // activity signal: on the mounted list it must neither drop the entries
    // nor reorder them.
    expect(openedTabs.length).toBeGreaterThanOrEqual(2);
    const rendered = renderChatHistory();
    await settled(rendered);
    const before = fixtureOrder(rendered);
    expect(before).toHaveLength(3);

    for (const tab of openedTabs.splice(1)) {
      await Tab.closeById(tab.id);
    }
    await rendered.result.current.refetch();
    expect(fixtureOrder(rendered)).toEqual(before);
    rendered.unmount();
  });
});
