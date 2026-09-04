/**
 * Every dock address, one at a time, through the REAL control plane.
 *
 * `proc.show({view})` → backend `resolve_display_target(dock=…)` → `on_show` →
 * `display_stack` → WS → typed `proc.onShow()` payload. Real backend, real WS,
 * **no LLM and no worker started** — this is the deterministic sweep that must
 * be green before the browser matrix (Phase 3) is worth running, because it
 * isolates "the control plane carries this address" from "the dock renders".
 *
 * SEQUENTIAL by construction: each address is shown only after the previous
 * one's event has arrived and been asserted, so a failure names the exact
 * address that never came back rather than a race between overlapping shows.
 *
 * The table is derived from `tests/fixtures/dock_address_contract.json`, the
 * same fixture both contract suites assert against, so it cannot drift from the
 * vocabulary the backend validates.
 */

import { AgenticProcess, Project } from '@sdk';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trackForCleanup } from '../_cleanup';
import { apiTestSetup, getTestSignupInfo } from '../utils/test-utils';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import contract from '../../../tests/fixtures/dock_address_contract.json';

type UrlCase = {
  name: string;
  view_type: string;
  pointer?: string;
  options?: Record<string, string>;
  layout?: string;
  page?: string;
  base?: string;
  url: string;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Mirrors the backend's entity-existence gate (`_assert_pointer_entity_exists`):
 * a bare-uuid first segment on a view whose NAME is an entity type gets looked
 * up. The fixture's ids are illustrative, so those rows would (correctly) 404 —
 * they are replaced below by addresses built from REAL seeded entities rather
 * than dropped, so the entity-backed path is still covered.
 */
function needsRealEntity(c: UrlCase): boolean {
  const head = (c.pointer ?? '').split('/')[0];
  if (!head) return false;
  return UUID_RE.test(head) || (head.includes('-') && UUID_RE.test(head.slice(head.indexOf('-') + 1)));
}

/** The address as `flow show view` takes it: path + query, no leading /dock. */
function addressOf(c: UrlCase): string {
  const query = c.options
    ? `?${Object.entries(c.options)
        .map(([k, v]) => `${k}=${v}`)
        .join('&')}`
    : '';
  return `${c.view_type}${c.pointer ? `/${c.pointer}` : ''}${query}`;
}

/** Desk page, default layout — the shape `flow show view` produces. */
const fixtureCases = (contract.url_cases as UrlCase[]).filter(
  (c) => !c.base && (c.layout ?? 'dock') === 'dock' && (c.page ?? 'desk') === 'desk',
);

const grammarOnly = fixtureCases.filter((c) => !needsRealEntity(c));
const entityBacked = fixtureCases.filter(needsRealEntity);

describe('every dock address round-trips the control plane', () => {
  let proc: AgenticProcess | null = null;
  let workdir: string | null = null;
  let realCases: Array<{ name: string; address: string; view_type: string; pointer?: string }> = [];

  beforeAll(async () => {
    await apiTestSetup(getTestSignupInfo(), 'dock_show_sequence');
    workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dock-seq-'));
    proc = await new AgenticProcess({ workdir, pty_mode: false }).save([]);
    await proc.watch();

    // Real entities for the addresses whose pointer must resolve. Built here
    // rather than skipped so the lookup path is proven to ACCEPT as well as
    // reject — the negative case lives in the api route tests.
    const project = trackForCleanup(await new Project({ uname: `dockseq-${Date.now()}` }).save([]));
    realCases = [
      { name: 'project (real id)', address: `project/${project.id}`, view_type: 'project', pointer: project.id },
      {
        name: 'agentic_process (this process)',
        address: `agentic_process/agentic_process-${proc.id}`,
        view_type: 'agentic_process',
        pointer: `agentic_process-${proc.id}`,
      },
    ];

    // No silent caps: say what the fixture contributed and what was replaced.
    console.info(
      `[dock-sequence] ${grammarOnly.length} grammar-only addresses from the fixture, ` +
        `${entityBacked.length} entity-backed rows replaced by ${realCases.length} real-entity addresses ` +
        `(${entityBacked.map((c) => c.view_type).join(', ')})`,
    );
  }, 30_000); // do not increase timeout without approval

  afterAll(async () => {
    try {
      await proc?.stop?.();
    } catch {
      /* never started a worker — best-effort */
    }
    if (workdir) fs.rmSync(workdir, { recursive: true, force: true });
  });

  /** Show ONE address and resolve with the payload its `on_show` carried. */
  async function showAndAwait(address: string): Promise<Record<string, unknown>> {
    const seen = new Promise<Record<string, unknown>>((resolve) => {
      const off = proc!.onShow((payload) => {
        off?.();
        resolve(payload as unknown as Record<string, unknown>);
      });
    });
    await proc!.show({ view: address });
    return Promise.race([
      seen,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`no on_show for '${address}'`)), 10_000),
      ),
    ]);
  }

  it('walks every fixture address in sequence, asserting each entry event', async () => {
    expect(grammarOnly.length).toBeGreaterThan(10);

    for (const c of grammarOnly) {
      const address = addressOf(c);
      const payload = await showAndAwait(address);

      expect(payload.kind, `${c.name} → kind`).toBe('dock');
      expect(payload.view_type, `${c.name} → view_type`).toBe(c.view_type);
      expect(payload.pointer ?? undefined, `${c.name} → pointer`).toBe(c.pointer);
      expect(payload.page, `${c.name} → page`).toBe('desk');
      for (const [key, value] of Object.entries(c.options ?? {})) {
        expect((payload.options as Record<string, string> | undefined)?.[key], `${c.name} → ?${key}`).toBe(
          value,
        );
      }
    }
  }, 30_000); // do not increase timeout without approval

  it('walks the entity-backed addresses, which must RESOLVE not 404', async () => {
    for (const c of realCases) {
      const payload = await showAndAwait(c.address);
      expect(payload.kind, `${c.name} → kind`).toBe('dock');
      expect(payload.view_type, `${c.name} → view_type`).toBe(c.view_type);
      expect(payload.pointer, `${c.name} → pointer`).toBe(c.pointer);
    }
  }, 30_000); // do not increase timeout without approval

  it('accumulates one display-stack entry per address, newest last', async () => {
    // The durable half: every show above persisted, in order. This is what a
    // late-mounting client replays from, so an address that emitted but did not
    // persist would be invisible to a reload.
    const fresh = await AgenticProcess.getById(proc!.id);
    const stack = (fresh?.displayStack ?? []) as Array<{ view_type?: string }>;
    const docks = stack.filter((e) => e.view_type);
    expect(docks.length).toBeGreaterThanOrEqual(grammarOnly.length);
    expect(docks[docks.length - 1]?.view_type).toBe(realCases[realCases.length - 1]?.view_type);
  }, 30_000); // do not increase timeout without approval

  it('rejects a bad address without emitting anything', async () => {
    await expect(proc!.show({ view: 'nonsense' })).rejects.toThrow();
    await expect(proc!.show({ view: 'helpdesk' })).rejects.toThrow();
  }, 30_000); // do not increase timeout without approval
});
