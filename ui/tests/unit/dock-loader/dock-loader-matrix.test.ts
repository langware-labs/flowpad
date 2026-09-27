/**
 * Every dock view, through the REAL dispatcher (docs/navigation/dock-loading.md).
 *
 * One row per URL family: the shared grammar fixture's `url_cases`
 * (tests/fixtures/dock_address_contract.json) plus a bare row for every
 * `ViewType` the fixture has no case for. The coverage guard fails when a new
 * view type ships without a row — "every loader is tested" is enforced, not hoped.
 *
 * Per row:
 *   I1  the loader settles (a thrown non-redirect is a bug: failures render via
 *       the dock-load-error store, they don't throw out of the router);
 *   I2  at most ONE redirect, and its target settles without redirecting again;
 *   I4  a warm visit (the same URL again) makes no blocking backend request —
 *       only fire-and-forget recency stamps.
 *
 * The world: one project with a compute node, a plain shell, an agentic process
 * with its PTY shell, all cached and loaded; tabs live in an in-memory tab store.
 * Pointers naming entities the world lacks resolve like a 404 would.
 */
import contract from '../../../../tests/fixtures/dock_address_contract.json';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sdk', async (orig) => ({ ...(await orig<typeof import('@sdk')>()), initSdk: vi.fn(async () => {}) }));

import { AgenticProcess, ComputeNode, Project, Shell, tabManager } from '@sdk';
import { ViewType } from '@src/types/ViewType';
import { resetTabContentLifecycleForTests } from '@src/tabs/tab-content-lifecycle';
import { resetAgentAutoLaunchForTests } from '@src/agents/agent-auto-launch-redirect';
import {
  blockingRequests,
  fakeTabStore,
  recordRequests,
  runDockLoader,
  seedBootstrap,
  type RecordedRequest,
} from '../../utils/dock-loader-harness';

const P = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CN = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SHELL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PROC = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PROC_SHELL = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

interface Row {
  name: string;
  url: string;
}

type UrlCase = { name: string; view_type: string; url: string; layout?: string; page?: string };

const fixtureRows: Row[] = (contract.url_cases as UrlCase[])
  // Hub-page rows need the hub runtime (isHubOnly); /dev is the legacy developer layout.
  .filter((c) => c.page !== 'hub' && c.layout !== 'dev' && !c.url.startsWith('/agent/'))
  .map((c) => ({ name: `${c.view_type}: ${c.name}`, url: c.url }));

/** Our world's own entities, so pointer rows resolve something real. */
const worldRows: Row[] = [
  { name: 'shell: a plain shell', url: `/dock/shell/shell-${SHELL}` },
  {
    name: 'shell: an agentic process (scoped)',
    url: `/dock/shell/agentic_process-${PROC}?scope-mode=project&scope-activeProjectId=${P}`,
  },
  {
    name: 'project: a markdown asset opened from a terminal link (the 2026-09-27 repro)',
    url: `/dock/project/${P}/editor/markdown/vfs/compute_node-%40local/w/p/report.md`,
  },
  { name: 'project: the project page', url: `/dock/project/${P}` },
];

const coveredByRows = new Set(
  [...fixtureRows, ...worldRows].map((r) => new URL(r.url, 'http://x').pathname.split('/')[2]),
);
const retired = new Set(Object.keys(contract.retired_views ?? {}));
/** A bare `/dock/<view>` row for every view type nothing above exercises. */
const bareRows: Row[] = Object.values(ViewType)
  .filter((vt) => !coveredByRows.has(vt) && !retired.has(vt))
  .map((vt) => ({ name: `${vt}: bare`, url: `/dock/${vt}` }));

const ROWS: Row[] = [...fixtureRows, ...worldRows, ...bareRows];

function seedWorld(): void {
  seedBootstrap({ default_compute_node: { type: ComputeNode.type, id: CN } });
  new Project({ id: P, name: 'p', fs_storage_mount_path: '/w/p' } as never).markAsExpanded();
  new ComputeNode({ id: CN, name: 'local' } as never).markAsExpanded();
  new Shell({ id: SHELL, project_id: P, workdir: '/w/p' } as never).markAsExpanded();
  new Shell({ id: PROC_SHELL, project_id: P, agentic_process_id: PROC } as never).markAsExpanded();
  new AgenticProcess({
    id: PROC,
    project_id: P,
    shell_id: PROC_SHELL,
    pty_mode: true,
    visible: true,
  } as never).markAsExpanded();
}

/** The backend's answer for a project with no auto-launch agent. */
const noAgentToLaunch = (req: RecordedRequest) =>
  req.method === 'POST' && req.path === '/api/v1/agents/auto-launch'
    ? { agent_id: null, process_id: null, process_typeid: null, cancelled: [] }
    : undefined;

const show = (log: readonly RecordedRequest[]) => log.map((r) => `${r.method} ${r.path}`);

beforeEach(() => {
  seedWorld();
});

afterEach(() => {
  vi.restoreAllMocks();
  tabManager.resetForTests();
  resetTabContentLifecycleForTests();
  resetAgentAutoLaunchForTests();
});

describe('dock loader matrix — coverage', () => {
  it('has a row for every ViewType (a new view ships with its loader row)', () => {
    const rowed = new Set(ROWS.map((r) => new URL(r.url, 'http://x').pathname.split('/')[2]));
    const missing = Object.values(ViewType).filter((vt) => !rowed.has(vt) && !retired.has(vt));
    expect(missing).toEqual([]);
  });
});

describe.each(ROWS)('dock loader — $name', ({ url }) => {
  it('settles with at most one redirect, and a warm visit asks the backend for nothing', async () => {
    const log = recordRequests([fakeTabStore(), noAgentToLaunch]);

    const cold = await runDockLoader(url);
    expect(cold.outcome, `threw instead of settling: ${cold.outcome === 'error' ? String(cold.error) : ''}`).not.toBe(
      'error',
    );

    // I2 — one redirect at most, to a URL that is itself canonical.
    let target = url;
    if (cold.outcome === 'redirect') {
      target = cold.location;
      const followed = await runDockLoader(target);
      expect(
        followed,
        `redirect target ${target} redirected again (ping-pong or a multi-hop canonicalization)`,
      ).toEqual({ outcome: 'ok' });
    }

    // I4 — the same place again: everything it needs is already known.
    const before = log.length;
    const warm = await runDockLoader(target);
    expect(warm).toEqual({ outcome: 'ok' });
    expect(show(blockingRequests(log.slice(before))), 'a warm visit waited on the backend').toEqual([]);
  });
});
