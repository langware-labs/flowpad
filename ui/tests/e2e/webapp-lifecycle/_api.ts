/**
 * HTTP helpers against the instance's backend: seed a project, copy + index a fixture app,
 * read the load record (`project/<id>/load-state`), the app's processes (`app-ports`) and the
 * setup-fixer runs (`/api/v1/runs`).
 */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

export interface Seeded {
  id: string;
  root: string;
}

export interface App {
  name: string;
  typeid: string;
  dir: string;
}

export interface PortRow {
  app: string;
  process: string;
  declared: number | null;
  required: boolean;
  state: string;
  port: number | null;
  pid: number | null;
  note?: string;
}

export class Api {
  constructor(readonly base: string) {}

  get graph(): string {
    return `${this.base}/api/v1/graph`;
  }

  async json(method: string, url: string, body?: unknown): Promise<any> {
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await r.text();
    try {
      return JSON.parse(text);
    } catch {
      return { status: 'NOT_JSON', http: r.status, text: text.slice(0, 300) };
    }
  }

  async healthy(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/api/v1/graph/bootstrap`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }

  async seedProject(name: string): Promise<Seeded> {
    const created = await this.json('POST', `${this.graph}/project`, { type: 'project', name });
    const id = created?.data?.id;
    if (!id) throw new Error(`project create failed: ${JSON.stringify(created).slice(0, 200)}`);
    const row = await this.json('GET', `${this.graph}/project/${id}`);
    const root = row?.data?.fs_storage_mount_path;
    if (!root) throw new Error(`project ${id} has no folder`);
    return { id, root };
  }

  async deleteProject(id: string): Promise<void> {
    await this.json('DELETE', `${this.graph}/project/${id}`).catch(() => undefined);
  }

  /** Copy `fixtures/<fixture>` into the project as `agentic-assets/webapp/<fixture>` and index it. */
  async indexApp(project: Seeded, fixture: string): Promise<App> {
    const dir = join(project.root, 'agentic-assets', 'webapp', fixture);
    mkdirSync(join(project.root, 'agentic-assets', 'webapp'), { recursive: true });
    cpSync(join(FIXTURES, fixture), dir, {
      recursive: true,
      // Project-level assets a fixture carries (needs-service's asset_setup) go to the project, not the app.
      filter: (src) => !src.includes(`${fixture}/agentic-assets`),
    });
    const extra = join(FIXTURES, fixture, 'agentic-assets');
    try {
      cpSync(extra, join(project.root, 'agentic-assets'), { recursive: true });
    } catch {
      /* no project-level assets */
    }
    const q = new URLSearchParams({ type: 'micro_app', path: dir });
    const indexed = await this.json('POST', `${this.graph}/compute_node/@local/fs-records/index?${q}`);
    const typeid = String(indexed?.data?.typeid ?? indexed?.typeid ?? '');
    if (!/^micro_app-[0-9a-f-]{36}$/.test(typeid)) {
      throw new Error(`index ${fixture} failed: ${JSON.stringify(indexed).slice(0, 300)}`);
    }
    return { name: fixture, typeid, dir };
  }

  /** Fill a JSON field of a project-level file at seed time (needs-tenant's `inputs.webapp`). */
  patchJson(file: string, patch: (doc: any) => void): void {
    const doc = JSON.parse(readFileSync(file, 'utf8'));
    patch(doc);
    writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  }

  /** The load record for one asset — `null` when the backend holds none. */
  async loadState(projectId: string, assetTypeId: string): Promise<any> {
    const r = await this.json('GET', `${this.graph}/project/${projectId}/load-state?asset=${encodeURIComponent(assetTypeId)}`);
    return r?.data ?? null;
  }

  async appPorts(projectId: string, app?: string): Promise<PortRow[]> {
    const r = await this.json('GET', `${this.graph}/project/${projectId}/app-ports`);
    const rows: PortRow[] = r?.data?.ports ?? [];
    return app ? rows.filter((row) => row.app === app) : rows;
  }

  async pagePid(projectId: string, app: string): Promise<number | null> {
    const row = (await this.appPorts(projectId, app)).find((p) => p.process === 'page');
    return row?.pid ?? null;
  }

  /** setup-fixer runs launched in this project (any status). */
  async fixerRuns(projectId: string): Promise<any[]> {
    const q = new URLSearchParams({ project_id: projectId, agent: 'setup-fixer', limit: '100' });
    const r = await this.json('GET', `${this.base}/api/v1/runs?${q}`);
    const rows = r?.data?.runs ?? r?.data ?? r?.runs ?? [];
    return Array.isArray(rows) ? rows : [];
  }

  /** Every run in the project — the fixer is not the only agent an open can start. */
  async allRuns(projectId: string): Promise<any[]> {
    const q = new URLSearchParams({ project_id: projectId, limit: '100' });
    const r = await this.json('GET', `${this.base}/api/v1/runs?${q}`);
    const rows = r?.data?.runs ?? r?.data ?? r?.runs ?? [];
    return Array.isArray(rows) ? rows : [];
  }
}

/**
 * Sample the load record until `done` or the budget ends; returns every DISTINCT state seen,
 * in order. Characterization only — a budget here bounds the sampling, it is not an assertion.
 */
export async function sampleStates(
  read: () => Promise<any>,
  budgetMs: number,
  done: () => Promise<boolean> | boolean,
  everyMs = 250,
): Promise<string[]> {
  const seen: string[] = [];
  const end = Date.now() + budgetMs;
  while (Date.now() < end) {
    const rec = await read().catch(() => null);
    const state = rec ? String(rec.state ?? 'unknown') : 'none';
    if (seen[seen.length - 1] !== state) seen.push(state);
    if (await done()) break;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  return seen;
}
